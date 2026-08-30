import type { CatalogItem } from "../mandates/schema.js";
import { gateReasons } from "../structuring/extraction.js";

/** A buyer-agent's structured query. */
export interface DiscoveryQuery {
  want: string;
  /** The buyer-agent's authorized ceiling. Ranking input, not a filter — see below. */
  max_price?: number;
  /** Category constraint from the Intent Mandate, e.g. "apparel" or "apparel.saree". */
  category?: string;
}

export interface DiscoveryMatch {
  item: CatalogItem;
  score: number;
  matched_terms: string[];
  /** Listed above the buyer's ceiling — still offered, because that is what haggling is for. */
  above_ceiling: boolean;
}

export interface DiscoveryResult {
  matches: DiscoveryMatch[];
  /** Items that matched but cannot be offered at all, and why. */
  withheld: Array<{ item: CatalogItem; reason: string }>;
}

const STOPWORDS = new Set(["a", "an", "the", "under", "for", "with", "in", "of", "and", "me", "some"]);

/**
 * How much of the query an item must account for before it is offered.
 *
 * Without this, one incidental term is enough: "blue cotton saree" matched a
 * cotton *towel set* on the word "cotton" alone, and the buyer-agent was
 * cheerfully offered towels. A shopper who names three things means all three.
 */
const MIN_RELEVANCE = 0.5;

function terms(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

function haystack(item: CatalogItem): string {
  return [item.name, item.category.replace(/\./g, " "), ...Object.values(item.attributes)]
    .join(" ")
    .toLowerCase();
}

/**
 * Stage 2 — deterministic filtered search. No LLM here on purpose: a buyer-agent
 * asking "what do you have" deserves an answer it can check, and a filter is
 * auditable in a way an opaque embedding match is not.
 *
 * Two rules worth stating, because both were got wrong first:
 *
 * Items awaiting merchant confirmation are withheld rather than ranked low. An
 * unconfirmed price is not a worse match — it is not an offer at all.
 *
 * The buyer's price ceiling does NOT exclude anything. In a fixed-price catalog
 * it would; here the list price is an opening ask, and an item listed above the
 * ceiling is precisely the case negotiation exists to resolve. Excluding it
 * would also make a genuine no-deal unreachable — the ceiling would always sit
 * above the floor by construction — which is the tell that the filter was wrong.
 * Such items are returned, flagged, and ranked below the ones already in budget.
 *
 * The Intent Mandate's category constraint IS applied here, not left to the
 * payment gate. Refusing at the till is correct but late: the buyer should never
 * have been walked through a negotiation for something outside its mandate.
 */
export function discover(catalog: readonly CatalogItem[], query: DiscoveryQuery): DiscoveryResult {
  const queryTerms = terms(query.want);
  const matches: DiscoveryMatch[] = [];
  const withheld: DiscoveryResult["withheld"] = [];

  for (const item of catalog) {
    if (query.category && !item.category.startsWith(query.category)) continue;

    const hay = haystack(item);
    const matched = queryTerms.filter((t) => hay.includes(t));
    const score = queryTerms.length === 0 ? 0 : matched.length / queryTerms.length;
    if (score < MIN_RELEVANCE) continue;

    const gate = gateReasons(item);
    if (item.needs_merchant_confirmation || gate.length > 0) {
      withheld.push({
        item,
        reason: gate.length > 0 ? gate.join("; ") : "flagged for merchant confirmation",
      });
      continue;
    }
    if (item.stock.quantity < 1) {
      withheld.push({ item, reason: "out of stock" });
      continue;
    }

    matches.push({
      item,
      score,
      matched_terms: matched,
      above_ceiling: query.max_price !== undefined && item.price.value > query.max_price,
    });
  }

  matches.sort(
    (a, b) =>
      Number(a.above_ceiling) - Number(b.above_ceiling) ||
      b.score - a.score ||
      a.item.price.value - b.item.price.value,
  );
  return { matches, withheld };
}
