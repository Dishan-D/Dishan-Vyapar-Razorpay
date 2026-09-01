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
  /** True when the item matched the noun the shopper actually named. */
  head_match: boolean;
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
  // Words a shopper reaches for when they do not know the product's name.
  // "some device to listen to music" ends on DEVICE, which names nothing, and
  // letting it act as the head noun meant the head-noun rule could never fire.
  "device", "devices", "gadget", "gadgets", "kind", "type", "something",
  "listen", "listening", "use", "using", "wear",
]);

/**
 * Words a shopper uses for a category, as opposed to the words on the label.
 *
 * Written by hand, on purpose. Someone asking for "headphones" is shown nothing
 * by a shop stocking "Wired Earphones with 3.5mm Jack" and "Techno Bud Pro TWS
 * Earbuds", because no substring of one appears in the other — and a shopper
 * who has to guess the merchant's exact noun is back to the problem this
 * project exists to solve.
 *
 * This is a lexicon and not a model or an embedding, for the same reason
 * everything else here is arithmetic: a merchant can be shown why their product
 * matched, and a wrong entry can be deleted by anyone reading this file. An
 * embedding would match more and explain nothing.
 */
const CATEGORY_WORDS: Record<string, string[]> = {
  "mobile.audio": ["earphone", "earphones", "earbud", "earbuds", "headphone", "headphones",
                   "headset", "airpods", "buds", "tws", "speaker", "speakers", "audio",
                   "music", "sound", "mp3", "player"],
  "mobile.case": ["case", "cover", "back", "cases", "covers"],
  "mobile.charger": ["charger", "chargers", "cable", "cables", "adapter", "powerbank", "power"],
  "mobile.screenguard": ["screenguard", "screen", "guard", "protector", "tempered", "glass"],
  "electronics.laptop": ["laptop", "laptops", "notebook", "computer", "pc", "macbook"],
  "electronics.tv": ["tv", "television", "led", "monitor", "screen"],
  "electronics.appliance": ["microwave", "oven", "mixer", "grinder", "fan", "iron", "kettle",
                            "appliance", "appliances", "toaster"],
  "apparel.saree": ["saree", "sarees", "sari", "saris"],
  "apparel.kurta": ["kurta", "kurtas", "kurti", "shirt"],
  "apparel.dupatta": ["dupatta", "dupattas", "stole", "scarf"],
  "home.bedsheet": ["bedsheet", "bedsheets", "chaadar", "chadar", "bedcover", "sheet", "sheets"],
  "home.towel": ["towel", "towels"],
  "food.snack": ["snack", "snacks", "murukku", "chips", "mixture", "sweets", "laddu", "namkeen"],
  "stationery.pen": ["pen", "pens", "pencil", "pencils", "marker", "markers"],
  "stationery.paper": ["notebook", "notebooks", "paper", "register", "diary", "file"],
};

/** Does this query term name the family this item belongs to? */
function namesCategory(term: string, category: string): boolean {
  return (CATEGORY_WORDS[category] ?? []).includes(term);
}

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
 * The item's own words, as words.
 *
 * Matching used to be `haystack.includes(term)`, which is substring matching,
 * and substring matching quietly answers questions nobody asked: a search for a
 * phone CHARGER returned Wired Earphones, because "phone" is inside
 * "earphones". Every accidental match of that kind costs a shopper a scroll and
 * costs the shop credibility.
 *
 * Plurals still have to work, so a term matches its own singular or plural —
 * but as a whole word, never as a fragment of a longer one.
 */
function words(item: CatalogItem): Set<string> {
  return new Set(haystack(item).split(/[^a-z0-9]+/).filter(Boolean));
}

function hasWord(bag: Set<string>, term: string): boolean {
  if (bag.has(term)) return true;
  if (bag.has(`${term}s`)) return true;
  if (term.endsWith("s") && bag.has(term.slice(0, -1))) return true;
  // "3.5mm" and the like survive tokenising; a numeric term still matches.
  return false;
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

    const bag = words(item);
    // A term counts if it is one of the item's own words OR names the family
    // the item is filed under. The second half is what lets "headphones" find
    // "Wired Earphones" without either of them containing the other.
    const matched = queryTerms.filter((t) => hasWord(bag, t) || namesCategory(t, item.category));
    const score = queryTerms.length === 0 ? 0 : matched.length / queryTerms.length;

    // Either enough of the phrase matches, or the actual noun does. Coverage
    // alone rejected a product called "Pen" for a request phrased "school
    // writing supplies pen"; requiring the head noun alone would reject a
    // "Phone Cover" asked for as a "phone case". Both rules together accept
    // each of those and still keep towels out of a search for a saree.
    const head = headTerm(queryTerms);
    const headMatches = Boolean(head && (hasWord(bag, head) || namesCategory(head, item.category)));
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
      head_match: headMatches,
      matched_terms: matched,
      above_ceiling: query.max_price !== undefined && item.price.value > query.max_price,
    });
  }

  // The thing that was actually asked for comes first.
  //
  // Coverage alone ties too often: for "phone charger" a screen protector, a
  // phone cover and an actual charger all match one word of two and score 0.5,
  // so the charger sorted last on price and the shopper had to hunt for the one
  // product they named. Matching the head noun now outranks matching some other
  // word of the phrase.
  matches.sort(
    (a, b) =>
      Number(a.above_ceiling) - Number(b.above_ceiling) ||
      Number(b.head_match) - Number(a.head_match) ||
      b.score - a.score ||
      a.item.price.value - b.item.price.value,
  );
  return { matches, withheld };
}
