import { buildFulfillmentMandate, verifyChain, type MandateChain } from "../mandates/chain.js";
import type { Keyring } from "../mandates/keys.js";
import type { FulfillmentMandate } from "../mandates/schema.js";

export class FulfillmentRefused extends Error {
  constructor(readonly reasons: string[]) {
    super(`Fulfillment confirmation refused: ${reasons.join("; ")}`);
    this.name = "FulfillmentRefused";
  }
}

export interface ConfirmInput {
  evidence_note?: string | null;
  evidence_photo_ref?: string | null;
}

/**
 * Stage 6 — the merchant confirms the goods actually changed hands.
 *
 * AP2's chain stops at payment because it assumes a trackable shipping API.
 * A kirana store handing a saree across a counter has no such API, so the
 * merchant's own signature is the only evidence that fulfillment happened —
 * which is exactly why it has to be their key, signing a mandate bound to the
 * payment, and not a status column the platform can set on their behalf.
 *
 * Nothing here infers fulfillment. If the merchant never confirms, the
 * transaction stays at payment_confirmed_awaiting_fulfillment forever, and the
 * audit chain says so plainly.
 */
export async function confirmFulfillment(
  chain: MandateChain,
  keyring: Keyring,
  input: ConfirmInput = {},
): Promise<FulfillmentMandate> {
  const reasons: string[] = [];

  if (!chain.payment) {
    reasons.push("no payment mandate — nothing has been paid for yet");
  }
  if (chain.fulfillment) {
    reasons.push("fulfillment already confirmed for this transaction");
  }

  if (reasons.length === 0) {
    // The chain being confirmed must itself be sound; signing a fulfillment onto
    // a broken chain would produce evidence that vouches for nothing.
    const report = await verifyChain(chain, keyring);
    if (!report.ok) reasons.push(...report.failures);
  }

  if (reasons.length > 0) throw new FulfillmentRefused(reasons);

  return buildFulfillmentMandate(
    chain.payment!,
    {
      confirmed_by: "merchant",
      evidence_note: input.evidence_note ?? null,
      evidence_photo_ref: input.evidence_photo_ref ?? null,
    },
    keyring,
  );
}
