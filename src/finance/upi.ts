import type { MandateChain } from "../mandates/chain.js";

/**
 * Matching a bank feed to what was actually sold.
 *
 * A UPI settlement line is four facts: an amount, a timestamp, a payer handle
 * and a reference number. It does not say what was sold, to whom, at what
 * negotiated price, or whether the goods were ever handed over. For a merchant
 * whose entire record of trade is that feed — which is the merchant this whole
 * project is about — every rupee that arrives is an unexplained credit. They
 * know their turnover and nothing else about their own business.
 *
 * The mandate chain knows the other half. Reconciliation is the join, and the
 * interesting output is not the matches: it is the four ways the two sides can
 * fail to agree, each of which is a real thing a shopkeeper needs told.
 */

export interface UpiCredit {
  /** Bank/PSP reference — the UTR or RRN printed on the statement line. */
  utr: string;
  /** When the money landed, per the bank. */
  at: string;
  amount: number;
  /** The payer's VPA as the bank saw it. */
  payer_vpa: string;
  /** Free-text remark the payer or PSP attached, usually useless. */
  narration: string;
  /** Set when the credit came through the gateway rather than a raw QR scan. */
  payment_id?: string;
}

export type MatchKind =
  | "matched"
  | "matched_on_amount"
  | "unexplained_credit"
  | "missing_credit"
  | "amount_mismatch";

export interface ReconRow {
  kind: MatchKind;
  /** Present unless this is a sale with no money against it. */
  credit: UpiCredit | null;
  transaction_id: string | null;
  item_name: string | null;
  amount_banked: number | null;
  amount_agreed: number | null;
  delivered: boolean | null;
  /** Why this row landed in this class, in words a shopkeeper can act on. */
  because: string;
  confidence: "certain" | "probable";
}

export interface ReconResult {
  rows: ReconRow[];
  banked: number;
  explained: number;
  unexplained: number;
  /** Share of banked rupees that can be tied to a product. 0–1. */
  explained_share: number;
  counts: Record<MatchKind, number>;
}

/** Same minute, give or take — banks and our clock are not in lockstep. */
const WINDOW_MS = 15 * 60 * 1000;

const rupees = (n: number) => `₹${n.toLocaleString("en-IN")}`;

/**
 * Join a bank feed to a set of sales.
 *
 * Matching is attempted strongest-first and each side is consumed once, so a
 * credit cannot be claimed by two sales and a sale cannot be paid twice. The
 * ordering matters: a gateway payment id is an identity, an amount within a
 * time window is a guess, and the result says which of the two happened rather
 * than presenting both as the same fact.
 */
export function reconcileUpi(credits: readonly UpiCredit[], chains: readonly MandateChain[], itemName: (chain: MandateChain) => string | null): ReconResult {
  const rows: ReconRow[] = [];
  const usedCredits = new Set<string>();
  const usedChains = new Set<string>();

  const paid = chains.filter((c) => c.payment && c.cart);

  // ── Pass 1: the gateway's own payment id. This is identity, not inference ──
  //
  // Identity only holds while the id is unique, and historically it has not
  // been: a simulated gateway whose counter reset on restart issued the same
  // payment id to eight different sales. Matching those on the id alone
  // produced four confident "amount mismatch" findings that were pure fiction.
  // So an id shared by several sales is not identity any more — it is a
  // collision, and the amount decides between them.
  const idCounts = new Map<string, number>();
  for (const c of paid) {
    const pid = c.payment!.razorpay_payment_id;
    idCounts.set(pid, (idCounts.get(pid) ?? 0) + 1);
  }

  for (const chain of paid) {
    const pid = chain.payment!.razorpay_payment_id;
    const agreedHere = chain.cart!.final_price.value;
    const ambiguous = (idCounts.get(pid) ?? 0) > 1;

    const hit = credits.find(
      (c) =>
        c.payment_id === pid &&
        !usedCredits.has(c.utr) &&
        // When the id is shared, only a credit that also agrees on the money
        // can be this sale's. A duplicated id plus a differing amount is two
        // unrelated facts, not a discrepancy worth reporting.
        (!ambiguous || c.amount === agreedHere),
    );
    if (!hit) continue;
    usedCredits.add(hit.utr);
    usedChains.add(chain.transaction_id);

    const agreed = chain.cart!.final_price.value;
    if (hit.amount !== agreed) {
      rows.push({
        kind: "amount_mismatch",
        credit: hit,
        transaction_id: chain.transaction_id,
        item_name: itemName(chain),
        amount_banked: hit.amount,
        amount_agreed: agreed,
        delivered: Boolean(chain.fulfillment),
        because: `The bank credited ${rupees(hit.amount)} but the agreed price was ${rupees(agreed)}. Same payment reference, different money.`,
        confidence: "certain",
      });
      continue;
    }
    rows.push({
      kind: "matched",
      credit: hit,
      transaction_id: chain.transaction_id,
      item_name: itemName(chain),
      amount_banked: hit.amount,
      amount_agreed: agreed,
      delivered: Boolean(chain.fulfillment),
      because: `Payment reference on the statement matches this sale exactly.`,
      confidence: "certain",
    });
  }

  // ── Pass 2: amount and time. A guess, and labelled as one ─────────────────
  for (const chain of paid) {
    if (usedChains.has(chain.transaction_id)) continue;
    const agreed = chain.cart!.final_price.value;
    const paidAt = Date.parse(chain.payment!.issued_at);

    const near = credits.filter(
      (c) => !usedCredits.has(c.utr) && c.amount === agreed && Math.abs(Date.parse(c.at) - paidAt) <= WINDOW_MS,
    );
    // Two credits for the same amount in the same quarter hour cannot be told
    // apart, and picking one would be inventing a fact. Leave both alone.
    if (near.length !== 1) continue;

    const hit = near[0]!;
    usedCredits.add(hit.utr);
    usedChains.add(chain.transaction_id);
    rows.push({
      kind: "matched_on_amount",
      credit: hit,
      transaction_id: chain.transaction_id,
      item_name: itemName(chain),
      amount_banked: hit.amount,
      amount_agreed: agreed,
      delivered: Boolean(chain.fulfillment),
      because: `No payment reference on this line, but ${rupees(hit.amount)} landed within minutes of this sale and nothing else matches it.`,
      confidence: "probable",
    });
  }

  // ── What is left over on each side ────────────────────────────────────────
  for (const c of credits) {
    if (usedCredits.has(c.utr)) continue;
    rows.push({
      kind: "unexplained_credit",
      credit: c,
      transaction_id: null,
      item_name: null,
      amount_banked: c.amount,
      amount_agreed: null,
      delivered: null,
      because: `${rupees(c.amount)} arrived from ${c.payer_vpa} and nothing in the shop's records says what it was for.`,
      confidence: "certain",
    });
  }

  for (const chain of paid) {
    if (usedChains.has(chain.transaction_id)) continue;
    rows.push({
      kind: "missing_credit",
      credit: null,
      transaction_id: chain.transaction_id,
      item_name: itemName(chain),
      amount_banked: null,
      amount_agreed: chain.cart!.final_price.value,
      delivered: Boolean(chain.fulfillment),
      because: `This sale is recorded as paid, but no credit for ${rupees(chain.cart!.final_price.value)} appears on the statement.`,
      confidence: "certain",
    });
  }

  const banked = credits.reduce((s, c) => s + c.amount, 0);
  const explained = rows
    .filter((r) => r.kind === "matched" || r.kind === "matched_on_amount" || r.kind === "amount_mismatch")
    .reduce((s, r) => s + (r.amount_banked ?? 0), 0);

  const counts = { matched: 0, matched_on_amount: 0, unexplained_credit: 0, missing_credit: 0, amount_mismatch: 0 } as Record<MatchKind, number>;
  for (const r of rows) counts[r.kind]++;

  return {
    rows: rows.sort((a, b) => (a.credit?.at ?? "") < (b.credit?.at ?? "") ? 1 : -1),
    banked,
    explained,
    unexplained: banked - explained,
    explained_share: banked === 0 ? 0 : explained / banked,
    counts,
  };
}
