import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { CatalogItem } from "../mandates/schema.js";
import { hasCredentials, MODEL } from "../structuring/extract.js";
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
export async function phraseTurns(
  item: CatalogItem,
  turns: readonly NegotiationTurn[],
  client?: Anthropic,
): Promise<string[]> {
  if (!hasCredentials() && !client) return turns.map(templateLine);

  const anthropic = client ?? new Anthropic();
  const numbered = turns.map((t, i) => ({
    index: i,
    who: t.actor,
    doing: t.action,
    amount: t.amount,
  }));

  try {
    const response = await anthropic.messages.parse({
      model: MODEL,
      max_tokens: 4000,
      system:
        "You write the dialogue for a haggle over one item in an Indian shop — the kind that happens twenty times a day over a counter. " +
        "The prices are already decided; you are not negotiating, you are voicing what was decided. " +
        "Use the exact rupee figure given for each turn, never a different one, never a rounded one. " +
        "Natural Hinglish, one short line per turn, no stage directions, no emoji.",
      messages: [
        {
          role: "user",
          content:
            `Item: ${item.name} (list ₹${item.price.value})\n\n` +
            `Turns:\n${JSON.stringify(numbered, null, 2)}\n\n` +
            `Write one line per turn, keyed by index.`,
        },
      ],
      output_config: { format: zodOutputFormat(PhrasingSchema) },
    });

    if (response.stop_reason === "refusal" || !response.parsed_output) {
      return turns.map(templateLine);
    }

    const byIndex = new Map(response.parsed_output.lines.map((l) => [l.index, l.text]));
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
