import type { CatalogItem, NegotiationPolicy } from "../mandates/schema.js";
import type { DemandEvent } from "./demand.js";
import { negotiate } from "../negotiation/engine.js";

export type OpportunityKind = "price_floor" | "unconfirmed_item" | "delivery_speed" | "demand_signal";

export interface Opportunity {
  id: string;
  kind: OpportunityKind;
  headline: string;
  /** The observed facts. Never a model's impression. */
  evidence: string[];
  recommendation: string;
  /** What approving it would actually change. Null when there is nothing to apply. */
  change: { item_id: string; field: "floor_price"; from: number; to: number } | null;
  lost_buyers: number;
}

const money = (n: number): string => `₹${Math.round(n).toLocaleString("en-IN")}`;

/**
 * Turn what buyers did into things a merchant can decide about.
 *
 * Every opportunity is arithmetic over recorded searches: how many agents asked,
 * how many walked, and what they were willing to pay. Nothing here is generated
 * prose — a merchant asked to give up margin should be shown the buyers, and
 * ought to be able to disagree with the count.
 *
 * Nothing is applied. Each one carries the exact change it would make, and a
 * merchant has to approve it; the system never edits a floor on their behalf.
 */
export function findOpportunities(
  merchantId: string,
  events: readonly DemandEvent[],
  items: readonly CatalogItem[],
  policies: ReadonlyMap<string, NegotiationPolicy>,
): Opportunity[] {
  const mine = items.filter((i) => i.merchant_id === merchantId);
  const out: Opportunity[] = [];

  // ── Buyers who wanted it but could not reach the floor ────────────────────
  const byItem = new Map<string, DemandEvent[]>();
  for (const e of events) {
    if (!e.item_id) continue;
    byItem.set(e.item_id, [...(byItem.get(e.item_id) ?? []), e]);
  }

  for (const [itemId, group] of byItem) {
    const item = mine.find((i) => i.item_id === itemId);
    const policy = policies.get(itemId);
    if (!item || !policy) continue;

    const lost = group.filter((e) => e.outcome === "lost_on_price");
    if (lost.length < 2) continue;

    const ceilings = lost.map((e) => e.max_price).filter((n) => n > 0);
    if (ceilings.length === 0) continue;

    // Only buyers the floor actually shut out. Someone who walked away with
    // room to spare left for another reason, and letting their ceiling set
    // `best` was enough to hide the whole opportunity behind one outlier.
    const shutOut = lost.filter((e) => e.max_price > 0 && e.max_price < policy.floor_price);
    if (shutOut.length < 2) continue;

    // Do not recommend a floor without checking it would have worked.
    //
    // The obvious candidate — the highest ceiling among the buyers who walked —
    // recovers nobody: at a floor equal to a buyer's ceiling the haggle has no
    // room to converge, and the first version of this confidently told a
    // merchant to give up ₹30 to recover five buyers who still could not have
    // bought. The engine is deterministic, so the claim is testable: replay
    // each buyer against a candidate floor and count who actually closes.
    const replay = (floor: number): number =>
      shutOut.filter((e) => {
        const outcome = negotiate(
          item,
          { ...policy, floor_price: floor },
          {
            buyer_agent_id: "replay",
            max_price: e.max_price,
            opening_offer: e.opening_offer ?? Math.round(e.max_price * 0.7),
          },
        );
        return outcome.status === "agreed";
      }).length;

    // Walk down in ₹10 steps and stop at the first floor that recovers anyone.
    // The smallest concession that actually works, not the largest that sounds
    // generous.
    const lowestCeiling = Math.min(...shutOut.map((e) => e.max_price));
    let best = 0;
    let recoverable = 0;
    for (let candidate = policy.floor_price - 10; candidate >= Math.max(1, lowestCeiling - 200); candidate -= 10) {
      const n = replay(candidate);
      if (n > 0) {
        best = candidate;
        recoverable = n;
        break;
      }
    }
    if (best === 0) continue; // no floor this shop could offer would have closed them

    const give = policy.floor_price - best;

    out.push({
      id: `opp_floor_${itemId}`,
      kind: "price_floor",
      headline: `${shutOut.length} buyers wanted ${item.name} but could not reach your floor`,
      evidence: [
        `Your asking price is ${money(policy.list_price)}, and you will go to ${money(policy.floor_price)}.`,
        `${lost.length} AI buyers negotiated and walked away; ${shutOut.length} of them were capped below your floor.`,
        `Replaying those haggles at ${money(best)}, ${recoverable} of them close.`,
        `That is ${money(give)} off your floor, against ${money(policy.list_price)} asking.`,
      ],
      recommendation:
        `Lower the floor on ${item.name} to ${money(best)}. ${recoverable === 1 ? "One buyer who walked" : `${recoverable} buyers who walked`} would have bought it — ` +
        `checked by replaying their actual offers, not estimated.`,
      change: { item_id: itemId, field: "floor_price", from: policy.floor_price, to: Math.round(best) },
      lost_buyers: shutOut.length,
    });
  }

  // ── Items an agent cannot sell because they are still held ────────────────
  const held = mine.filter((i) => i.needs_merchant_confirmation);
  const searchesForHeld = events.filter((e) => e.outcome === "held").length;
  if (held.length > 0) {
    out.push({
      id: `opp_held_${merchantId}`,
      kind: "unconfirmed_item",
      headline: `${held.length} item${held.length > 1 ? "s are" : " is"} invisible to AI buyers`,
      evidence: [
        ...held.map((i) => `${i.name} — waiting on you to confirm its details.`),
        ...(searchesForHeld > 0 ? [`${searchesForHeld} search(es) passed over them for that reason.`] : []),
      ],
      recommendation: "Answer the questions on your dashboard and they go on sale immediately.",
      change: null,
      lost_buyers: searchesForHeld,
    });
  }

  // ── Buyers who needed it sooner than this shop delivers ───────────────────
  const tooSlow = events.filter((e) => e.outcome === "no_match" && (e.detail ?? "").includes("Arrives in time"));
  if (tooSlow.length >= 2) {
    out.push({
      id: `opp_delivery_${merchantId}`,
      kind: "delivery_speed",
      headline: `${tooSlow.length} buyers needed it faster than you deliver`,
      evidence: [
        `${tooSlow.length} search(es) matched your stock on every count except timing.`,
        `They wanted it sooner than your stated turnaround.`,
      ],
      recommendation: "If you can hand over same-day, say so in your settings — these buyers would have qualified.",
      change: null,
      lost_buyers: tooSlow.length,
    });
  }

  // ── What people are asking for at all ─────────────────────────────────────
  const wants = new Map<string, number>();
  for (const e of events) wants.set(e.want, (wants.get(e.want) ?? 0) + 1);
  const top = [...wants.entries()].sort((a, b) => b[1] - a[1])[0];
  if (top && top[1] >= 3) {
    out.push({
      id: `opp_demand_${merchantId}`,
      kind: "demand_signal",
      headline: `"${top[0]}" was the most searched thing at your shop`,
      evidence: [`${top[1]} AI buyers searched for it this period.`],
      recommendation: "Worth keeping in stock, and worth a tighter price if you want the volume.",
      change: null,
      lost_buyers: 0,
    });
  }

  return out.sort((a, b) => b.lost_buyers - a.lost_buyers);
}
