import type { MandateChain } from "../mandates/chain.js";
import type { CatalogItem, NegotiationPolicy } from "../mandates/schema.js";

export type Severity = "info" | "low" | "medium" | "high";

export interface RiskSignal {
  id: string;
  label: string;
  severity: Severity;
  /** The actual numbers behind it. Never a score on its own. */
  evidence: string;
}

export interface RiskContext {
  chain: MandateChain;
  item: CatalogItem | undefined;
  policy: NegotiationPolicy | undefined;
  /** Other transactions for the same merchant, for comparison. */
  history: readonly MandateChain[];
  now: Date;
}

const money = (n: number): string => `₹${Math.round(n).toLocaleString("en-IN")}`;
const MINUTE = 60_000;

/**
 * What is actually unusual about this payment.
 *
 * Every signal is arithmetic over stored state, and every one carries the
 * numbers it was computed from. There is no model here and no learned score:
 * this product has nowhere near the transaction volume to train one, and a
 * fabricated probability would be the least trustworthy number on a screen
 * whose whole purpose is being checkable.
 *
 * Signals describe. They do not decide — that is intervention.ts, and keeping
 * them apart is what lets a merchant disagree with a recommendation while still
 * seeing the same facts.
 */
export function assessSignals(ctx: RiskContext): RiskSignal[] {
  const { chain, item, policy, history, now } = ctx;
  const signals: RiskSignal[] = [];

  const agreed = chain.cart?.final_price.value ?? 0;
  const captured = chain.payment?.amount ?? null;

  // ── The one that is never acceptable ──────────────────────────────────────
  if (captured !== null && agreed > 0 && captured !== agreed) {
    signals.push({
      id: "amount_mismatch",
      label: "Captured amount does not match the agreed price",
      severity: "high",
      evidence: `agreed ${money(agreed)}, captured ${money(captured)}`,
    });
  }

  // ── Price far outside what this shop normally takes ───────────────────────
  const settled = history
    .filter((c) => c.payment && c.transaction_id !== chain.transaction_id)
    .map((c) => c.cart?.final_price.value ?? 0)
    .filter((v) => v > 0);

  if (settled.length >= 3 && agreed > 0) {
    const mean = settled.reduce((a, b) => a + b, 0) / settled.length;
    const ratio = agreed > mean ? agreed / mean : mean / agreed;
    if (ratio >= 4) {
      signals.push({
        id: "unusual_amount",
        label: "Unusual amount for this shop",
        severity: ratio >= 8 ? "high" : "medium",
        evidence: `${money(agreed)} against a typical ${money(mean)} across ${settled.length} sales`,
      });
    }
  }

  // ── A burst of purchases, not merely a busy afternoon ─────────────────────
  //
  // Thresholds are deliberately high. A shop taking four payments in five
  // minutes is having a good day, and flagging that would make the whole panel
  // noise the merchant learns to ignore — which is worse than not having it.
  const recent = history.filter((c) => {
    const at = c.payment?.issued_at ?? c.cart?.issued_at;
    return at ? now.getTime() - Date.parse(at) < 2 * MINUTE : false;
  });
  if (recent.length >= 8) {
    signals.push({
      id: "velocity",
      label: "A burst of payments in a very short time",
      severity: recent.length >= 15 ? "high" : "medium",
      evidence: `${recent.length} transactions at this shop within two minutes`,
    });
  }

  // ── A discount far past what the merchant agreed to allow ─────────────────
  if (policy && agreed > 0 && agreed < policy.floor_price) {
    signals.push({
      id: "below_floor",
      label: "Price is under the merchant's own floor",
      severity: "high",
      evidence: `${money(agreed)} against a floor of ${money(policy.floor_price)}`,
    });
  }

  // ── Paid for something the shop had not confirmed ─────────────────────────
  if (item?.needs_merchant_confirmation) {
    signals.push({
      id: "unconfirmed_item",
      label: "The item was never confirmed by the shop",
      severity: "high",
      evidence: `${item.name} is still awaiting the shopkeeper's confirmation`,
    });
  }

  // ── Authorization used well after it was granted ──────────────────────────
  const issued = chain.intent ? Date.parse(chain.intent.issued_at) : NaN;
  const paidAt = chain.payment ? Date.parse(chain.payment.issued_at) : now.getTime();
  if (Number.isFinite(issued) && chain.intent) {
    const ageSeconds = (paidAt - issued) / 1000;
    const ttl = chain.intent.constraints.ttl_seconds;
    if (ageSeconds > ttl * 0.8 && ageSeconds <= ttl) {
      signals.push({
        id: "late_authorization",
        label: "Paid close to the end of the authorization window",
        severity: "low",
        evidence: `${Math.round(ageSeconds)}s into a ${ttl}s window`,
      });
    }
  }

  // ── A shop that repeatedly leaves sales unconfirmed ───────────────────────
  //
  // Only sales old enough that the merchant has had a fair chance to confirm
  // them count. Judging a shop on a payment taken thirty seconds ago says
  // nothing about the shop and everything about the clock.
  const SETTLED_AFTER = 10 * MINUTE;
  const mature = history.filter((c) => {
    const at = c.payment?.issued_at;
    return at ? now.getTime() - Date.parse(at) > SETTLED_AFTER : false;
  });
  const delivered = mature.filter((c) => c.fulfillment).length;
  if (mature.length >= 5 && delivered / mature.length < 0.4) {
    signals.push({
      id: "weak_fulfillment",
      label: "This shop often leaves sales unconfirmed",
      severity: "medium",
      evidence: `${delivered} of ${mature.length} older sales were ever confirmed handed over`,
    });
  }

  // ── Nothing wrong is itself worth saying ──────────────────────────────────
  if (signals.length === 0) {
    signals.push({
      id: "clean",
      label: "Nothing unusual",
      severity: "info",
      evidence:
        settled.length > 0
          ? `amount, timing and merchant record are all in line with ${settled.length} previous sales`
          : "amount matches the agreed price and the authorization is current",
    });
  }

  return signals;
}
