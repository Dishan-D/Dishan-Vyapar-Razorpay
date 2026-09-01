import OpenAI from "openai";
import { z } from "zod";
import {
  activeProvider,
  GROQ_BASE_URL,
  GROQ_MODEL,
  strictJsonSchema,
} from "../llm/provider.js";
import { INTERACTIVE_MAX_WAIT_SECONDS, sharedGroqGovernor } from "../llm/ratelimit.js";

export interface Turn {
  role: "user" | "assistant";
  content: string;
}

const ReplySchema = z.object({
  ready: z.boolean().describe("True only if the shopper has named a product AND a rupee ceiling."),
  reply: z.string().describe("One short sentence to the shopper. A question if something is missing, else a confirmation of what you are about to go buy."),
  missing: z.array(z.string()).describe("What is still unknown: 'product' and/or 'budget'. Empty when ready."),
});

export type ChatReply = z.infer<typeof ReplySchema>;

const SYSTEM = `You are the front desk of a shopping agent for small Indian shops.

Your ONLY job is to decide whether the shopper has said enough to go shopping,
and to reply in one short sentence.

Enough means BOTH:
  - a product they want, and
  - a rupee ceiling they are willing to pay.

If either is missing, ask for exactly that one thing. Never ask for both at once.
Never ask about colour, size, delivery or brand — those are optional, and asking
for them makes the shopper do work the agent can do.

Never invent a budget. Never assume a product. Never promise a price, a shop, a
discount or a delivery date: you do not know what is in stock and you are not
the part of the system that negotiates.

Keep the reply under 20 words, plain, no emoji, no exclamation marks.`;

/** Everything the shopper themselves has typed, oldest first. */
export const shopperText = (turns: Turn[]): string =>
  turns.filter((t) => t.role === "user").map((t) => t.content.trim()).filter(Boolean).join(". ");

/**
 * Rules fallback, and the definition of "enough" the model is held to.
 *
 * A digit is the only reliable signal of a budget in free text, and a few
 * characters that are not just a price is the signal of a product. This is
 * deliberately dumber than the model: it exists so the chat still works with no
 * provider configured, and so there is a check the model's `ready` can be
 * compared against rather than believed outright.
 */
export function readinessByRules(text: string): { ready: boolean; missing: string[] } {
  const hasBudget = /\d/.test(text);
  const hasProduct = text.replace(/[^a-z\s]/gi, "").trim().length >= 3;
  const missing = [...(hasProduct ? [] : ["product"]), ...(hasBudget ? [] : ["budget"])];
  return { ready: missing.length === 0, missing };
}

/**
 * One conversational turn.
 *
 * This layer decides only whether to ask a follow-up. It never builds the
 * shopping intent itself: when it says ready, the caller runs the agent over
 * the shopper's own words, so `keepOnlyStatedAttributes` still governs what may
 * become a requirement. A chat surface that could mint constraints of its own
 * would be a way around the one rule that keeps the agent from buying something
 * nobody asked for.
 */
export async function converse(turns: Turn[]): Promise<ChatReply & { by: "groq" | "rules" }> {
  const text = shopperText(turns);
  const rules = readinessByRules(text);

  if (activeProvider() !== "groq") {
    return {
      ...rules,
      by: "rules",
      reply: rules.ready
        ? `Looking for ${text} now.`
        : rules.missing.includes("product")
          ? "What are you looking for?"
          : "What is the most you would pay?",
    };
  }

  try {
    const groq = new OpenAI({ apiKey: process.env.GROQ_API_KEY, baseURL: GROQ_BASE_URL });
    const res = await sharedGroqGovernor.run(
      700,
      () =>
        groq.chat.completions
          .create({
            model: GROQ_MODEL,
            messages: [
              { role: "system", content: SYSTEM },
              ...turns.map((t) => ({ role: t.role, content: t.content })),
            ],
            response_format: {
              type: "json_schema",
              json_schema: {
                name: "chat_reply",
                strict: true,
                schema: strictJsonSchema(z.toJSONSchema(ReplySchema) as Record<string, unknown>),
              },
            },
          })
          .withResponse(),
      { maxWaitSeconds: INTERACTIVE_MAX_WAIT_SECONDS },
    );
    const raw = res.choices[0]?.message?.content;
    if (raw) {
      const parsed = ReplySchema.parse(JSON.parse(raw));
      // The model may not declare itself ready over text that names no number.
      // Letting it would hand the agent a run with no ceiling, and the ceiling
      // is the only thing standing between a buyer and an unbounded purchase.
      const ready = parsed.ready && rules.ready;
      return {
        ready,
        missing: ready ? [] : parsed.missing.length > 0 ? parsed.missing : rules.missing,
        reply: parsed.reply,
        by: "groq",
      };
    }
  } catch {
    /* falls through to rules */
  }
  return { ...rules, by: "rules", reply: rules.ready ? `Looking for ${text} now.` : "What are you looking for, and up to how much?" };
}
