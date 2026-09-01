import type { CatalogItem } from "../mandates/schema.js";

/**
 * What the shop knows about one shopper, mid-conversation.
 *
 * The old buyer agent had none of this, and it showed: every turn started from
 * nothing, so "which is better", "does it come smaller" and "add that one"
 * had nothing to attach to. The model papered over the gap by guessing — which
 * is where the invented product ids and mispriced cakes came from. State is
 * the fix for a whole class of hallucination, not a convenience.
 *
 * Server-side on purpose. The cart in particular has to live here: an agent
 * that says "added to your cart" while the cart is a variable in someone
 * else's browser is describing something it did not do.
 */

export interface CartLine {
  item_id: string;
  qty: number;
  /** The price when it went in, so a later change is visible rather than silent. */
  price: number;
}

export interface ShoppingState {
  /** The last set of products shown, in the order they were numbered. */
  shown: string[];
  /** What the shopper is looking at now — the referent for "it" and "that". */
  selected: string | null;
  /** Products under explicit comparison. */
  comparing: string[];
  /** Their stated ceiling, once they give one. */
  budget: number | null;
  /** Constraints pulled from what they said, e.g. flavour, weight. */
  wants: Record<string, string>;
  cart: CartLine[];
  updated_at: string;
}

const EMPTY = (): ShoppingState => ({
  shown: [], selected: null, comparing: [], budget: null, wants: {}, cart: [], updated_at: new Date().toISOString(),
});

/**
 * Sessions, in memory, with a ceiling.
 *
 * A demo does not need durable shopper sessions, but it does need to not grow
 * without bound while one runs. Oldest out first, and a cart that matters gets
 * turned into an order long before it could be evicted.
 */
const MAX_SESSIONS = 200;
const sessions = new Map<string, ShoppingState>();

export function stateFor(sessionId: string): ShoppingState {
  let s = sessions.get(sessionId);
  if (!s) {
    s = EMPTY();
    sessions.set(sessionId, s);
    if (sessions.size > MAX_SESSIONS) {
      const oldest = sessions.keys().next().value;
      if (oldest) sessions.delete(oldest);
    }
  }
  return s;
}

export function resetState(sessionId: string): void {
  sessions.set(sessionId, EMPTY());
}

/* ── Resolving what the shopper meant ───────────────────────────────────── */

const sellable = (i: CatalogItem): boolean =>
  !i.needs_merchant_confirmation && i.stock.quantity > 0 && i.price.value > 0;

/**
 * Turn whatever the model passed into a product that exists.
 *
 * Four ways, strongest first: a position in the list just shown, an exact id,
 * an exact name, then every meaningful word of a name in any order — because
 * the model writes "the 1kg red velvet cake" for "Red Velvet Cake 1kg". A word
 * match that fits more than one product resolves to nothing rather than
 * guessing between them.
 *
 * `it`, `that`, `this` and `the same` fall back to whatever is selected, which
 * is the only reason follow-up questions work at all.
 */
export function resolveProduct(
  said: string,
  state: ShoppingState,
  catalog: readonly CatalogItem[],
): CatalogItem | null {
  const q = said.trim().toLowerCase();
  if (!q) return null;

  if (/^(it|that|this|the same|same one|that one|this one)$/.test(q)) {
    return catalog.find((i) => i.item_id === state.selected) ?? null;
  }

  if (/^\d+$/.test(q)) {
    const id = state.shown[Number(q) - 1];
    if (id) return catalog.find((i) => i.item_id === id) ?? null;
  }

  const byId = catalog.find((i) => i.item_id === said.trim());
  if (byId) return byId;

  const byName = catalog.find((i) => i.name.toLowerCase() === q);
  if (byName) return byName;

  const words = q.split(/[^a-z0-9]+/).filter((w) => w.length > 1);
  if (words.length === 0) return null;
  const hits = catalog.filter((i) => {
    const name = i.name.toLowerCase();
    return words.every((w) => name.includes(w));
  });
  if (hits.length === 1) return hits[0]!;

  // Try it the other way: every word of the product's name present in what was
  // said. Catches "the 1kg red velvet cake" against "Red Velvet Cake 1kg".
  const loose = catalog.filter((i) =>
    i.name
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 1)
      .every((t) => q.includes(t)),
  );
  return loose.length === 1 ? loose[0]! : null;
}

/* ── Ranking ────────────────────────────────────────────────────────────── */

export interface Ranked {
  item: CatalogItem;
  score: number;
  /** Why it is here, in the shopper's terms. Never a number on its own. */
  reasons: string[];
}

/**
 * Order products by how well they answer what was actually asked.
 *
 * Deliberately not "most expensive first" and not "best margin first". The
 * merchant's margin is in the catalog and is not consulted here at all: a
 * shopper's agent that quietly sorts by what the shop earns is not the
 * shopper's agent. Every signal below is something the buyer would recognise
 * as a reason if it were read back to them, which is the test for whether it
 * belongs.
 */
export function rank(
  items: readonly CatalogItem[],
  opts: { budget?: number | null; wants?: Record<string, string>; terms?: string[] },
): Ranked[] {
  const budget = opts.budget ?? null;
  const wants = opts.wants ?? {};
  const terms = (opts.terms ?? []).map((t) => t.toLowerCase()).filter((t) => t.length > 2);

  return items
    .filter(sellable)
    .map((item) => {
      const reasons: string[] = [];
      let score = 0;

      if (budget !== null) {
        if (item.price.value <= budget) {
          score += 40;
          reasons.push(`within your ₹${budget.toLocaleString("en-IN")} budget`);
        } else {
          score -= 60; // over budget is not a near miss, it is a different answer
        }
      }

      const attrs = item.attributes ?? {};
      for (const [k, v] of Object.entries(wants)) {
        const have = String(attrs[k] ?? "").toLowerCase();
        if (have && have.includes(v.toLowerCase())) {
          score += 25;
          reasons.push(`${k} is ${attrs[k]}`);
        }
      }

      const hay = `${item.name} ${item.category} ${Object.values(attrs).join(" ")} ${(item as CatalogItem & { tags?: string[] }).tags?.join(" ") ?? ""}`.toLowerCase();
      const matched = terms.filter((t) => hay.includes(t));
      score += matched.length * 12;

      // A shop with one left can still sell it, but it is a worse suggestion
      // than the same thing with ten, and the shopper can see why.
      if (item.stock.quantity >= 5) score += 6;
      else if (item.stock.quantity <= 1) reasons.push("only one left");

      return { item, score, reasons };
    })
    .sort((a, b) => b.score - a.score || a.item.price.value - b.item.price.value);
}

/* ── Relationships ──────────────────────────────────────────────────────── */

type Related = CatalogItem & { tags?: string[]; complements?: string[]; substitutes?: string[] };

/** Things that go with it — the merchant's own list first, shared tags after. */
export function complementsOf(anchor: CatalogItem, catalog: readonly CatalogItem[]): CatalogItem[] {
  const declared = new Set((anchor as Related).complements ?? []);
  const anchorTags = new Set((anchor as Related).tags ?? []);
  return catalog
    .filter((i) => i.item_id !== anchor.item_id && sellable(i))
    .map((i) => {
      const shared = ((i as Related).tags ?? []).filter((t) => anchorTags.has(t));
      return { i, declared: declared.has(i.item_id), shared: shared.length };
    })
    .filter((c) => c.declared || c.shared >= 2)
    .sort((a, b) => Number(b.declared) - Number(a.declared) || b.shared - a.shared)
    .map((c) => c.i);
}

/**
 * Other things that do the same job — for "too expensive, what else?"
 *
 * Category alone is too coarse here: every edible thing in this catalog is
 * food.snack, so falling back to it offered Coffee Powder as an alternative to
 * a chocolate cake. Nobody shopping for a cake wants coffee grounds instead.
 * A real alternative shares what the thing is *for* — the merchant's own
 * substitutes list, or two tags in common — and category is only a tiebreak
 * on top of that.
 */
export function alternativesTo(anchor: CatalogItem, catalog: readonly CatalogItem[]): CatalogItem[] {
  const declared = new Set((anchor as Related).substitutes ?? []);
  const anchorTags = new Set((anchor as Related).tags ?? []);

  return catalog
    .filter((i) => i.item_id !== anchor.item_id && sellable(i))
    .map((i) => {
      const shared = ((i as Related).tags ?? []).filter((t) => anchorTags.has(t)).length;
      return { i, declared: declared.has(i.item_id), shared };
    })
    .filter((c) => c.declared || (c.shared >= 2 && c.i.category === anchor.category))
    .sort(
      (a, b) =>
        Number(b.declared) - Number(a.declared) ||
        b.shared - a.shared ||
        Math.abs(a.i.price.value - anchor.price.value) - Math.abs(b.i.price.value - anchor.price.value),
    )
    .map((c) => c.i);
}

/**
 * Sizes of the same thing.
 *
 * This catalog has no variant table; it has products whose names differ only
 * by a size — "Chocolate Cake 500g" and "Chocolate Cake 1kg". That is what a
 * variant is here, and treating it as one lets "do you have a bigger one"
 * work without inventing a schema the merchant never filled in.
 */
export function variantsOf(anchor: CatalogItem, catalog: readonly CatalogItem[]): CatalogItem[] {
  const base = (n: string) => n.toLowerCase().replace(/\b\d+\s*(g|kg|ml|l|pcs|pieces)\b/g, "").replace(/\s+/g, " ").trim();
  const mine = base(anchor.name);
  return catalog
    .filter((i) => i.item_id !== anchor.item_id && base(i.name) === mine && i.merchant_id === anchor.merchant_id)
    .sort((a, b) => a.price.value - b.price.value);
}
