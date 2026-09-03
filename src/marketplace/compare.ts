import { discover } from "../catalog/discovery.js";
import { negotiate, type BuyerMandate, type NegotiationOutcome } from "../negotiation/engine.js";
import type { CatalogItem, NegotiationPolicy } from "../mandates/schema.js";
import type { ReadinessScore } from "./readiness.js";

/**
 * How much a merchant's unreliability is worth in rupees.
 *
 * A cheaper offer from someone who may not hand the goods over is not actually
 * cheaper. At 0.5, a merchant with a 60% record has their price treated as 20%
 * higher than it is — enough to lose a close race, not enough to override a
 * genuinely large price gap. Stated here so the trade-off is arguable rather
 * than buried.
 */
export const RISK_WEIGHT = 0.5;

export interface MerchantOffer {
  merchant_id: string;
  merchant_name: string;
  item_id: string;
  item_name: string;
  list_price: number;
  readiness: ReadinessScore;
  outcome: NegotiationOutcome;
  final_price: number | null;
  /** Price adjusted for the chance of never receiving the goods. */
  effective_price: number | null;
  eligible: boolean;
  note: string;
}

export interface ComparisonResult {
  want: string;
  offers: MerchantOffer[];
  selected: MerchantOffer | null;
  /** Shops that stock it but cannot sell it yet, and why. */
  withheld: Array<{ merchant_id: string; merchant_name: string; item_name: string; reason: string }>;
  reasoning: string[];
}

export interface MerchantView {
  merchant_id: string;
  name: string;
  readiness: ReadinessScore;
}

/**
 * Milestone J.2 — one intent, every merchant, one justified choice.
 *
 * Discovery and negotiation run independently per merchant, exactly as they
 * would if these were separate services. The losing offers are kept: a
 * comparison you cannot inspect is indistinguishable from a preference.
 */
export function compareMerchants(
  want: string,
  buyer: Omit<BuyerMandate, "buyer_agent_id"> & { buyer_agent_id: string },
  merchants: readonly MerchantView[],
  catalog: readonly CatalogItem[],
  policies: ReadonlyMap<string, NegotiationPolicy>,
  requirements: { category?: string; attributes?: Record<string, string> } = {},
): ComparisonResult {
  const offers: MerchantOffer[] = [];
  const withheld: ComparisonResult["withheld"] = [];

  for (const merchant of merchants) {
    const theirs = catalog.filter((i) => i.merchant_id === merchant.merchant_id);
    const found = discover(theirs, {
      want,
      max_price: buyer.max_price,
      ...(requirements.category ? { category: requirements.category } : {}),
      ...(requirements.attributes ? { attributes: requirements.attributes } : {}),
    });
    for (const w of found.withheld) {
      withheld.push({
        merchant_id: merchant.merchant_id,
        merchant_name: merchant.name,
        item_name: w.item.name,
        reason: w.reason,
      });
    }

    const match = found.matches[0];
    if (!match) continue;

    const policy = policies.get(match.item.item_id);
    if (!policy) {
      offers.push({
        merchant_id: merchant.merchant_id,
        merchant_name: merchant.name,
        item_id: match.item.item_id,
        item_name: match.item.name,
        list_price: match.item.price.value,
        readiness: merchant.readiness,
        outcome: { status: "no_deal", reason: "no negotiation policy set", rounds: 0, log: [] },
        final_price: null,
        effective_price: null,
        eligible: false,
        note: "stocks it, but has not set a price floor — not open to agent negotiation",
      });
      continue;
    }

    const outcome = negotiate(match.item, policy, { ...buyer });
    const agreed = outcome.status === "agreed" ? outcome.final_price : null;
    const risk = 1 - merchant.readiness.score / 100;

    offers.push({
      merchant_id: merchant.merchant_id,
      merchant_name: merchant.name,
      item_id: match.item.item_id,
      item_name: match.item.name,
      list_price: match.item.price.value,
      readiness: merchant.readiness,
      outcome,
      final_price: agreed,
      effective_price: agreed === null ? null : Math.round(agreed * (1 + RISK_WEIGHT * risk)),
      eligible: agreed !== null,
      note:
        agreed === null
          ? outcome.status === "no_deal"
            ? outcome.reason
            : "no agreement"
          : `agreed ₹${agreed} in ${outcome.rounds} round(s)`,
    });
  }

  const eligible = offers.filter((o) => o.eligible);
  eligible.sort((a, b) => a.effective_price! - b.effective_price! || b.readiness.score - a.readiness.score);
  const selected = eligible[0] ?? null;

  const reasoning: string[] = [];
  if (offers.length === 0 && withheld.length > 0) {
    /**
     * Say which kind of "no" this is, using the reason already recorded.
     *
     * A shop that has the thing but has not priced it is a different answer
     * from one that has sold out, which is different again from one that does
     * not stock it — and the shopper deserves the real one. This used to
     * announce the unpriced case for every withholding, so a sold-out cake was
     * reported as "the shopkeeper has not confirmed a price" while the entry
     * directly beside it in the same response read "out of stock". Two
     * contradictory answers to one question, from one object.
     */
    const sold = withheld.filter((w) => /stock/i.test(w.reason)).length;
    const unpriced = withheld.length - sold;
    if (sold > 0) {
      reasoning.push(
        `${sold} shop(s) stock ${want} but ${sold === 1 ? "it is" : "they are"} out of stock right now.`,
      );
    }
    if (unpriced > 0) {
      reasoning.push(
        `${unpriced} shop(s) stock something matching "${want}", but it is not on sale yet — the shopkeeper has not confirmed a price.`,
      );
    }
  } else if (offers.length === 0) {
    reasoning.push(`Nobody stocks anything matching "${want}".`);
  } else {
    reasoning.push(`${offers.length} merchant(s) stock it; ${eligible.length} reached a price.`);
    for (const o of eligible) {
      reasoning.push(
        `${o.merchant_name}: ₹${o.final_price} at readiness ${o.readiness.score} → ₹${o.effective_price} risk-adjusted`,
      );
    }
    if (selected) {
      const runnerUp = eligible[1];
      if (runnerUp && runnerUp.final_price! < selected.final_price!) {
        reasoning.push(
          `Chose ${selected.merchant_name} even though ${runnerUp.merchant_name} was cheaper ` +
            `(₹${runnerUp.final_price} vs ₹${selected.final_price}) — reliability closed the gap.`,
        );
      } else if (runnerUp) {
        reasoning.push(
          `Chose ${selected.merchant_name}: cheapest even after adjusting for reliability.`,
        );
      } else {
        reasoning.push(`Chose ${selected.merchant_name} — the only merchant that reached a price.`);
      }
    } else {
      reasoning.push("No merchant reached a price within the buyer's authorization.");
    }
  }

  return { want, offers, selected, withheld, reasoning };
}
