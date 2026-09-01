import OpenAI from "openai";
import { activeProvider, GROQ_BASE_URL, GROQ_MODEL } from "../llm/provider.js";
import { INTERACTIVE_MAX_WAIT_SECONDS, sharedGroqGovernor } from "../llm/ratelimit.js";
import { TOOLS, type ToolCall, type ToolResult } from "./tools.js";

export interface AskResult {
  question: string;
  answer: string;
  steps: ToolResult[];
  /** Anything the merchant must tap to actually happen. */
  proposals: NonNullable<ToolResult["proposal"]>[];
  answered_by: "model" | "rules";
  note?: string;
}

const SYSTEM = `You are the assistant inside a small Indian shopkeeper's dashboard. They are busy, not technical, and they are asking about their own shop.

You cannot know anything about their shop without looking. Call a tool. Never answer a question about their products, payments, orders or money from memory or assumption — if you have not looked it up in this conversation, you do not know it.

When you have what you need, answer in two or three short sentences, in plain language:
- Rupees as ₹1,200.
- No jargon: not "confidence score", "mandate", "readiness metric" — say what it means for them.
- Say the number, then what to do about it. If nothing needs doing, say so and stop.
- Never invent a figure. If a tool did not return something, say you could not find it.

Tools whose names begin with "propose_" do not change anything. They prepare an action the shopkeeper has to approve. Say what you have prepared and that they need to confirm it.`;

/** Cap the loop: three lookups is plenty for a dashboard question, and it bounds the spend. */
const MAX_STEPS = 3;

/**
 * Ask the merchant's own data a question.
 *
 * The model chooses which tools to call and phrases the answer; the tools do
 * every piece of actual work and return real rows. That division is the whole
 * design — the model is never the source of a number, only the thing that
 * decides where to look and how to say what it found.
 */
export async function ask(
  question: string,
  execute: (call: ToolCall) => Promise<ToolResult>,
): Promise<AskResult> {
  const provider = activeProvider();
  if (provider !== "groq") {
    return byRules(question, execute, provider === "none" ? "no model provider configured" : "tool use is wired for Groq");
  }

  const groq = new OpenAI({ apiKey: process.env.GROQ_API_KEY, baseURL: GROQ_BASE_URL });
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM },
    { role: "user", content: question },
  ];
  const steps: ToolResult[] = [];

  try {
    for (let i = 0; i < MAX_STEPS; i++) {
      const res = await sharedGroqGovernor.run(
        1400,
        () =>
          groq.chat.completions
            .create({
              model: GROQ_MODEL,
              messages,
              tools: TOOLS.map((t) => ({
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
          question,
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
          content: JSON.stringify(result.error ? { error: result.error } : result.data).slice(0, 6000),
        });
      }
    }

    // Out of steps with no final answer — say so rather than guess one.
    return {
      question,
      answer: steps.length > 0
        ? "I looked that up but could not summarise it. The details are below."
        : "I could not work out what to look at for that.",
      steps,
      proposals: steps.map((s) => s.proposal).filter((p): p is NonNullable<typeof p> => Boolean(p)),
      answered_by: "model",
      note: `stopped after ${MAX_STEPS} lookups`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return byRules(question, execute, `model unavailable: ${message.slice(0, 120)}`);
  }
}

/**
 * The answer when there is no model.
 *
 * Keyword routing to one tool, and the tool's own summary as the answer. Blunt,
 * but it is the same data — and it says plainly that it is the fallback rather
 * than passing itself off as the assistant.
 */
async function byRules(
  question: string,
  execute: (call: ToolCall) => Promise<ToolResult>,
  why: string,
): Promise<AskResult> {
  const q = question.toLowerCase();
  // Order matters: "how many have I delivered" is a question about the record,
  // not about the queue of things still to hand over, and the earlier version
  // answered it with the queue because "deliver" matched first.
  const tool =
    /lost|missed|walk|recover|why.*not.*(buy|sell)/.test(q) ? "get_lost_sales"
    : /ready|readiness|score/.test(q) ? "explain_readiness"
    : /(how many|total|record|history|revenue|earned).*(sale|sold|deliver)|verified|commerce history/.test(q) ? "get_commerce_history"
    : /waiting|pending|hand over|handover|to deliver|ready to/.test(q) ? "get_orders"
    : /product|catalog|item|stock|price/.test(q) ? "list_products"
    : /order/.test(q) ? "get_orders"
    : "get_alerts";

  const result = await execute({ tool, args: {} });
  return {
    question,
    answer: result.error ? `I could not look that up: ${result.error}` : result.summary,
    steps: [result],
    proposals: [],
    answered_by: "rules",
    note: `answered without the model — ${why}`,
  };
}
