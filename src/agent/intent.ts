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

export const IntentSchema = z.object({
  want: z.string().describe("The product, as search terms. No price words."),
  max_price: z.number().describe("Rupee ceiling the shopper implied, or a sensible default"),
  opening_offer: z.number().describe("A realistic first offer, below the ceiling"),
  reasoning: z.string().describe("One line: how the ceiling was read from what they said"),
});

export type ShoppingIntent = z.infer<typeof IntentSchema>;

const SYSTEM = `You turn a shopper's plain sentence into a buying mandate for an agent that will go and haggle on their behalf.

Rules:
- "want" is search terms only — the product and its attributes. Never include price words.
- "max_price" is the hard ceiling in rupees. If they named one, use exactly that. If they didn't, infer something sensible for the item and say so in reasoning.
- "opening_offer" is where the agent starts bargaining: below the ceiling, not insultingly low. Roughly 65-75% of the ceiling is normal in an Indian shop.
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
): Promise<{ intent: ShoppingIntent; parsedBy: "groq" | "claude" | "rules"; fallbackReason?: string }> {
  const provider = activeProvider();

  if (provider === "none") {
    return { intent: parseIntentByRules(text), parsedBy: "rules", fallbackReason: "no model provider configured" };
  }

  try {
    if (provider === "groq") {
      const groq = new OpenAI({ apiKey: process.env.GROQ_API_KEY, baseURL: GROQ_BASE_URL });
      const res = await groq.chat.completions.create({
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
      });
      const raw = res.choices[0]?.message?.content;
      if (raw) return { intent: IntentSchema.parse(JSON.parse(raw)), parsedBy: "groq" };
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
      if (res.parsed_output) return { intent: res.parsed_output, parsedBy: "claude" };
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

  return {
    want: want || text.trim(),
    max_price: max,
    opening_offer: Math.max(1, Math.round(max * 0.7)),
    reasoning:
      numbers.length > 0
        ? `read ₹${max} as the ceiling from the sentence; opening at 70% of it`
        : `no budget named, so assumed ₹${max}; opening at 70% of it`,
  };
}
