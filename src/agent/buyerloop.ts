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
        return {
          answer: choice.content?.trim() || "I could not work that out.",
          steps,
          proposals: steps.map((s) => s.proposal).filter((p): p is NonNullable<typeof p> => Boolean(p)),
          answered_by: "model",
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
