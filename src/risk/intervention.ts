import type { RiskSignal, Severity } from "./signals.js";

/**
 * What to do about it, from lightest to heaviest.
 *
 * The order matters: this is the whole idea borrowed from KAIROS's "minimum
 * effective intervention" — the cheapest action that actually manages the risk,
 * rather than a binary allow/block that treats a slightly odd payment the same
 * as a fraudulent one. Blocking a good customer has a cost too; it is just not
 * on the same line of the ledger.
 */
export type Action = "allow" | "monitor" | "verify" | "hold" | "block";

export const ACTION_ORDER: Action[] = ["allow", "monitor", "verify", "hold", "block"];

export interface Intervention {
  action: Action;
  /** Plain-language summary a shopkeeper can act on. */
  headline: string;
  /** Why this action and not a heavier one. */
  rationale: string;
  /** What the merchant does next, in their words. */
  next_step: string;
  signals: RiskSignal[];
  /** Highest severity seen. */
  level: Severity;
  /** Money left alone by not over-reacting, when that applies. */
  restraint: string | null;
}

const RANK: Record<Severity, number> = { info: 0, low: 1, medium: 2, high: 3 };

const money = (n: number): string => `₹${Math.round(n).toLocaleString("en-IN")}`;

/**
 * Signals in, one recommendation out — deterministically.
 *
 * Some signals are not risk at all but correctness: an amount that does not
 * match what was agreed, or a payment for an item the shop never confirmed,
 * cannot be waved through with extra verification, because no amount of
 * confirming the buyer makes the transaction right. Those go straight to a
 * stop. Everything else earns the lightest action that covers it.
 */
export function recommend(signals: readonly RiskSignal[], amount: number): Intervention {
  const worst = signals.reduce<Severity>((acc, s) => (RANK[s.severity] > RANK[acc] ? s.severity : acc), "info");
  const ids = new Set(signals.map((s) => s.id));

  // Integrity faults, not risk judgements. Verification cannot fix these.
  const integrity = ["amount_mismatch", "below_floor", "unconfirmed_item"].filter((id) => ids.has(id));
  if (integrity.length > 0) {
    const s = signals.find((x) => x.id === integrity[0])!;
    return {
      action: "block",
      headline: "Do not settle this",
      rationale: `${s.label}. This is not a question of who the buyer is — the transaction disagrees with what was agreed, and confirming the customer would not change that.`,
      next_step: "Leave it blocked and check the order against what you agreed.",
      signals: [...signals],
      level: "high",
      restraint: null,
    };
  }

  if (worst === "high") {
    return {
      action: "hold",
      headline: "Hold this for review",
      rationale: signals.filter((s) => s.severity === "high").map((s) => s.label).join("; ") + ".",
      next_step: "Look at it before handing anything over. Nothing is lost by waiting.",
      signals: [...signals],
      level: worst,
      restraint: null,
    };
  }

  if (worst === "medium") {
    return {
      action: "verify",
      headline: "Worth a quick check, not a refusal",
      rationale:
        signals.filter((s) => s.severity === "medium").map((s) => s.label).join("; ") +
        ". That is unusual rather than wrong, and a confirmation is enough to settle it.",
      next_step: "Confirm with the buyer before handover.",
      signals: [...signals],
      level: worst,
      // The point of the lighter action, stated in money.
      restraint: `Blocking would have turned away ${money(amount)} that is probably good.`,
    };
  }

  if (worst === "low") {
    return {
      action: "monitor",
      headline: "Fine, but noted",
      rationale: signals.filter((s) => s.severity === "low").map((s) => s.label).join("; ") + ". Not enough to act on.",
      next_step: "Nothing to do.",
      signals: [...signals],
      level: worst,
      restraint: `No friction added to ${money(amount)}.`,
    };
  }

  return {
    action: "allow",
    headline: "Nothing unusual",
    rationale: signals[0]?.evidence ?? "every check passed",
    next_step: "Nothing to do.",
    signals: [...signals],
    level: "info",
    restraint: `${money(amount)} settled without asking the buyer for anything.`,
  };
}
