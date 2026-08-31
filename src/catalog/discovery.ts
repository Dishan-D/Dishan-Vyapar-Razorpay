import type { CatalogItem } from "../mandates/schema.js";
import { gateReasons } from "../structuring/extraction.js";
import { normaliseAttributes, normaliseKey, valuesAgree } from "../mandates/authority.js";

/** A buyer-agent's structured query. */
export interface DiscoveryQuery {
  want: string;
  /** The buyer-agent's authorized ceiling. Ranking input, not a filter — see below. */
  max_price?: number;
  /** Category constraint from the Intent Mandate, e.g. "apparel" or "apparel.saree". */
  category?: string;
  /** Attribute requirements from the mandate — colour, material, size. */
  attributes?: Record<string, string>;
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
 * cotton *towel set* on the word "cotton" alone.
 */
const MIN_RELEVANCE = 0.5;

/**
 * Words that describe the errand rather than the goods.
 *
 * A model asked for "a pen" happily returns "school writing supplies pen", and
 * a flat coverage threshold then rejects an item literally called Pen for
 * matching only a quarter of the phrase. These carry no product meaning, so
 * they do not get a vote.
 */
const FILLER = new Set([
  "school", "office", "home", "supplies", "supply", "stuff", "items", "item",
  "thing", "things", "product", "products", "good", "goods", "set", "pack",
  "need", "want", "buy", "cheap", "best", "good", "nice", "new",
]);

/** Categories that mean "we could not tell", as opposed to naming a family. */
export const isUncategorised = (category: string): boolean =>
  category === "other" || category === "general.other" || category.trim() === "";

function terms(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/**
 * The thing being asked for, as opposed to how it is described.
 *
 * In English the head noun of a shopping phrase falls at the end — "blue cotton
 * SAREE", "silicone phone CASE", "school writing supplies PEN". Filler is
 * stripped first so "supplies" cannot masquerade as the noun.
 */
function headTerm(all: readonly string[]): string | undefined {
  const meaningful = all.filter((t) => !FILLER.has(t));
  return meaningful[meaningful.length - 1] ?? all[all.length - 1];
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
    // A category constraint can rule out a known mismatch, never an unknown.
    // "other" is what extraction writes when it could not tell, and excluding
    // on it made a shop's pens invisible to someone asking for a pen: the
    // request carried a stationery constraint the product had never been
    // labelled with. What the item is called still has to match.
    if (query.category && !isUncategorised(item.category) && !item.category.startsWith(query.category)) continue;

    // Applied here, not only at the payment gate. Refusing at the till is
    // correct but late: an agent should not spend three rounds haggling over a
    // red saree when the shopper asked for blue.
    if (query.attributes) {
      const have = normaliseAttributes(item.attributes);
      const mismatch = Object.entries(query.attributes).some(([k, want]) => {
        const mine = have[normaliseKey(k)];
        if (!mine) return false; // unstated is not a contradiction; the gate decides
        return !valuesAgree(want, mine);
      });
      if (mismatch) continue;
    }

    const hay = haystack(item);
    const matched = queryTerms.filter((t) => hay.includes(t));
    const score = queryTerms.length === 0 ? 0 : matched.length / queryTerms.length;

    // Either enough of the phrase matches, or the actual noun does. Coverage
    // alone rejected a product called "Pen" for a request phrased "school
    // writing supplies pen"; requiring the head noun alone would reject a
    // "Phone Cover" asked for as a "phone case". Both rules together accept
    // each of those and still keep towels out of a search for a saree.
    const head = headTerm(queryTerms);
    const headMatches = Boolean(head && hay.includes(head));
    if (score < MIN_RELEVANCE && !headMatches) continue;

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
