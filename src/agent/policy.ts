import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import {
  activeProvider,
  CLAUDE_MODEL,
  GROQ_BASE_URL,
  GROQ_MODEL,
  strictJsonSchema,
} from "../llm/provider.js";
import { INTERACTIVE_MAX_WAIT_SECONDS, sharedGroqGovernor } from "../llm/ratelimit.js";
import type { CatalogItem, NegotiationPolicy } from "../mandates/schema.js";

export const PolicyRequestSchema = z.object({
  item_hint: z.string().describe("The product they named, in their words. Empty if they meant everything."),
  field: z.enum(["floor_price", "list_price", "max_rounds", "unknown"]),
  value: z.number().describe("The number they gave. 0 if they gave none."),
  confidence: z.number().min(0).max(1).describe("How sure you are this is what they meant"),
});

export type PolicyRequest = z.infer<typeof PolicyRequestSchema>;

export interface ProposedChange {
  understood: string;
  item_id: string | null;
  item_name: string | null;
  field: "floor_price" | "list_price" | "max_rounds";
  from: number;
  to: number;
  /** Why this cannot be applied, when it cannot. */
  blocked: string | null;
}

const SYSTEM = `A shopkeeper is adjusting how their shop bargains, in their own words. Turn the sentence into one field change.

- "don't go below X for the blue saree" → floor_price, X
- "ask 1400 for the kurta" → list_price
- "only haggle twice" → max_rounds
- item_hint is whatever they called the product; leave it empty if they clearly meant the whole shop.
- If you cannot tell which field they mean, say unknown rather than guessing. A wrong guess here changes what their shop will sell for.`;

/** Language in, a proposal out. Never an applied change. */
export async function readPolicyRequest(text: string): Promise<{ request: PolicyRequest; by: "model" | "rules" }> {
  const provider = activeProvider();
  const schema = strictJsonSchema(z.toJSONSchema(PolicyRequestSchema) as Record<string, unknown>);

  try {
    if (provider === "groq") {
      const groq = new OpenAI({ apiKey: process.env.GROQ_API_KEY, baseURL: GROQ_BASE_URL });
      const res = await sharedGroqGovernor.run(
        700,
        () =>
          groq.chat.completions
            .create({
              model: GROQ_MODEL,
              messages: [{ role: "system", content: SYSTEM }, { role: "user", content: text }],
              response_format: { type: "json_schema", json_schema: { name: "policy_request", strict: true, schema } },
            })
            .withResponse(),
        { maxWaitSeconds: INTERACTIVE_MAX_WAIT_SECONDS },
      );
      const raw = res.choices[0]?.message?.content;
      if (raw) return { request: PolicyRequestSchema.parse(JSON.parse(raw)), by: "model" };
    }
    if (provider === "claude") {
      const res = await new Anthropic().messages.parse({
        model: CLAUDE_MODEL,
        max_tokens: 2000,
        system: SYSTEM,
        messages: [{ role: "user", content: text }],
        output_config: { format: zodOutputFormat(PolicyRequestSchema) },
      });
      if (res.parsed_output) return { request: res.parsed_output, by: "model" };
    }
  } catch {
    // fall through
  }
  return { request: readPolicyByRules(text), by: "rules" };
}

export function readPolicyByRules(text: string): PolicyRequest {
  const lower = text.toLowerCase();
  const numbers = [...lower.matchAll(/(?:₹|rs\.?\s*)?(\d[\d,]{1,7})/g)].map((m) => Number(m[1]!.replace(/,/g, "")));
  const value = numbers.length > 0 ? Math.max(...numbers) : 0;

  const field: PolicyRequest["field"] = /below|under|less than|minimum|floor|kam|niche/.test(lower)
    ? "floor_price"
    : /ask|asking|list|price it|rate/.test(lower)
      ? "list_price"
      : /round|haggle|bargain/.test(lower)
        ? "max_rounds"
        : "unknown";

  const hint = text
    .replace(/(?:₹|rs\.?\s*)?\d[\d,]*/g, " ")
    .replace(/\b(don'?t|do not|go|below|under|for|the|my|please|set|make|it|to|price|floor|minimum|ask|asking|at|only|haggle|rounds?)\b/gi, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  return { item_hint: hint, field, value, confidence: field === "unknown" ? 0.2 : 0.6 };
}

/**
 * Match the request to a real item and a real policy, and say what it would do.
 *
 * Deliberately stops short of applying anything. A model reading "don't go below
 * 1000" is doing language work; deciding that a shop will now sell at ₹1,000 is
 * a business decision, and it belongs to the shopkeeper. This returns the
 * proposal so they can see it before it is true.
 */
export function proposeChange(
  request: PolicyRequest,
  merchantId: string,
  items: readonly CatalogItem[],
  policies: ReadonlyMap<string, NegotiationPolicy>,
): ProposedChange {
  const mine = items.filter((i) => i.merchant_id === merchantId);
  const hint = request.item_hint.toLowerCase().trim();

  const terms = hint.split(/\s+/).filter((t) => t.length > 2);
  const scored = mine
    .map((item) => {
      const hay = `${item.name} ${Object.values(item.attributes).join(" ")}`.toLowerCase();
      return { item, score: terms.filter((t) => hay.includes(t)).length };
    })
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  const matched = best && best.score > 0 ? best.item : null;

  const base: ProposedChange = {
    understood: "",
    item_id: matched?.item_id ?? null,
    item_name: matched?.name ?? null,
    field: request.field === "unknown" ? "floor_price" : request.field,
    from: 0,
    to: request.value,
    blocked: null,
  };

  if (request.field === "unknown") {
    return { ...base, understood: "Not sure which setting you meant.", blocked: "Say whether that is your lowest price, your asking price, or how many rounds you will haggle." };
  }
  if (!matched) {
    return { ...base, understood: `Could not find "${request.item_hint}" in your shop.`, blocked: "Name the product as it appears in your catalog." };
  }
  const policy = policies.get(matched.item_id);
  if (!policy) {
    return { ...base, understood: `${matched.name} has no negotiation policy yet.`, blocked: "Set an asking price for it first." };
  }
  if (request.value <= 0) {
    return { ...base, from: policy[base.field], understood: "No number in that.", blocked: "Give the amount you want to set." };
  }

  const from = policy[base.field];
  const proposal: ProposedChange = { ...base, from, understood: "", blocked: null };

  if (base.field === "floor_price" && request.value >= policy.list_price) {
    return { ...proposal, understood: `A floor of ₹${request.value} on ${matched.name}.`, blocked: `That is at or above your ₹${policy.list_price} asking price — a floor above the ask leaves nothing to negotiate.` };
  }
  if (base.field === "list_price" && request.value <= policy.floor_price) {
    return { ...proposal, understood: `An asking price of ₹${request.value} on ${matched.name}.`, blocked: `That is at or below your ₹${policy.floor_price} floor.` };
  }
  if (base.field === "max_rounds" && (!Number.isInteger(request.value) || request.value < 1 || request.value > 10)) {
    return { ...proposal, understood: `${request.value} rounds on ${matched.name}.`, blocked: "Rounds must be a whole number between 1 and 10." };
  }

  const label = base.field === "floor_price" ? "lowest price" : base.field === "list_price" ? "asking price" : "haggling rounds";
  return { ...proposal, understood: `Set the ${label} on ${matched.name} to ${base.field === "max_rounds" ? request.value : `₹${request.value}`}.` };
}
