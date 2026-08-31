import type { MandateChain } from "../mandates/chain.js";
import type { Keyring } from "../mandates/keys.js";
import { verifyChain } from "../mandates/chain.js";

export interface ReconciliationRow {
  transaction_id: string;
  merchant_id: string | null;
  item_id: string | null;
  negotiated: number | null;
  authorized: number | null;
  captured: number | null;
  fulfilled: boolean;
  chain_verified: boolean;
  matched: boolean;
  exceptions: string[];
}

export interface ReconciliationSummary {
  transactions: number;
  matched: number;
  exceptions: number;
  match_rate: number;
  by_exception: Record<string, number>;
  rows: ReconciliationRow[];
}

/**
 * Does every stage of a sale agree about the money?
 *
 * Each mandate states an amount independently: what was agreed, what the order
 * was opened for, what the gateway captured. They are supposed to be the same
 * number, and the only way to know is to compare them rather than trust that
 * whoever wrote them was careful.
 *
 * A transaction still in flight is not an exception — a cart with no payment yet
 * is a normal state, and flagging it would bury the real breaks in noise.
 */
export async function reconcile(
  chains: readonly MandateChain[],
  keyring: Keyring,
): Promise<ReconciliationSummary> {
  const rows: ReconciliationRow[] = [];

  for (const chain of chains) {
    const exceptions: string[] = [];

    const negotiated = chain.cart?.final_price.value ?? null;
    const captured = chain.payment?.amount ?? null;
    // The order is authorized against the cart, so the cart's figure is the
    // authorized one; a payment mandate that disagrees is the break.
    const authorized = negotiated;

    const report = await verifyChain(chain, keyring);
    if (!report.ok) exceptions.push("chain does not verify");

    if (chain.payment && negotiated !== null && captured !== negotiated) {
      exceptions.push(`captured ₹${captured} against an agreed ₹${negotiated}`);
    }
    if (chain.fulfillment && !chain.payment) {
      exceptions.push("fulfillment recorded with no payment");
    }
    if (chain.payment && !chain.cart) {
      exceptions.push("payment recorded with no agreed cart");
    }

    const settled = Boolean(chain.payment);
    const inFlight = !settled;

    rows.push({
      transaction_id: chain.transaction_id,
      merchant_id: chain.cart?.merchant_id ?? null,
      item_id: chain.cart?.item_id ?? null,
      negotiated,
      authorized,
      captured,
      fulfilled: Boolean(chain.fulfillment),
      chain_verified: report.ok,
      matched: exceptions.length === 0 && !inFlight,
      exceptions,
    });
  }

  const settledRows = rows.filter((r) => r.captured !== null);
  const matched = settledRows.filter((r) => r.matched).length;
  const byException: Record<string, number> = {};
  for (const r of rows) for (const e of r.exceptions) byException[e] = (byException[e] ?? 0) + 1;

  return {
    transactions: settledRows.length,
    matched,
    exceptions: settledRows.length - matched,
    match_rate: settledRows.length === 0 ? 0 : Math.round((matched / settledRows.length) * 1000) / 10,
    by_exception: byException,
    rows,
  };
}
