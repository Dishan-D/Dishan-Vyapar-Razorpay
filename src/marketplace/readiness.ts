import type { CatalogItem, NegotiationPolicy } from "../mandates/schema.js";

export interface ReadinessScore {
  merchant_id: string;
  score: number;
  components: {
    catalog_confidence: number;
    policy_coverage: number;
    fulfillment_reliability: number;
  };
  /** Plain-English reason, so the number is never the whole answer. */
  explanation: string;
  basis: { items: number; transactable: number; with_policy: number; sales_confirmed: number; sales_paid: number };
}

const pct = (n: number): number => Math.round(n * 100);

/**
 * Milestone J.1 — how ready a merchant is to be traded with by an agent.
 *
 * Three components, equally weighted. Equal weighting is a choice, not a
 * finding: there is no evidence here about which of these matters most to a
 * buyer, and inventing weights would dress a guess up as precision. It is
 * stated rather than hidden for that reason.
 *
 * Every input already exists — nothing new is tracked to produce this.
 */
export function readinessScore(
  merchantId: string,
  items: readonly CatalogItem[],
  policies: readonly NegotiationPolicy[],
  fulfillment: { confirmed: number; paid: number },
): ReadinessScore {
  const mine = items.filter((i) => i.merchant_id === merchantId);
  const transactable = mine.filter((i) => !i.needs_merchant_confirmation);
  const policyIds = new Set(policies.map((p) => p.item_id));
  const withPolicy = transactable.filter((i) => policyIds.has(i.item_id));

  // Confidence is measured over the whole catalog, so an item still held drags
  // the score down — which is the honest reading: a shop with unresolved items
  // is less ready to be traded with than one without.
  const catalogConfidence =
    mine.length === 0
      ? 0
      : transactable.reduce((a, i) => a + (i.price.confidence + i.stock.confidence) / 2, 0) / mine.length;

  const policyCoverage = transactable.length === 0 ? 0 : withPolicy.length / transactable.length;

  // No sales yet is not evidence of unreliability, but it is not evidence of
  // reliability either. Untested merchants sit at the midpoint rather than
  // scoring a perfect record they have not earned.
  const fulfillmentReliability =
    fulfillment.paid === 0 ? 0.5 : fulfillment.confirmed / fulfillment.paid;

  const components = {
    catalog_confidence: catalogConfidence,
    policy_coverage: policyCoverage,
    fulfillment_reliability: fulfillmentReliability,
  };

  const score = Math.round(((catalogConfidence + policyCoverage + fulfillmentReliability) / 3) * 100);

  const weakest = Object.entries(components).sort((a, b) => a[1] - b[1])[0]!;
  const explanation =
    fulfillment.paid === 0
      ? "no completed sales yet — fulfillment reliability is held at 50% rather than assumed"
      : `weakest component is ${weakest[0].replace(/_/g, " ")} at ${pct(weakest[1])}%`;

  return {
    merchant_id: merchantId,
    score,
    components,
    explanation,
    basis: {
      items: mine.length,
      transactable: transactable.length,
      with_policy: withPolicy.length,
      sales_confirmed: fulfillment.confirmed,
      sales_paid: fulfillment.paid,
    },
  };
}
