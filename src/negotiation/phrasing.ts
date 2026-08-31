import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { CatalogItem } from "../mandates/schema.js";
import {
  activeProvider,
  CLAUDE_MODEL,
  GROQ_BASE_URL,
  GROQ_MODEL,
  strictJsonSchema,
} from "../llm/provider.js";
import { INTERACTIVE_MAX_WAIT_SECONDS, sharedGroqGovernor } from "../llm/ratelimit.js";
import type { NegotiationTurn } from "./engine.js";

/**
 * Natural-language phrasing for negotiation turns.
 *
 * This is the only place an LLM touches Stage 3, and it is downstream of every
 * number. The engine has already decided the amounts; the model is handed them
 * and asked to say them like a shopkeeper would. If a phrasing comes back
 * without the exact rupee figure it was given, it is discarded for the template
 * — a message that misstates the price is worse than a blunt one.
 */

const PhrasingSchema = z.object({
  lines: z.array(
    z.object({
      index: z.number().int(),
      text: z.string().describe("One short line of Hinglish shop-floor dialogue, under 15 words"),
    }),
  ),
});

/** Deterministic phrasing. Always correct, never charming. */
export function templateLine(turn: NegotiationTurn): string {
  const amount = turn.amount === null ? null : `₹${turn.amount}`;
  switch (turn.action) {
    case "offer":
      return turn.round === 1 ? `Buyer opens at ${amount}.` : `Buyer raises to ${amount}.`;
    case "counter":
      return `Merchant counters at ${amount}.`;
    case "accept":
      return `Merchant accepts ${amount}.`;
    case "withdraw":
      return `Buyer withdraws at ${amount} — beyond its authorization.`;
    case "no_deal":
      return `Merchant closes the negotiation — no deal.`;
  }
}

function containsAmount(text: string, amount: number | null): boolean {
  if (amount === null) return true;
  const digits = String(amount);
  const withSeparators = amount.toLocaleString("en-IN");
  return text.includes(digits) || text.includes(withSeparators);
}

/**
 * Phrase a whole negotiation log in one call. Falls back to templates per line
 * — not per log — so a single bad line does not discard the rest.
 */
const PHRASING_SYSTEM =
  "You write the dialogue for a haggle over one item in an Indian shop — the kind that happens twenty times a day over a counter. " +
  "The prices are already decided; you are not negotiating, you are voicing what was decided. " +
  "Use the exact rupee figure given for each turn, never a different one, never a rounded one. " +
  "Natural Hinglish, one short line per turn, no stage directions, no emoji.";

function phrasingUser(item: CatalogItem, turns: readonly NegotiationTurn[]): string {
  const numbered = turns.map((t, i) => ({ index: i, who: t.actor, doing: t.action, amount: t.amount }));
  return (
    `Item: ${item.name} (list ₹${item.price.value})\n\n` +
    `Turns:\n${JSON.stringify(numbered, null, 2)}\n\n` +
    `Write one line per turn, keyed by index.`
  );
}

async function phraseWithClaude(
  item: CatalogItem,
  turns: readonly NegotiationTurn[],
  client?: Anthropic,
): Promise<Array<{ index: number; text: string }> | null> {
  const anthropic = client ?? new Anthropic();
  const response = await anthropic.messages.parse({
    model: CLAUDE_MODEL,
    max_tokens: 4000,
    system: PHRASING_SYSTEM,
    messages: [{ role: "user", content: phrasingUser(item, turns) }],
    output_config: { format: zodOutputFormat(PhrasingSchema) },
  });
  if (response.stop_reason === "refusal" || !response.parsed_output) return null;
  return response.parsed_output.lines;
}

async function phraseWithGroq(
  item: CatalogItem,
  turns: readonly NegotiationTurn[],
): Promise<Array<{ index: number; text: string }> | null> {
  const groq = new OpenAI({ apiKey: process.env.GROQ_API_KEY, baseURL: GROQ_BASE_URL });
  // Phrasing is cosmetic; it never waits out a rate limit. The templates are
  // instant and always correct about the numbers.
  const response = await sharedGroqGovernor.run(
    900,
    () =>
      groq.chat.completions
        .create({
          model: GROQ_MODEL,
          messages: [
            { role: "system", content: PHRASING_SYSTEM },
            { role: "user", content: phrasingUser(item, turns) },
          ],
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "negotiation_phrasing",
              strict: true,
              schema: strictJsonSchema(z.toJSONSchema(PhrasingSchema) as Record<string, unknown>),
            },
          },
        })
        .withResponse(),
    { maxWaitSeconds: INTERACTIVE_MAX_WAIT_SECONDS },
  );
  const text = response.choices[0]?.message?.content;
  if (!text) return null;
  return PhrasingSchema.parse(JSON.parse(text)).lines;
}

export async function phraseTurns(
  item: CatalogItem,
  turns: readonly NegotiationTurn[],
  client?: Anthropic,
): Promise<string[]> {
  const provider = client ? "claude" : activeProvider();
  if (provider === "none") return turns.map(templateLine);

  try {
    const lines =
      provider === "groq"
        ? await phraseWithGroq(item, turns)
        : await phraseWithClaude(item, turns, client);
    if (!lines) return turns.map(templateLine);

    const byIndex = new Map(lines.map((l) => [l.index, l.text]));
    return turns.map((turn, i) => {
      const line = byIndex.get(i);
      // The guard: phrasing that lost or changed the number is not usable.
      return line && containsAmount(line, turn.amount) ? line : templateLine(turn);
    });
  } catch {
    // Phrasing is cosmetic. A model or network failure must not fail a negotiation.
    return turns.map(templateLine);
  }
}
