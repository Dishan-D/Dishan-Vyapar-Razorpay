import { negotiate } from "../negotiation/engine.js";
import type { CatalogItem, NegotiationPolicy } from "../mandates/schema.js";
import type { DemandEvent } from "./demand.js";

/**
 * A body of past AI-buyer demand, so the revenue screens have something real to
 * reason over on a freshly seeded database.
 *
 * Two rules kept this from becoming a lie:
 *
 * 1. **Outcomes are not written, they are played.** Each simulated buyer gets
 *    an opening offer and a ceiling, and then the *production negotiation
 *    engine* decides what happened to them. Nothing here declares a sale lost
 *    or won. So every recommendation the merchant later sees — including the
 *    price curve, which replays these same buyers — is derived from the same
 *    arithmetic that governs a live purchase. Had I written outcomes by hand,
 *    the curve would have been fitting my own fiction and would have agreed
 *    with itself no matter how wrong the engine was.
 *
 * 2. **Willingness to pay is drawn around the item's own list price**, not
 *    around a number chosen to make the shop look good. Some buyers are above
 *    list, most are below, a tail is far below. The shape is an assumption and
 *    is stated as one; what it is not is reverse-engineered from a conclusion.
 *
 * It is still generated data and every surface that uses it says so.
 */

const WANTS: Record<string, string[]> = {
  "apparel.saree": ["cotton saree", "blue saree", "saree for a wedding", "silk saree", "light saree for summer"],
  "apparel.kurta": ["cotton kurta", "white kurta", "kurta size L", "men's kurta"],
  "apparel.dupatta": ["silk dupatta", "dupatta", "maroon dupatta"],
  "home.towel": ["bath towel set", "cotton towels", "towel set"],
  "home.bedsheet": ["double bedsheet", "cotton bedsheet", "printed chaadar"],
  "mobile.case": ["phone cover", "silicone phone case", "back cover"],
  "mobile.charger": ["fast charger", "type c cable", "charger"],
  "food.snack": ["murukku", "banana chips", "adhirasam", "snacks"],
  "stationery.pen": ["blue pen", "gel pens", "pens"],
};

const fallbackWants = ["something like this", "this item"];

/** Deterministic PRNG so one shop yields one history, run after run. */
function seeded(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h ^= h << 13; h ^= h >>> 17; h ^= h << 5;
    return Math.abs(h % 1000000) / 1000000;
  };
}

/** Roughly normal, via the mean of three uniforms. Enough shape, no dependency. */
const bell = (rnd: () => number) => (rnd() + rnd() + rnd()) / 3;

/**
 * When a buyer came, weighted towards today.
 *
 * Spreading demand evenly across three weeks looked reasonable and made the
 * recovery screen useless: its window is 24 hours, so every case aged out and
 * the merchant saw ₹7,018 of "expired" and nothing to act on. Real shops are
 * not uniform either — there is always a today. About two in five buyers land
 * inside the last day, the rest spread back over the period, which leaves the
 * price curve a full history and the recovery queue something live.
 */
function when(rnd: () => number, days: number, now: number): string {
  const recent = rnd() < 0.4;
  const ago = recent ? rnd() * 20 * 3600_000 : (1 + rnd() * (days - 1)) * 86400_000;
  return new Date(now - Math.floor(ago)).toISOString();
}

export interface DatasetOptions {
  /** Buyers per sellable item. */
  perItem?: number;
  /** How far back the history runs. */
  days?: number;
}

/**
 * Build a demand history for one shop.
 *
 * Returns events only — writing them is the caller's business, so this stays
 * pure and testable, and so a caller can inspect what it is about to store.
 */
export function buildDemandHistory(
  merchantId: string,
  items: readonly CatalogItem[],
  policies: ReadonlyMap<string, NegotiationPolicy>,
  opts: DatasetOptions = {},
): DemandEvent[] {
  const perItem = opts.perItem ?? 9;
  const days = opts.days ?? 21;
  const rnd = seeded(`demand:${merchantId}`);
  const out: DemandEvent[] = [];
  const now = Date.now();

  const sellable = items.filter(
    (i) => i.merchant_id === merchantId && !i.needs_merchant_confirmation && i.price.value > 0,
  );

  for (const item of sellable) {
    const policy = policies.get(item.item_id);
    const list = item.price.value;
    const wants = WANTS[item.category] ?? fallbackWants;

    for (let n = 0; n < perItem; n++) {
      // Ceiling: centred a little under list, with a long tail of bargain
      // hunters. 0.55×–1.25× list.
      const ceiling = Math.max(10, Math.round(list * (0.55 + bell(rnd) * 0.7)));
      // Opening offer: buyers open between 60% and 90% of their own ceiling.
      const opening = Math.max(5, Math.round(ceiling * (0.6 + rnd() * 0.3)));
      const at = when(rnd, days, now);
      const want = wants[Math.floor(rnd() * wants.length)] ?? item.name;

      // No policy means the merchant never set a floor, so an agent could not
      // haggle at all. That is a real state and it is recorded as itself.
      if (!policy) {
        out.push({
          at, want, max_price: ceiling, merchant_id: merchantId, item_id: item.item_id,
          outcome: "held", asked_price: list, offered_price: null, opening_offer: opening,
          detail: "no price floor set, so nothing could be agreed",
        });
        continue;
      }

      // The engine decides. Not this function.
      const result = negotiate(item, policy, {
        buyer_agent_id: "sim_history",
        opening_offer: opening,
        max_price: ceiling,
      });
      out.push({
        at,
        want,
        max_price: ceiling,
        merchant_id: merchantId,
        item_id: item.item_id,
        outcome: result.status === "agreed" ? "sold" : "lost_on_price",
        asked_price: list,
        offered_price: result.status === "agreed" ? result.final_price : (result.log.at(-1)?.amount ?? opening),
        opening_offer: opening,
        detail: result.status === "agreed" ? null : result.reason,
      });
    }
  }

  // Buyers who came to the shop and found nothing at all. A shop is judged on
  // these too, and leaving them out would flatter the funnel.
  const misses = Math.max(2, Math.round(sellable.length * 1.5));
  for (let n = 0; n < misses; n++) {
    out.push({
      at: when(rnd, days, now),
      want: ["gift set", "steel bottle", "umbrella", "school bag", "bedsheet"][Math.floor(rnd() * 5)] ?? "something",
      max_price: Math.round(200 + rnd() * 1500),
      merchant_id: merchantId,
      item_id: null,
      outcome: "no_match",
      asked_price: null,
      offered_price: null,
      opening_offer: null,
      detail: "nothing in this shop matched",
    });
  }

  return out.sort((a, b) => (a.at < b.at ? 1 : -1));
}
