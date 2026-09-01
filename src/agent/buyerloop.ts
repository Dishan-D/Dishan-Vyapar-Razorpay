import OpenAI from "openai";
import { activeProvider, GROQ_BASE_URL, GROQ_MODEL } from "../llm/provider.js";
import { INTERACTIVE_MAX_WAIT_SECONDS, sharedGroqGovernor } from "../llm/ratelimit.js";
import { BUYER_TOOLS, type BuyerToolCall, type BuyerToolResult } from "./buyer.js";
import type { Turn } from "./converse.js";

export interface BuyerReply {
  answer: string;
  steps: BuyerToolResult[];
  proposals: NonNullable<BuyerToolResult["proposal"]>[];
  answered_by: "model" | "rules";
  note?: string;
}

const SYSTEM = `You are a shopping assistant for a marketplace of small Indian shops. You talk to the shopper and you use tools to do things for them.

You cannot know anything about the shelf, their orders or any shop without looking. Call a tool. Never answer from memory or assumption — if you have not looked it up in this conversation, you do not know it.

Answer in two or three short sentences, plainly:
- Rupees as ₹1,200.
- Never invent a product, a price, a shop or a delivery date. If a tool returned nothing, say nothing was found.
- You may only name products that a tool returned in THIS conversation. Not a similar product, not a plausible one, not one you would expect a shop like this to carry. If the shelf has no cake, there is no cake — say so and stop, do not suggest flavours.
- Quote the LISTED price. The "lowest" figure is a floor the shop might negotiate down to, not what the product costs; never present it as the price.

When search_shelf returns results, the shopper is ALREADY shown every one of
them as a list with photo, shop, price and stock, directly under your message.
So do not repeat them. Do not list names, prices, floors or stock counts. Say
how many you found and the one thing that helps them choose — the cheapest, the
best-stocked, or that they are much the same — then ask which they want. Three
sentences at most.

Bad:  "I found three options: - **Techno Bud Pro TWS Earbuds** at Dishan
      Electronics — ₹1,899 (list) / ₹1,614 (lowest), 25 in stock - ..."
Good: "Three of these under ₹5,000. The wired pair at Rafiq is the cheapest at
      ₹350; the TWS earbuds are the only wireless ones. Which would you like?"
- A tool result marked "tool_failed" is NOT an empty result. It means the lookup broke. Never turn it into a fact — do not say a list is empty, or that nothing exists, on the strength of a failure. Say you could not check, and stop.

Buying:
- start_purchase does NOT buy anything. It prepares a purchase the shopper must confirm.
- Only call it once you know BOTH what they want and the most they will pay. If either is missing, ask for the one that is missing and call no tool.
- Never guess a budget. "Cheap" is not a budget; ask.
- After calling it, say what you have prepared and that they need to confirm it.`;

/**
 * Four, not three.
 *
 * A buying question legitimately costs three lookups — search the shelf, check
 * the shop's delivery record, prepare the purchase — which left nothing for the
 * model to actually speak on, so a correct three-tool run ended with "I looked
 * that up but could not summarise it". The fourth pass is the one where it
 * talks.
 */
const MAX_STEPS = 4;

/**
 * Refuse to repeat a figure the tools never returned.
 *
 * The prompt tells the model not to invent products, and it invented one
 * anyway: asked for a "Classic Handloom Cotton Saree" it reported "₹7,499 at
 * Neeta Handlooms, in stock" — a price and a shop that exist nowhere in this
 * system. A shopper cannot tell that apart from a real result, which makes it
 * the most damaging thing the assistant can do.
 *
 * So the answer is checked against the evidence rather than trusted. Every
 * rupee figure in the reply must appear in a tool result or in what the shopper
 * themselves typed; anything else means the sentence was composed rather than
 * read, and the whole reply is replaced by one built from the real rows.
 *
 * This cannot catch every fabrication — a made-up shop name with no number
 * attached would pass. It catches the expensive kind, and it fails closed.
 */
export function ungroundedFigures(answer: string, allowed: Set<number>): number[] {
  const found = [...answer.matchAll(/₹\s?([\d,]+)/g)]
    .map((m) => Number(m[1]!.replace(/,/g, "")))
    .filter((n) => Number.isFinite(n) && n > 0);
  return [...new Set(found)].filter((n) => !allowed.has(n));
}

/** Every number the assistant is entitled to say back. */
function groundedNumbers(turns: Turn[], steps: BuyerToolResult[]): Set<number> {
  const ok = new Set<number>();
  // What the shopper said — their own budget is theirs to quote back.
  for (const t of turns) {
    if (t.role !== "user") continue;
    for (const m of t.content.matchAll(/(\d[\d,]*)/g)) {
      const n = Number(m[1]!.replace(/,/g, ""));
      if (Number.isFinite(n)) ok.add(n);
    }
  }
  // What the tools actually returned.
  const walk = (v: unknown): void => {
    if (typeof v === "number" && Number.isFinite(v)) ok.add(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  for (const s of steps) walk(s.data);
  return ok;
}

/** A reply built only from rows, for when the model's own cannot be trusted. */
function fromRowsOnly(steps: BuyerToolResult[]): string {
  const rows = steps.flatMap((s) =>
    s.tool === "search_shelf" ? ((s.data as { results?: Array<{ name: string; shop: string; price: number }> })?.results ?? []) : [],
  );
  if (rows.length === 0) return "I could not find anything on the shelf for that.";
  const cheapest = rows.reduce((a, b) => (b.price < a.price ? b : a));
  return (
    `${rows.length} on the shelf. The cheapest is ${cheapest.name} at ${cheapest.shop} ` +
    `for ₹${cheapest.price.toLocaleString("en-IN")}. They are listed below — which would you like?`
  );
}

/**
 * The buyer's agent loop.
 *
 * Deliberately the same shape as the merchant's: the model picks tools and
 * phrases the reply, the tools do all the work and return real rows. The model
 * is never the source of a price or a stock count — only the thing that decides
 * where to look.
 */
export async function converseWithTools(
  turns: Turn[],
  execute: (call: BuyerToolCall) => Promise<BuyerToolResult>,
): Promise<BuyerReply> {
  if (activeProvider() !== "groq") {
    return {
      answer: "The assistant needs a model to think with, and none is configured. You can still search the shelf and send the agent yourself.",
      steps: [],
      proposals: [],
      answered_by: "rules",
      note: "no model provider configured",
    };
  }

  const groq = new OpenAI({ apiKey: process.env.GROQ_API_KEY, baseURL: GROQ_BASE_URL });
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM },
    ...turns.map((t) => ({ role: t.role, content: t.content })),
  ];
  const steps: BuyerToolResult[] = [];

  try {
    for (let i = 0; i < MAX_STEPS; i++) {
      const res = await sharedGroqGovernor.run(
        1400,
        () =>
          groq.chat.completions
            .create({
              model: GROQ_MODEL,
              messages,
              tools: BUYER_TOOLS.map((t) => ({
                type: "function" as const,
                function: { name: t.name, description: t.description, parameters: t.parameters },
              })),
            })
            .withResponse(),
        { maxWaitSeconds: INTERACTIVE_MAX_WAIT_SECONDS },
      );

      const choice = res.choices[0]?.message;
      if (!choice) break;
      messages.push(choice);

      const calls = choice.tool_calls ?? [];
      if (calls.length === 0) {
        const said = choice.content?.trim() || "I could not work that out.";
        const stray = ungroundedFigures(said, groundedNumbers(turns, steps));
        return {
          answer: stray.length > 0 ? fromRowsOnly(steps) : said,
          steps,
          proposals: steps.map((s) => s.proposal).filter((p): p is NonNullable<typeof p> => Boolean(p)),
          answered_by: "model",
          ...(stray.length > 0
            ? { note: `replaced an answer that quoted figures no lookup returned (${stray.map((n) => "₹" + n).join(", ")})` }
            : {}),
        };
      }

      for (const call of calls) {
        if (call.type !== "function") continue;
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.function.arguments || "{}");
        } catch {
          args = {};
        }
        const result = await execute({ tool: call.function.name, args });
        steps.push(result);
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          // A failure and an empty result are different facts, and the model
          // will treat an unlabelled `{error: ...}` as "nothing found" — it
          // answered "your order list is empty" off a lookup that had actually
          // crashed. So a failure says, in words, that it is not an answer.
          content: JSON.stringify(
            result.error
              ? {
                  tool_failed: true,
                  error: result.error,
                  instruction:
                    "This lookup FAILED. It is not an empty result. Do not state or imply anything about what it would have returned. Tell the shopper you could not check, and stop.",
                }
              : result.data,
          ).slice(0, 6000),
        });
      }
    }

    // Out of steps with no closing sentence. Say that, rather than inventing one.
    return {
      answer:
        steps.length > 0
          ? "I looked that up but could not summarise it. What I found is below."
          : "I could not work that out.",
      steps,
      proposals: steps.map((s) => s.proposal).filter((p): p is NonNullable<typeof p> => Boolean(p)),
      answered_by: "model",
      note: "ran out of lookups",
    };
  } catch (err) {
    // A model that is rate limited or down must not look like a shop that has
    // nothing. Say which it was.
    return {
      answer: "I could not reach the model just now. You can still search the shelf and send the agent yourself.",
      steps,
      proposals: [],
      answered_by: "rules",
      note: err instanceof Error ? err.message : String(err),
    };
  }
}
