import type { CatalogItem } from "../mandates/schema.js";

export type SanityVerdict = "pass" | "fail" | "skipped";

export interface SanityResult {
  check: SanityVerdict;
  reason: string;
  z?: number;
  mean?: number;
  sd?: number;
  /** How many of the merchant's own items formed the baseline. */
  n: number;
  /** The price range the baseline covers, for the clarification question. */
  range?: { low: number; high: number };
}

/** Below this many peers there is no baseline worth calling one. */
export const MIN_PEERS = 3;

/** |z| above this is treated as out of family. */
export const Z_THRESHOLD = 2;

/**
 * A price must ALSO be off by more than this factor before it is called out.
 *
 * A z-score alone over-fires whenever a merchant's prices cluster tightly: four
 * snacks between ₹90 and ₹120 give a standard deviation of about ₹12, which
 * makes ₹60 a four-sigma event. But ₹60 for banana chips in a shop selling
 * ₹90 murukku is unremarkable — it is cheap, not wrong. What this check is for
 * is the misheard or mistyped digit, and those are off by an order of magnitude,
 * not by forty percent. Requiring both tests to fire keeps it to that case.
 */
export const RATIO_THRESHOLD = 2;

/**
 * A price is checked against the merchant's own prices in the same category.
 *
 * This exists because one LLM call scoring its own confidence is one opinion
 * checking itself. A shopkeeper who sells four snacks between ₹90 and ₹120 and
 * then says ₹1100 has almost certainly said — or been heard saying — one digit
 * too many, and that is knowable without asking a model anything.
 *
 * The item under test is excluded from its own baseline. Including it would let
 * a single extreme value inflate the standard deviation enough to hide itself,
 * which is precisely the case this check exists to catch.
 *
 * Items with no usable price are excluded from the baseline too — an unpriced
 * item is not evidence about what this merchant charges.
 */
export function priceSanity(item: CatalogItem, catalog: readonly CatalogItem[]): SanityResult {
  const peers = catalog
    .filter(
      (p) =>
        p.item_id !== item.item_id &&
        p.merchant_id === item.merchant_id &&
        p.category === item.category &&
        p.price.value > 0 &&
        p.price.confidence > 0,
    )
    .map((p) => p.price.value);

  if (item.price.value <= 0) {
    return { check: "skipped", reason: "no price to check", n: peers.length };
  }

  // A price the merchant stated directly, in answer to being asked, is not
  // re-litigated. They have already seen the objection and overruled it.
  if (item.price.confidence >= 1) {
    return { check: "skipped", reason: "price confirmed by the merchant directly", n: peers.length };
  }

  if (peers.length < MIN_PEERS) {
    return {
      check: "skipped",
      reason: `only ${peers.length} other priced item(s) in ${item.category} — too few to build a baseline`,
      n: peers.length,
    };
  }

  const mean = peers.reduce((a, b) => a + b, 0) / peers.length;
  const variance = peers.reduce((a, b) => a + (b - mean) ** 2, 0) / peers.length;
  const sd = Math.sqrt(variance);
  const range = { low: Math.min(...peers), high: Math.max(...peers) };

  // Every peer priced identically: a z-score is undefined, so fall back to a
  // plain ratio test rather than dividing by zero or waving the item through.
  if (sd === 0) {
    const ratio = Math.abs(item.price.value - mean) / mean;
    return ratio > 0.5
      ? {
          check: "fail",
          reason: `₹${item.price.value} is ${(ratio * 100).toFixed(0)}% away from every other ${item.category} item, all priced ₹${mean}`,
          mean,
          sd,
          n: peers.length,
          range,
        }
      : { check: "pass", reason: `in line with the merchant's other ${item.category} prices`, mean, sd, n: peers.length, range };
  }

  const z = (item.price.value - mean) / sd;
  const ratio = item.price.value > mean ? item.price.value / mean : mean / item.price.value;

  if (Math.abs(z) > Z_THRESHOLD && ratio > RATIO_THRESHOLD) {
    return {
      check: "fail",
      reason: `z-score ${z.toFixed(1)}, ${ratio.toFixed(1)}× the category mean of ₹${mean.toFixed(0)} (other ${item.category} items run ₹${range.low}–₹${range.high})`,
      z,
      mean,
      sd,
      n: peers.length,
      range,
    };
  }

  return {
    check: "pass",
    reason:
      Math.abs(z) > Z_THRESHOLD
        ? `z-score ${z.toFixed(1)} but only ${ratio.toFixed(1)}× the mean — unusual, not implausible`
        : `z-score ${z.toFixed(1)} — in line with ₹${range.low}–₹${range.high}`,
    z,
    mean,
    sd,
    n: peers.length,
    range,
  };
}
