import type { MandateChain } from "../mandates/chain.js";
import type { UpiCredit } from "./upi.js";

/**
 * A simulated UPI settlement feed.
 *
 * There is no bank to connect to here, and pretending otherwise would be the
 * one dishonest thing in this pipeline — so this is generated, and every screen
 * that shows it says so. What it is NOT is a feed engineered to reconcile
 * perfectly: a statement where every line matches proves nothing, because the
 * whole point of reconciliation is the lines that do not.
 *
 * So it is built from the shop's real gateway sales, and then made realistic:
 *
 *  - Counter sales. The merchant's existing business — someone scans the QR and
 *    pays for something nobody wrote down. These are the majority of a real
 *    kirana's feed and they are exactly what "unexplained credit" means.
 *  - A line with no payment reference. Plenty of PSPs do not pass one through,
 *    which forces the matcher onto amount-and-time and makes it say "probable".
 *  - A short payment. Someone typed 1000 instead of 1050.
 *
 * The deterministic seed keeps a demo reproducible: the same shop produces the
 * same statement twice, so a judge watching it a second time sees what they saw
 * the first time.
 */

const COUNTER_PAYERS = [
  "9845xxxx21@ybl",
  "anita.k@okaxis",
  "rmesh1987@paytm",
  "9900xxxx07@ibl",
  "sunita.devi@okhdfcbank",
  "kmr.vijay@upi",
];

const COUNTER_NARRATIONS = [
  "UPI/CR/counter",
  "UPI/CR/QR payment",
  "UPI/CR/shop",
  "UPI/CR/",
];

/** Small deterministic PRNG, so one shop always yields one statement. */
function seeded(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h ^= h << 13; h ^= h >>> 17; h ^= h << 5;
    return Math.abs(h % 100000) / 100000;
  };
}

const utr = (rnd: () => number) => String(Math.floor(rnd() * 900000000000) + 100000000000);

export interface StatementOptions {
  /** Counter sales to invent — the merchant's pre-existing, unrecorded trade. */
  counterSales?: number;
  /** Drop the payment reference from this many gateway lines. */
  withoutReference?: number;
  /** Underpay this many gateway lines, to produce a real mismatch. */
  shortPaid?: number;
}

export function buildStatement(
  merchantId: string,
  chains: readonly MandateChain[],
  opts: StatementOptions = {},
): UpiCredit[] {
  const rnd = seeded(merchantId);
  const counterSales = opts.counterSales ?? 4;
  const withoutReference = opts.withoutReference ?? 1;
  const shortPaid = opts.shortPaid ?? 1;

  const paid = chains.filter((c) => c.payment && c.cart);
  const credits: UpiCredit[] = [];

  paid.forEach((chain, i) => {
    const amount = chain.cart!.final_price.value;
    const short = i < shortPaid && amount > 100;
    const anonymous = i >= shortPaid && i < shortPaid + withoutReference;
    credits.push({
      utr: utr(rnd),
      at: chain.payment!.issued_at,
      // Real feeds lag the gateway by seconds; the matcher's window absorbs it.
      amount: short ? amount - 50 : amount,
      payer_vpa: `buyer${(i % 5) + 1}@okicici`,
      narration: "UPI/CR/RAZORPAY",
      ...(anonymous ? {} : { payment_id: chain.payment!.razorpay_payment_id }),
    });
  });

  // Counter sales, spread back over the same period the real sales cover so
  // they interleave rather than sitting in a suspicious block at one end.
  const latest = paid.length > 0 ? Date.parse(paid[paid.length - 1]!.payment!.issued_at) : Date.now();
  for (let i = 0; i < counterSales; i++) {
    const amount = [40, 60, 120, 150, 250, 300, 480][Math.floor(rnd() * 7)] ?? 100;
    credits.push({
      utr: utr(rnd),
      at: new Date(latest - Math.floor(rnd() * 6 * 3600 * 1000)).toISOString(),
      amount,
      payer_vpa: COUNTER_PAYERS[Math.floor(rnd() * COUNTER_PAYERS.length)] ?? "unknown@upi",
      narration: COUNTER_NARRATIONS[Math.floor(rnd() * COUNTER_NARRATIONS.length)] ?? "UPI/CR/",
    });
  }

  return credits.sort((a, b) => (a.at < b.at ? 1 : -1));
}
