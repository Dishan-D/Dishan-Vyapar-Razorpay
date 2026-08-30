import type { NegotiationPolicy } from "../mandates/schema.js";

/**
 * Negotiation policies now live with the merchant that set them, in
 * data/merchants.json, and arrive via the structuring result. A floor price is
 * the merchant's own decision about their margin — keeping it in a file beside
 * their products, rather than in a global table, is closer to what it is.
 */
export function indexPolicies(policies: readonly NegotiationPolicy[]): Map<string, NegotiationPolicy> {
  return new Map(policies.map((p) => [p.item_id, p]));
}

/** An item with no policy is not negotiable — a merchant decision, not an error. */
export function policyFor(
  policies: Map<string, NegotiationPolicy>,
  itemId: string,
): NegotiationPolicy | undefined {
  return policies.get(itemId);
}
