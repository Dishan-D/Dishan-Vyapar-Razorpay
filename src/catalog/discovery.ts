import type { CatalogItem } from "../mandates/schema.js";
import { gateReasons } from "../structuring/extraction.js";

/** A buyer-agent's structured query. */
export interface DiscoveryQuery {
  want: string;
  max_price?: number;
  category?: string;
}

export interface DiscoveryMatch {
  item: CatalogItem;
  score: number;
  matched_terms: string[];
}

export interface DiscoveryResult {
  matches: DiscoveryMatch[];
  /** Items that matched the query but are not offerable, and why. */
  withheld: Array<{ item: CatalogItem; reason: string }>;
}

const STOPWORDS = new Set(["a", "an", "the", "under", "for", "with", "in", "of", "and", "me", "some"]);

function terms(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/** Everything a term could match against, lowercased. */
function haystack(item: CatalogItem): string {
  return [item.name, item.category.replace(/\./g, " "), ...Object.values(item.attributes)]
    .join(" ")
    .toLowerCase();
}

/**
 * Stage 2 — deterministic filtered search. No LLM here on purpose: a buyer-agent
 * asking "what do you have under ₹1500" deserves an answer it can check, and a
 * filter is auditable in a way an opaque embedding match is not.
 *
 * Items still awaiting merchant confirmation are withheld rather than ranked
 * low. An unconfirmed price is not a worse match — it is not an offer at all.
 */
export function discover(catalog: readonly CatalogItem[], query: DiscoveryQuery): DiscoveryResult {
  const queryTerms = terms(query.want);
  const matches: DiscoveryMatch[] = [];
  const withheld: DiscoveryResult["withheld"] = [];

  for (const item of catalog) {
    const hay = haystack(item);
    const matched = queryTerms.filter((t) => hay.includes(t));
    if (matched.length === 0) continue;
    if (query.category && !item.category.startsWith(query.category)) continue;

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
    if (query.max_price !== undefined && item.price.value > query.max_price) {
      withheld.push({ item, reason: `list price ₹${item.price.value} is over the buyer's ₹${query.max_price} ceiling` });
      continue;
    }

    // Term coverage first, then cheaper items — nothing here depends on the model.
    const score = matched.length / queryTerms.length;
    matches.push({ item, score, matched_terms: matched });
  }

  matches.sort((a, b) => b.score - a.score || a.item.price.value - b.item.price.value);
  return { matches, withheld };
}
