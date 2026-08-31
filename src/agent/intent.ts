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

export const IntentSchema = z.object({
  want: z.string().describe("The product, as search terms. No price words."),
  max_price: z.number().describe("Rupee ceiling the shopper implied, or a sensible default"),
  opening_offer: z.number().describe("A realistic first offer, below the ceiling"),
  category: z
    .string()
    .describe("Category prefix to restrict to, e.g. apparel.saree or mobile.case. Empty string if they did not narrow it."),
  attributes: z
    .array(z.object({ key: z.string(), value: z.string() }))
    .describe("Attributes they named that the item must match — colour, material, size. Empty if none."),
  deliver_within_days: z
    .number()
    .describe("Latest acceptable handover in days: 0 today, 1 tomorrow, -1 if they did not say"),
  reasoning: z.string().describe("One line: how the ceiling and any requirements were read from what they said"),
});

export type ShoppingIntent = z.infer<typeof IntentSchema>;

/**
 * Drop any requirement the shopper did not actually say.
 *
 * A model that can add constraints can block a purchase that should have gone
 * through: asked for "a blue cotton saree, delivered today", one run came back
 * with a size requirement nobody mentioned, and the authorization then refused
 * every saree in the catalog for not stating a size.
 *
 * The model may read what someone said. It may not decide what they meant to
 * say. So every attribute has to be traceable to the text — if the value is not
 * in there, it is the model's idea and it goes.
 */
export function keepOnlyStatedAttributes(
  intent: ShoppingIntent,
  text: string,
): { intent: ShoppingIntent; dropped: Array<{ key: string; value: string }> } {
  const haystack = text.toLowerCase();
  const kept: Array<{ key: string; value: string }> = [];
  const dropped: Array<{ key: string; value: string }> = [];

  for (const attr of intent.attributes ?? []) {
    const value = String(attr.value ?? "").trim().toLowerCase();
    // A value counts as stated if any of its words appear in the sentence.
    const stated =
      value.length > 0 && value.split(/\s+/).some((word) => word.length > 2 && haystack.includes(word));
    (stated ? kept : dropped).push({ key: attr.key, value: attr.value });
  }

  // The budget is the single most consequential number the model returns, and
  // it is usually stated outright. One run read "under 1020" as a ₹1,190
  // ceiling — which would have authorized the agent to overspend by ₹170. If
  // the shopper wrote a number, that number wins.
  const stated = [...text.matchAll(/(?:₹|rs\.?\s*)?(\d[\d,]{1,7})/gi)]
    .map((m) => Number(m[1]!.replace(/,/g, "")))
    .filter((n) => n >= 10);
  let maxPrice = intent.max_price;
  if (stated.length > 0 && !stated.includes(Math.round(maxPrice))) {
    const nearest = stated.reduce((a, b) => (Math.abs(b - maxPrice) < Math.abs(a - maxPrice) ? b : a));
    dropped.push({ key: "max_price", value: `${maxPrice} → ${nearest} (as stated)` });
    maxPrice = nearest;
  }

  // Same rule for the delivery deadline. Asked only for "a white cotton kurta
  // under 800", one run came back demanding same-day handover and ruled out
  // every shop for being a day too slow — a requirement the shopper never made,
  // enforced against them.
  const mentionsTiming = /\btoday\b|\btomorrow\b|\bsame.?day\b|\bovernight\b|\bby\s+\w+day\b|\burgent\b|\bwithin\s+\d+\s+days?\b|\bthis\s+week\b/.test(
    haystack,
  );
  let deliver = intent.deliver_within_days;
  if (!mentionsTiming && deliver >= 0) {
    dropped.push({ key: "deliver_within_days", value: String(deliver) });
    deliver = -1;
  }

  return {
    intent: { ...intent, attributes: kept, deliver_within_days: deliver, max_price: maxPrice },
    dropped,
  };
}

const SYSTEM = `You turn a shopper's plain sentence into a buying mandate for an agent that will go and haggle on their behalf.

Everything you return is a LIMIT the agent may not exceed, not an instruction. Be careful: anything you leave out, the agent is free to ignore, and anything you invent, the agent will be blocked by.

Rules:
- "want" is search terms only — the product and its attributes. Never include price words.
- "max_price" is the hard ceiling in rupees. If they named one, use exactly that. If they didn't, infer something sensible for the item and say so in reasoning.
- "opening_offer" is where the agent starts bargaining: below the ceiling, not insultingly low. Roughly 65-75% of the ceiling is normal in an Indian shop.
- "category" restricts what counts as a match. Use a prefix from: apparel.saree, apparel.kurta, apparel.dupatta, apparel.other, home.bedsheet, home.towel, home.other, mobile.case, mobile.charger, mobile.audio, mobile.screenguard, mobile.other, food.snack. Use "apparel" or "mobile" alone if they were vague about which. Empty string if they gave no hint at all.
- "attributes" are requirements they stated — colour, material, size. Only what they actually said. Do not add a colour they never mentioned; the purchase will be blocked for not matching it.
- "deliver_within_days": 0 for today, 1 for tomorrow, 2+ for a named window, -1 if they said nothing about timing.
- Rupees only. Numbers, not strings.`;

/**
 * Language in, mandate out.
 *
 * This is the one place in the buying path where a model is genuinely the right
 * tool: turning "need a phone cover, nothing over 300" into structured limits is
 * a language problem. Everything the mandate is then *used* for — what gets
 * offered, what gets accepted, what gets paid — is deterministic. The model sets
 * the shopper's ceiling; it never spends against it.
 */
export async function parseIntent(
  text: string,
): Promise<{
  intent: ShoppingIntent;
  parsedBy: "groq" | "claude" | "rules";
  fallbackReason?: string;
  /** Requirements the model invented and this discarded. */
  droppedAttributes?: string[];
}> {
  const provider = activeProvider();

  if (provider === "none") {
    return { intent: parseIntentByRules(text), parsedBy: "rules", fallbackReason: "no model provider configured" };
  }

  try {
    if (provider === "groq") {
      const groq = new OpenAI({ apiKey: process.env.GROQ_API_KEY, baseURL: GROQ_BASE_URL });
      // Capped wait: this runs while someone is watching. If the minute's
      // budget is gone, the rule-based parser answers now and says so, which is
      // better than a demo that freezes for a minute.
      const res = await sharedGroqGovernor.run(
        900,
        () =>
          groq.chat.completions
            .create({
              model: GROQ_MODEL,
              messages: [
                { role: "system", content: SYSTEM },
                { role: "user", content: text },
              ],
              response_format: {
                type: "json_schema",
                json_schema: {
                  name: "shopping_intent",
                  strict: true,
                  schema: strictJsonSchema(z.toJSONSchema(IntentSchema) as Record<string, unknown>),
                },
              },
            })
            .withResponse(),
        { maxWaitSeconds: INTERACTIVE_MAX_WAIT_SECONDS },
      );
      const raw = res.choices[0]?.message?.content;
      if (raw) {
        const parsed = IntentSchema.parse(JSON.parse(raw));
        const { intent, dropped } = keepOnlyStatedAttributes(parsed, text);
        return {
          intent,
          parsedBy: "groq",
          ...(dropped.length > 0
            ? { droppedAttributes: dropped.map((d) => `${d.key}=${d.value}`) }
            : {}),
        };
      }
    }

    if (provider === "claude") {
      const anthropic = new Anthropic();
      const res = await anthropic.messages.parse({
        model: CLAUDE_MODEL,
        max_tokens: 2000,
        system: SYSTEM,
        messages: [{ role: "user", content: text }],
        output_config: { format: zodOutputFormat(IntentSchema) },
      });
      if (res.parsed_output) {
        const { intent, dropped } = keepOnlyStatedAttributes(res.parsed_output, text);
        return {
          intent,
          parsedBy: "claude",
          ...(dropped.length > 0 ? { droppedAttributes: dropped.map((d) => `${d.key}=${d.value}`) } : {}),
        };
      }
    }
    return {
      intent: parseIntentByRules(text),
      parsedBy: "rules",
      fallbackReason: `${provider} returned nothing parseable`,
    };
  } catch (err) {
    // Never swallow this. A silent fallback here looks exactly like the model
    // "deciding" to be deterministic, and the actual cause — a 404 from an
    // empty model name — surfaced three layers away as "the agent stopped
    // using the model".
    const message = err instanceof Error ? err.message : String(err);
    return {
      intent: parseIntentByRules(text),
      parsedBy: "rules",
      fallbackReason: `${provider} call failed: ${message.slice(0, 160)}`,
    };
  }
}

/**
 * The fallback, and the reason the agent works with no API key at all.
 * Pulls the largest rupee figure out of the sentence and strips the price
 * clause from the search terms.
 */
const COLOURS = ["blue", "red", "black", "white", "green", "maroon", "pink", "yellow", "orange", "grey", "gray", "brown", "purple"];
const MATERIALS = ["cotton", "silk", "linen", "wool", "silicone", "leather", "steel", "glass"];

export function parseIntentByRules(text: string): ShoppingIntent {
  const numbers = [...text.matchAll(/(?:₹|rs\.?\s*)?(\d[\d,]{1,7})/gi)]
    .map((m) => Number(m[1]!.replace(/,/g, "")))
    .filter((n) => n >= 10);

  const max = numbers.length > 0 ? Math.max(...numbers) : 1000;

  const want = text
    .replace(/(?:under|below|less than|max|maximum|upto|up to|within|no more than|nothing over)\s*(?:₹|rs\.?\s*)?\d[\d,]*/gi, "")
    .replace(/(?:₹|rs\.?\s*)\d[\d,]*/gi, "")
    .replace(/\b(?:i|need|want|looking for|find me|get me|buy|a|an|the|some|please|for)\b/gi, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  const lower = text.toLowerCase();
  const attributes: Array<{ key: string; value: string }> = [];
  const colour = COLOURS.find((c) => new RegExp(`\\b${c}\\b`).test(lower));
  if (colour) attributes.push({ key: "color", value: colour });
  const material = MATERIALS.find((m) => new RegExp(`\\b${m}\\b`).test(lower));
  if (material) attributes.push({ key: "material", value: material });

  const deliver = /\btoday\b|\bsame day\b/.test(lower)
    ? 0
    : /\btomorrow\b/.test(lower)
      ? 1
      : -1;

  return {
    want: want || text.trim(),
    max_price: max,
    opening_offer: Math.max(1, Math.round(max * 0.7)),
    category: "",
    attributes,
    deliver_within_days: deliver,
    reasoning:
      (numbers.length > 0
        ? `read ₹${max} as the ceiling from the sentence`
        : `no budget named, so assumed ₹${max}`) +
      (attributes.length > 0 ? `; requires ${attributes.map((a) => a.value).join(", ")}` : "") +
      (deliver >= 0 ? `; needed ${deliver === 0 ? "today" : "by tomorrow"}` : ""),
  };
}
