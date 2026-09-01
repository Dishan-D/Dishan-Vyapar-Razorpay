import { negotiate } from "../negotiation/engine.js";
import type { CatalogItem, NegotiationPolicy } from "../mandates/schema.js";
import type { DemandEvent } from "./demand.js";

/**
 * What a different price floor would actually have earned.
 *
 * Every pricing tool a small merchant is offered answers this with a model: a
 * learned elasticity, a "customers like you", a confident percentage. None of
 * those can be checked by the shopkeeper, and none of them are trained on the
 * eleven people who actually walked out of *this* shop last week.
 *
 * This does something duller and far more defensible. Every AI buyer who
 * bargained here left behind the two numbers that decide a haggle: what they
 * opened at, and what they would not go above. Those are stored. So for any
 * candidate floor, the outcome is not estimated — it is *replayed*, buyer by
 * buyer, through the same negotiation engine that runs in production. The same
 * function, the same rounds, the same rules.
 *
 * The result is a revenue curve the merchant can audit one buyer at a time, and
 * a recommendation that is a count of real people rather than a coefficient.
 */

export interface CurvePoint {
  floor_price: number;
  /** Buyers who would have closed at this floor. */
  buyers: number;
  /** Rupees, summed over those closes. */
  revenue: number;
  /** Mean agreed price across the closes, or null when nobody closes. */
  average_price: number | null;
  /** True for the floor the merchant has set today. */
  current: boolean;
  /** Buyers who would have agreed, before stock was taken into account. */
  would_buy: number;
  /** True when demand at this floor exceeded what the shop has on the shelf. */
  stock_limited: boolean;
}

export interface Elasticity {
  item_id: string;
  item_name: string;
  list_price: number;
  current_floor: number;
  /** Buyers replayed. Below a handful, no recommendation is offered. */
  sample: number;
  curve: CurvePoint[];
  best: CurvePoint | null;
  current: CurvePoint | null;
  /** Extra rupees at `best` versus today's floor. Never negative. */
  upside: number;
  /** Buyers who close at `best` but not today. */
  recovered_buyers: number;
  recommendation: string | null;
  /** Why no recommendation, when there is none. */
  withheld_because: string | null;
  /** Units on the shelf. The ceiling on every revenue figure above. */
  stock: number;
  /** Set when demand at the best floor outruns stock — a restocking signal. */
  stock_note: string | null;
}

/**
 * Below this many bargaining buyers, a curve is an anecdote.
 *
 * Five is not a statistically defensible sample and is not claimed to be. It is
 * the point below which a recommendation would be obviously silly — one buyer
 * who happened to lowball would otherwise "prove" the floor should drop. The
 * screen shows the count so the merchant can weigh it themselves.
 */
export const MIN_SAMPLE = 5;

/** Candidate floors, from the item's own list price down to half of it. */
function candidates(listPrice: number, currentFloor: number): number[] {
  const lo = Math.max(1, Math.round(listPrice * 0.5));
  const step = Math.max(1, Math.round(listPrice * 0.025));
  const out = new Set<number>([currentFloor]);
  for (let p = lo; p <= listPrice; p += step) out.add(Math.round(p));
  out.add(listPrice);
  return [...out].filter((p) => p > 0 && p <= listPrice).sort((a, b) => a - b);
}

/**
 * Replay one shop's lost and won buyers against a range of floors.
 *
 * `events` must be this item's own demand. A buyer who never had an opening
 * offer recorded cannot be replayed — there is no honest way to guess how they
 * would have bargained — so they are dropped from the sample rather than
 * assigned a plausible one.
 */
export function priceElasticity(
  item: CatalogItem,
  policy: NegotiationPolicy,
  events: readonly DemandEvent[],
): Elasticity {
  const buyers = events
    .filter((e) => e.item_id === item.item_id && e.opening_offer !== null && e.max_price > 0)
    .map((e) => ({ buyer_agent_id: "replay", opening_offer: e.opening_offer!, max_price: e.max_price }));

  const base: Omit<Elasticity, "curve" | "best" | "current" | "upside" | "recovered_buyers" | "recommendation" | "withheld_because" | "stock_note"> = {
    item_id: item.item_id,
    item_name: item.name,
    list_price: policy.list_price,
    current_floor: policy.floor_price,
    sample: buyers.length,
    stock: Math.max(0, item.stock.quantity),
  };

  if (buyers.length < MIN_SAMPLE) {
    return {
      ...base,
      curve: [],
      best: null,
      current: null,
      upside: 0,
      recovered_buyers: 0,
      recommendation: null,
      stock_note: null,
      withheld_because: `Only ${buyers.length} buyer${buyers.length === 1 ? "" : "s"} has bargained for this. ${MIN_SAMPLE} is the least this will offer advice on.`,
    };
  }

  // You cannot sell what you do not have.
  //
  // Without this the curve happily recommended earning ₹7,911 from nine sales
  // of a saree with one in stock. Every number in it was produced by the real
  // engine and it was still nonsense, because the engine's job is to price a
  // sale, not to know how many exist. When more buyers close than there is
  // stock, the shop serves the ones paying most — so the closes are sorted and
  // truncated, and the row says the limit was hit.
  const available = Math.max(0, item.stock.quantity);

  const curve: CurvePoint[] = candidates(policy.list_price, policy.floor_price).map((floor) => {
    const prices: number[] = [];
    for (const buyer of buyers) {
      // The real engine, not a model of it. If the engine changes, this changes
      // with it, and a curve can never promise a sale the engine would refuse.
      const out = negotiate(item, { ...policy, floor_price: floor }, buyer);
      if (out.status === "agreed") prices.push(out.final_price);
    }
    const wanted = prices.length;
    const served = prices.sort((a, b) => b - a).slice(0, available);
    const revenue = served.reduce((s, p) => s + p, 0);
    return {
      floor_price: floor,
      buyers: served.length,
      revenue,
      average_price: served.length > 0 ? Math.round(revenue / served.length) : null,
      current: floor === policy.floor_price,
      would_buy: wanted,
      stock_limited: wanted > served.length,
    };
  });

  const current = curve.find((p) => p.current) ?? null;
  // Ties go to the higher floor: same money for less discounting is strictly
  // better for the merchant, and quietly recommending a deeper cut for no gain
  // is how a tool loses a shopkeeper's trust.
  const best = curve.reduce<CurvePoint | null>(
    (acc, p) => (acc === null || p.revenue > acc.revenue || (p.revenue === acc.revenue && p.floor_price > acc.floor_price) ? p : acc),
    null,
  );

  const upside = best && current ? Math.max(0, best.revenue - current.revenue) : 0;
  const recovered = best && current ? Math.max(0, best.buyers - current.buyers) : 0;

  let recommendation: string | null = null;
  if (best && current && best.floor_price !== current.floor_price && upside > 0) {
    const dir = best.floor_price < current.floor_price ? "Lowering" : "Raising";
    recommendation =
      `${dir} your floor from ₹${current.floor_price.toLocaleString("en-IN")} to ₹${best.floor_price.toLocaleString("en-IN")} ` +
      `would have earned ₹${best.revenue.toLocaleString("en-IN")} instead of ₹${current.revenue.toLocaleString("en-IN")} ` +
      `across the ${buyers.length} buyers who actually bargained here` +
      (recovered > 0 ? `, closing ${recovered} sale${recovered === 1 ? "" : "s"} you lost.` : ".");
  }

  // Demand outrunning stock is not a pricing problem and must not be sold as
  // one. The merchant's move there is to restock, not to discount further.
  const stockNote =
    best && best.stock_limited
      ? `At ₹${best.floor_price.toLocaleString("en-IN")}, ${best.would_buy} buyers would have agreed but you had ${base.stock} in stock. The revenue above counts only what you could actually have sold — more stock, not a lower floor, is what is capping this.`
      : null;

  return {
    ...base,
    stock_note: stockNote,
    curve,
    best,
    current,
    upside,
    recovered_buyers: recovered,
    recommendation,
    withheld_because:
      recommendation === null
        ? current && best && best.floor_price === current.floor_price
          ? "Your floor is already the best of the prices tested against these buyers."
          : "No floor tested would have earned more than the one you have set."
        : null,
  };
}
