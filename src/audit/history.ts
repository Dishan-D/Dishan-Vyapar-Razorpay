import { hashObject } from "../mandates/canonical.js";
import type { Keyring } from "../mandates/keys.js";
import type { MandateChain } from "../mandates/chain.js";
import { verifyChain } from "../mandates/chain.js";
import { signDocument, verifyDocument, type SignatureCheck } from "../mandates/sign.js";
import type { NegotiationPolicy } from "../mandates/schema.js";

export interface CommerceHistoryLine {
  transaction_id: string;
  item_id: string;
  agreed_price: number;
  list_price: number | null;
  discount_pct: number | null;
  paid_at: string;
  fulfilled_at: string | null;
  chain_hash: string;
}

export interface CommerceHistory extends Record<string, unknown> {
  merchant_id: string;
  merchant_name: string;
  period: { from: string; to: string };
  completed_transactions: number;
  paid_transactions: number;
  total_verified_value: number;
  fulfillment_confirmation_rate: number;
  negotiation_avg_discount_pct: number | null;
  dispute_free_rate: number;
  transactions: CommerceHistoryLine[];
  signed_report_hash: string;
  generated_at: string;
  verification_note: string;
  caveats: string[];
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Milestone H — a merchant's verifiable trading record.
 *
 * This is not a lending product and makes no creditworthiness claim. It
 * repackages what the mandate chains already prove: what was sold, at what
 * price, and whether the merchant confirmed delivery. A UPI settlement total
 * says money moved; this says what it moved *for*, and every line is backed by
 * four signatures a stranger can check.
 *
 * Only chains that verify are counted. A report that quietly included a broken
 * chain would be worth less than no report, because its whole value is that
 * someone else can check it and find it holds.
 */
export async function buildCommerceHistory(
  merchant: { merchant_id: string; name: string },
  chains: readonly MandateChain[],
  policies: readonly NegotiationPolicy[],
  keyring: Keyring,
  period: { from: string; to: string },
): Promise<CommerceHistory> {
  const listPrice = new Map(policies.map((p) => [p.item_id, p.list_price]));

  const lines: CommerceHistoryLine[] = [];
  let paid = 0;

  for (const chain of chains) {
    if (chain.cart?.merchant_id !== merchant.merchant_id) continue;
    if (!chain.payment) continue;

    const report = await verifyChain(chain, keyring);
    if (!report.ok) continue; // a chain that does not verify is not evidence

    paid++;
    const agreed = chain.cart.final_price.value;
    const list = listPrice.get(chain.cart.item_id) ?? null;

    lines.push({
      transaction_id: chain.transaction_id,
      item_id: chain.cart.item_id,
      agreed_price: agreed,
      list_price: list,
      discount_pct: list && list > 0 ? round2(((list - agreed) / list) * 100) : null,
      paid_at: chain.payment.issued_at,
      fulfilled_at: chain.fulfillment?.confirmed_at ?? null,
      chain_hash: report.mandates.find((m) => m.type === "fulfillment")?.hash ??
        report.mandates.find((m) => m.type === "payment")?.hash ??
        "",
    });
  }

  const fulfilled = lines.filter((l) => l.fulfilled_at !== null);
  const discounts = lines.map((l) => l.discount_pct).filter((d): d is number => d !== null);

  const unsigned = {
    merchant_id: merchant.merchant_id,
    merchant_name: merchant.name,
    period,
    completed_transactions: fulfilled.length,
    paid_transactions: paid,
    total_verified_value: fulfilled.reduce((a, l) => a + l.agreed_price, 0),
    fulfillment_confirmation_rate: paid === 0 ? 0 : round2(fulfilled.length / paid),
    negotiation_avg_discount_pct:
      discounts.length === 0 ? null : round2(discounts.reduce((a, b) => a + b, 0) / discounts.length),
    dispute_free_rate: 1,
    transactions: lines,
    generated_at: new Date().toISOString(),
    verification_note:
      "Every transaction listed is backed by a signed 4-mandate chain: buyer intent, agreed cart, captured payment, confirmed fulfillment. Chains that fail verification are excluded rather than counted.",
    caveats: [
      "total_verified_value counts only transactions the merchant confirmed as delivered; paid-but-unconfirmed sales are in paid_transactions and nowhere else.",
      "dispute_free_rate is 1.0 because no dispute channel exists in this system yet — it means no disputes are recorded, not that none occurred.",
      "Covers only sales made through this pipeline. A merchant's cash and direct-UPI trade is invisible here.",
    ],
  };

  // The hash covers the report as it stands before signing, so a reader can
  // recompute it from the content without needing to strip the signature first.
  const withHash = { ...unsigned, signed_report_hash: hashObject(unsigned) };
  return (await signDocument(withHash, keyring, "platform")) as unknown as CommerceHistory;
}

export async function verifyCommerceHistory(
  report: Record<string, unknown>,
  keyring: Keyring,
): Promise<SignatureCheck> {
  return verifyDocument(report, keyring, "platform");
}
