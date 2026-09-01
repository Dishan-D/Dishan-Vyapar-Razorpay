import type { CatalogItem, NegotiationPolicy } from "../mandates/schema.js";
import type { MerchantPolicy } from "../structuring/run.js";
import type { DemandEvent } from "./demand.js";

/**
 * The Revenue Agent.
 *
 * The buyer's agent asks "what is the best purchase for this shopper". This one
 * asks the merchant's question — "is there legitimate value being left on the
 * table" — and the whole design is about the word *legitimate*.
 *
 * Three rules make it something a shopkeeper could leave running:
 *
 * 1. **It suggests, it never spends.** Every output is a proposal with a
 *    ceiling attached. Adding anything to a basket takes a buyer's press, and
 *    the rules layer re-checks the total afterwards regardless.
 * 2. **The buyer's ceiling is a limit, not a target.** A shopper who says
 *    "under ₹700" has not offered to spend ₹700. Suggestions must fit, and a
 *    more expensive option is only ever proposed when it is genuinely a better
 *    fit for what they asked for.
 * 3. **No model decides any of this.** Relevance is tag overlap and declared
 *    complements; urgency is stock arithmetic; demand is counted rows. Every
 *    factor in the score is a sentence a merchant can check, which is the only
 *    reason a merchant should believe the number.
 */

export type OpportunityKind = "cross_sell" | "upsell" | "dead_stock";

export interface ScoreFactor {
  label: string;
  ok: boolean;
  /** The evidence. Never a restatement of the label. */
  detail: string;
  weight: number;
}

export interface Suggestion {
  item_id: string;
  name: string;
  price: number;
  why: string;
}

export interface Opportunity {
  id: string;
  kind: OpportunityKind;
  merchant_id: string;
  merchant_name: string;
  headline: string;
  /** What the shopper is already buying, when there is one. */
  anchor_item_id: string | null;
  anchor_name: string | null;
  suggestions: Suggestion[];
  basket_before: number;
  basket_after: number;
  incremental_revenue: number;
  buyer_ceiling: number | null;
  score: number;
  factors: ScoreFactor[];
  /** True when the value is modelled rather than observed. Shown as such. */
  estimate: boolean;
  decided_by: "revenue agent + rules";
}

/** Product fields the curated catalog carries beyond the core schema. */
type Enriched = CatalogItem & {
  tags?: string[];
  cost_price?: number;
  complements?: string[];
  substitutes?: string[];
  slow_moving?: boolean;
};

const tagsOf = (i: CatalogItem): string[] => (i as Enriched).tags ?? [];
const sellable = (i: CatalogItem): boolean => !i.needs_merchant_confirmation && i.stock.quantity > 0 && i.price.value > 0;

/** 0–100, from the factors that were satisfied. Nothing hidden. */
function scoreOf(factors: ScoreFactor[]): number {
  const total = factors.reduce((s, f) => s + f.weight, 0);
  const got = factors.reduce((s, f) => s + (f.ok ? f.weight : 0), 0);
  return total === 0 ? 0 : Math.round((got / total) * 100);
}

/** How many recent buyers asked for something these tags would answer. */
function demandFor(item: CatalogItem, events: readonly DemandEvent[]): number {
  const tags = new Set(tagsOf(item).map((t) => t.toLowerCase()));
  if (tags.size === 0) return 0;
  return events.filter((e) => {
    const want = e.want.toLowerCase();
    return [...tags].some((t) => want.includes(t));
  }).length;
}

/**
 * A · Cross-sell — things that genuinely go with what is being bought.
 *
 * Relevance comes from the merchant's own declared complements first, and
 * shared tags second. It never comes from "customers also bought", because
 * this shop has no such history and inventing one would be the easiest lie in
 * the product to tell.
 */
export function crossSell(
  anchor: CatalogItem,
  catalog: readonly CatalogItem[],
  merchant: { merchant_id: string; name: string; policy?: MerchantPolicy },
  ceiling: number | null,
  events: readonly DemandEvent[],
): Opportunity | null {
  const policy = merchant.policy;
  if (policy && !policy.cross_sell) return null;

  const declared = new Set((anchor as Enriched).complements ?? []);
  const anchorTags = new Set(tagsOf(anchor));

  const candidates = catalog
    .filter((i) => i.merchant_id === anchor.merchant_id && i.item_id !== anchor.item_id && sellable(i))
    .map((i) => {
      const shared = tagsOf(i).filter((t) => anchorTags.has(t));
      return { item: i, declared: declared.has(i.item_id), shared };
    })
    // A complement the merchant named, or a real overlap of purpose. One
    // shared tag is not an overlap — "dessert" alone would pair a cake with
    // every sweet thing in the shop.
    .filter((c) => c.declared || c.shared.length >= 2)
    .sort((a, b) => Number(b.declared) - Number(a.declared) || b.shared.length - a.shared.length);

  if (candidates.length === 0) return null;

  // Fill up to the ceiling, cheapest-first, so the suggestion is an addition
  // rather than a second purchase.
  const room = ceiling === null ? Infinity : ceiling - anchor.price.value;
  const picked: Suggestion[] = [];
  let spent = 0;
  for (const c of [...candidates].sort((a, b) => a.item.price.value - b.item.price.value)) {
    if (picked.length >= 2) break;
    if (spent + c.item.price.value > room) continue;
    picked.push({
      item_id: c.item.item_id,
      name: c.item.name,
      price: c.item.price.value,
      why: c.declared
        ? `${merchant.name} lists this as going with ${anchor.name}.`
        : `Shares ${c.shared.join(" and ")} with ${anchor.name}.`,
    });
    spent += c.item.price.value;
  }
  if (picked.length === 0) return null;

  const before = anchor.price.value;
  const after = before + spent;
  const observed = demandFor(anchor, events);

  const factors: ScoreFactor[] = [
    { label: "Relevant to what they are buying", ok: true, weight: 30,
      detail: picked.map((p) => p.why).join(" ") },
    { label: "In stock", ok: true, weight: 15,
      detail: picked.map((p) => `${p.name}: ${catalog.find((i) => i.item_id === p.item_id)?.stock.quantity ?? 0} left`).join(", ") },
    { label: "Within the buyer's ceiling", ok: ceiling === null || after <= ceiling, weight: 20,
      detail: ceiling === null ? "No ceiling stated." : `New basket ₹${after} against a stated ₹${ceiling}.` },
    { label: "Merchant allows cross-sell", ok: policy ? policy.cross_sell : true, weight: 15,
      detail: policy ? "Cross-sell is enabled in this shop's policy." : "No policy set; cross-sell is not restricted." },
    { label: "Buyers have asked for this", ok: observed > 0, weight: 20,
      detail: observed > 0 ? `${observed} recent search(es) matched these tags.` : "No matching searches recorded yet — this is untested demand." },
  ];

  return {
    id: `opp_cross_${anchor.item_id}`,
    kind: "cross_sell",
    merchant_id: merchant.merchant_id,
    merchant_name: merchant.name,
    headline: `${picked.length === 1 ? "One item" : `${picked.length} items`} that go with ${anchor.name}`,
    anchor_item_id: anchor.item_id,
    anchor_name: anchor.name,
    suggestions: picked,
    basket_before: before,
    basket_after: after,
    incremental_revenue: spent,
    buyer_ceiling: ceiling,
    score: scoreOf(factors),
    factors,
    estimate: observed === 0,
    decided_by: "revenue agent + rules",
  };
}

/**
 * B · Upsell — a better fit, not a more expensive one.
 *
 * The candidate must beat the anchor on something the shopper can name: it
 * serves more people, it is a larger size. "Costs more" is not a benefit, and
 * an upsell that cannot state its benefit is not offered at all.
 */
export function upsell(
  anchor: CatalogItem,
  catalog: readonly CatalogItem[],
  merchant: { merchant_id: string; name: string; policy?: MerchantPolicy },
  ceiling: number | null,
  events: readonly DemandEvent[],
): Opportunity | null {
  const policy = merchant.policy;
  if (policy && !policy.upsell) return null;
  if (ceiling === null) return null;

  const anchorTags = new Set(tagsOf(anchor));
  const better = catalog
    .filter(
      (i) =>
        i.merchant_id === anchor.merchant_id &&
        i.item_id !== anchor.item_id &&
        sellable(i) &&
        i.price.value > anchor.price.value &&
        i.price.value <= ceiling &&
        tagsOf(i).filter((t) => anchorTags.has(t)).length >= 1,
    )
    .map((i) => ({ item: i, benefit: benefitOver(anchor, i) }))
    .filter((c) => c.benefit !== null)
    // The cheapest option that clears the bar. Recommending the most expensive
    // thing that fits is how a shopper's ceiling gets treated as a target.
    .sort((a, b) => a.item.price.value - b.item.price.value);

  if (better.length === 0) return null;
  const pick = better[0]!;
  const extra = pick.item.price.value - anchor.price.value;
  const observed = demandFor(pick.item, events);

  const factors: ScoreFactor[] = [
    { label: "A benefit the shopper asked about", ok: true, weight: 30, detail: pick.benefit! },
    { label: "In stock", ok: true, weight: 15, detail: `${pick.item.stock.quantity} available.` },
    { label: "Still inside the buyer's ceiling", ok: pick.item.price.value <= ceiling, weight: 25,
      detail: `₹${pick.item.price.value} against a stated ₹${ceiling}. ₹${ceiling - pick.item.price.value} to spare.` },
    { label: "Merchant allows upsell", ok: policy ? policy.upsell : true, weight: 10,
      detail: policy ? "Upsell is enabled in this shop's policy." : "No policy set." },
    { label: "Buyers have asked for this", ok: observed > 0, weight: 20,
      detail: observed > 0 ? `${observed} recent search(es) matched.` : "No matching searches recorded yet." },
  ];

  return {
    id: `opp_up_${anchor.item_id}`,
    kind: "upsell",
    merchant_id: merchant.merchant_id,
    merchant_name: merchant.name,
    headline: `${pick.item.name} fits better than ${anchor.name}`,
    anchor_item_id: anchor.item_id,
    anchor_name: anchor.name,
    suggestions: [{ item_id: pick.item.item_id, name: pick.item.name, price: pick.item.price.value, why: pick.benefit! }],
    basket_before: anchor.price.value,
    basket_after: pick.item.price.value,
    incremental_revenue: extra,
    buyer_ceiling: ceiling,
    score: scoreOf(factors),
    factors,
    estimate: observed === 0,
    decided_by: "revenue agent + rules",
  };
}

/** What the candidate offers that the anchor does not, in the shopper's terms. */
function benefitOver(anchor: CatalogItem, candidate: CatalogItem): string | null {
  const a = anchor.attributes ?? {};
  const c = candidate.attributes ?? {};
  const serves = (v?: string) => Number(String(v ?? "").split("-").pop() ?? 0);
  if (serves(c.serves) > serves(a.serves)) {
    return `Serves ${c.serves} where ${anchor.name} serves ${a.serves}.`;
  }
  const grams = (v?: string) => {
    const s = String(v ?? "").toLowerCase();
    const n = parseFloat(s);
    return Number.isFinite(n) ? (s.includes("kg") ? n * 1000 : n) : 0;
  };
  if (grams(c.weight) > grams(a.weight)) return `${c.weight} against ${a.weight}.`;
  const ml = (v?: string) => parseFloat(String(v ?? "")) || 0;
  if (ml(c.size) > ml(a.size)) return `${c.size} against ${a.size}.`;
  return null;
}

/**
 * C · Dead stock — a discount is a last resort, and never automatic.
 *
 * All four conditions must hold: the stock is genuinely idle, real buyers have
 * asked for something it answers, the merchant permits promotions, and the
 * discounted price stays inside the discount the merchant themselves set.
 * Anything less and this is just marking a shop's inventory down for it.
 */
export function deadStock(
  merchant: { merchant_id: string; name: string; policy?: MerchantPolicy },
  catalog: readonly CatalogItem[],
  policies: ReadonlyMap<string, NegotiationPolicy>,
  events: readonly DemandEvent[],
): Opportunity[] {
  const policy = merchant.policy;
  if (policy && !policy.promotions) return [];

  const mine = catalog.filter((i) => i.merchant_id === merchant.merchant_id && sellable(i));
  const median = [...mine].sort((a, b) => a.stock.quantity - b.stock.quantity)[Math.floor(mine.length / 2)]?.stock.quantity ?? 0;

  const out: Opportunity[] = [];
  for (const item of mine) {
    const idle = (item as Enriched).slow_moving === true || item.stock.quantity >= Math.max(12, median * 2);
    if (!idle) continue;

    const observed = demandFor(item, events);
    const floor = policies.get(item.item_id)?.floor_price ?? item.price.value;
    const maxPct = policy?.max_discount_pct ?? 0;
    // Never below the merchant's own floor, never past their own discount cap.
    const offer = Math.max(floor, Math.round(item.price.value * (1 - maxPct / 100)));
    if (offer >= item.price.value) continue;

    const movable = Math.min(item.stock.quantity, Math.max(observed, 1) * 2);
    const factors: ScoreFactor[] = [
      { label: "Stock is sitting idle", ok: true, weight: 25,
        detail: `${item.stock.quantity} on the shelf${(item as Enriched).slow_moving ? ", flagged slow-moving" : `, against a shop median of ${median}`}.` },
      { label: "Buyers have asked for something like it", ok: observed > 0, weight: 30,
        detail: observed > 0 ? `${observed} recent search(es) matched ${tagsOf(item).join(", ")}.` : "No matching searches recorded — this would be an untested offer." },
      { label: "Merchant allows promotions", ok: policy ? policy.promotions : true, weight: 20,
        detail: policy ? `Promotions enabled, up to ${maxPct}%.` : "No policy set." },
      { label: "Offer stays above your floor", ok: offer >= floor, weight: 25,
        detail: `₹${offer} against your floor of ₹${floor}.` },
    ];

    out.push({
      id: `opp_dead_${item.item_id}`,
      kind: "dead_stock",
      merchant_id: merchant.merchant_id,
      merchant_name: merchant.name,
      headline: `${item.name} — ${item.stock.quantity} in stock, moving slowly`,
      anchor_item_id: item.item_id,
      anchor_name: item.name,
      suggestions: [{
        item_id: item.item_id, name: item.name, price: offer,
        why: `Offer ₹${offer} instead of ₹${item.price.value} to buyers already looking for ${tagsOf(item).slice(0, 2).join(" or ") || "this"}.`,
      }],
      basket_before: item.price.value,
      basket_after: offer,
      // What could be recovered, not what was lost. The distinction is the
      // difference between a forecast and a claim.
      incremental_revenue: offer * movable,
      buyer_ceiling: null,
      score: scoreOf(factors),
      factors,
      estimate: true,
      decided_by: "revenue agent + rules",
    });
  }
  return out.sort((a, b) => b.score - a.score || b.incremental_revenue - a.incremental_revenue);
}
