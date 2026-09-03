import type { MandateChain } from "../mandates/chain.js";
import type { CatalogItem } from "../mandates/schema.js";

/**
 * One reading of what was actually sold.
 *
 * Every number a merchant sees comes from here, and everything here comes from
 * signed mandate chains. There is no revenue counter to increment, no product
 * stat kept alongside a sale, and nothing to drift: a figure is recomputed from
 * the chains each time it is asked for, so it cannot disagree with the
 * transactions it claims to summarise.
 *
 * The alternative — updating merchant.revenue and product.sales as payments
 * land — has one failure mode this design does not: a write that lands in one
 * place and not the other, after which the dashboard is confidently wrong and
 * nothing in the system can tell.
 *
 * A cart mandate carries a single item, so one order is one product line. That
 * is a property of the mandate schema, not an assumption made here: a basket
 * bought in conversation becomes several orders, each with its own signatures,
 * and the ledger reads them as several lines.
 */

export type Attribution = "organic" | "cross_sell" | "upsell" | "revenue_agent";

export interface TxnLine {
  productId: string;
  productName: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  listPrice: number | null;
  /** Negative when the shop sold below list, which is the usual case here. */
  discount: number | null;
  attribution: Attribution;
}

export interface Txn {
  transactionId: string;
  /**
   * Who the buying agent was acting for.
   *
   * Read off the signed intent mandate rather than a column beside it, so
   * "who are my regulars" derives from the same evidence as the revenue does.
   * Null for the runs that predate buyer identity, and for any agent that is
   * genuinely anonymous — which the analytics must survive rather than assume
   * away.
   */
  buyerAgentId: string | null;
  orderId: string | null;
  paymentId: string | null;
  merchantId: string;
  status: "paid" | "awaiting_payment" | "delivered";
  source: "razorpay" | "simulated";
  amount: number;
  currency: "INR";
  createdAt: string;
  paidAt: string | null;
  deliveredAt: string | null;
  items: TxnLine[];
}

export interface IntegrityFault {
  transactionId: string;
  problem: string;
}

/**
 * Chains in, transactions out.
 *
 * `attributionFor` is passed rather than inferred. Nothing in a mandate says
 * whether a line was the thing the shopper came for or something suggested
 * alongside it, and working it out afterwards from names or prices would be
 * exactly the guessing this file exists to remove — so the buying path records
 * it at the time and this reads what was recorded.
 */
export function toTransactions(
  chains: readonly MandateChain[],
  catalog: readonly CatalogItem[],
  opts: {
    listPriceFor?: (itemId: string) => number | null;
    attributionFor?: (transactionId: string) => Attribution;
  } = {},
): Txn[] {
  const out: Txn[] = [];

  for (const chain of chains) {
    const cart = chain.cart;
    if (!cart) continue; // never reached an agreed price; not a transaction yet

    const item = catalog.find((i) => i.item_id === cart.item_id);
    const unit = cart.final_price.value;
    const list = opts.listPriceFor?.(cart.item_id) ?? null;
    const orderId = chain.payment?.razorpay_order_id ?? null;

    out.push({
      transactionId: chain.transaction_id,
      buyerAgentId: chain.intent?.buyer_agent_id ?? null,
      orderId,
      paymentId: chain.payment?.razorpay_payment_id ?? null,
      merchantId: cart.merchant_id,
      status: chain.fulfillment ? "delivered" : chain.payment ? "paid" : "awaiting_payment",
      // Which rail this ran on is decided by the id it holds, not by whatever
      // gateway happens to be configured now.
      source: (chain.payment?.razorpay_payment_id ?? orderId ?? "").startsWith("sim_") ? "simulated" : "razorpay",
      amount: unit,
      currency: "INR",
      createdAt: cart.issued_at,
      paidAt: chain.payment?.issued_at ?? null,
      deliveredAt: chain.fulfillment?.confirmed_at ?? null,
      items: [
        {
          productId: cart.item_id,
          productName: item?.name ?? cart.item_id,
          quantity: 1,
          unitPrice: unit,
          lineTotal: unit,
          listPrice: list,
          discount: list === null ? null : list - unit,
          attribution: opts.attributionFor?.(chain.transaction_id) ?? "organic",
        },
      ],
    });
  }

  return out.sort((a, b) => (a.paidAt ?? a.createdAt) < (b.paidAt ?? b.createdAt) ? 1 : -1);
}

/** Money only counts once it has actually been paid. */
const isPaid = (t: Txn): boolean => t.status === "paid" || t.status === "delivered";

export interface MerchantStats {
  merchantId: string;
  revenue: number;
  orders: number;
  unitsSold: number;
  averageOrderValue: number;
  awaitingPayment: number;
  delivered: number;
  revenueByDay: Array<{ day: string; revenue: number; orders: number }>;
  revenueByCategory: Array<{ category: string; revenue: number; units: number }>;
  byAttribution: Record<Attribution, { revenue: number; units: number }>;
  topProducts: Array<{ productId: string; name: string; units: number; revenue: number }>;
  recent: Txn[];
}

export function merchantStats(
  merchantId: string,
  txns: readonly Txn[],
  catalog: readonly CatalogItem[],
): MerchantStats {
  const mine = txns.filter((t) => t.merchantId === merchantId);
  const paid = mine.filter(isPaid);

  const revenue = paid.reduce((s, t) => s + t.amount, 0);
  const units = paid.reduce((s, t) => s + t.items.reduce((n, l) => n + l.quantity, 0), 0);

  const byDay = new Map<string, { revenue: number; orders: number }>();
  const byCat = new Map<string, { revenue: number; units: number }>();
  const byAttr: Record<Attribution, { revenue: number; units: number }> = {
    organic: { revenue: 0, units: 0 },
    cross_sell: { revenue: 0, units: 0 },
    upsell: { revenue: 0, units: 0 },
    revenue_agent: { revenue: 0, units: 0 },
  };
  const byProduct = new Map<string, { name: string; units: number; revenue: number }>();

  for (const t of paid) {
    const day = (t.paidAt ?? t.createdAt).slice(0, 10);
    const d = byDay.get(day) ?? { revenue: 0, orders: 0 };
    byDay.set(day, { revenue: d.revenue + t.amount, orders: d.orders + 1 });

    for (const l of t.items) {
      const cat = catalog.find((i) => i.item_id === l.productId)?.category ?? "other";
      const c = byCat.get(cat) ?? { revenue: 0, units: 0 };
      byCat.set(cat, { revenue: c.revenue + l.lineTotal, units: c.units + l.quantity });

      byAttr[l.attribution].revenue += l.lineTotal;
      byAttr[l.attribution].units += l.quantity;

      const p = byProduct.get(l.productId) ?? { name: l.productName, units: 0, revenue: 0 };
      byProduct.set(l.productId, { name: l.productName, units: p.units + l.quantity, revenue: p.revenue + l.lineTotal });
    }
  }

  return {
    merchantId,
    revenue,
    orders: paid.length,
    unitsSold: units,
    // Per order, not per unit: two orders of ₹450 average ₹450, not ₹900.
    averageOrderValue: paid.length === 0 ? 0 : Math.round(revenue / paid.length),
    awaitingPayment: mine.filter((t) => t.status === "awaiting_payment").length,
    delivered: mine.filter((t) => t.status === "delivered").length,
    revenueByDay: [...byDay.entries()].map(([day, v]) => ({ day, ...v })).sort((a, b) => (a.day < b.day ? 1 : -1)).slice(0, 14),
    revenueByCategory: [...byCat.entries()].map(([category, v]) => ({ category, ...v })).sort((a, b) => b.revenue - a.revenue),
    byAttribution: byAttr,
    topProducts: [...byProduct.entries()]
      .map(([productId, v]) => ({ productId, ...v }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 8),
    recent: mine.slice(0, 10),
  };
}

export interface ProductStats {
  productId: string;
  name: string;
  unitsSold: number;
  revenue: number;
  /** Orders that contained it — not the same as units, and routinely confused. */
  ordersContaining: number;
  averageSellingPrice: number;
  listPrice: number | null;
  currentStock: number;
  stockValue: number;
  /** Units a day over the window the sales actually span. */
  salesVelocity: number;
  /**
   * How long that window is, reported so the rate can be read honestly.
   *
   * Every sale in a fresh demo database lands within the same hour, which makes
   * a truthful velocity read "80 a day" off eighty sales in one afternoon. The
   * arithmetic is right and the impression is not, so the divisor travels with
   * the quotient and a caller can decline to show a rate measured over a day.
   */
  salesWindowDays: number;
  byAttribution: Record<Attribution, number>;
  recent: Array<{ transactionId: string; at: string; price: number; attribution: Attribution }>;
}

export function productStats(
  item: CatalogItem,
  txns: readonly Txn[],
  listPrice: number | null,
): ProductStats {
  const lines = txns
    .filter(isPaid)
    .flatMap((t) => t.items.filter((l) => l.productId === item.item_id).map((l) => ({ t, l })));

  const units = lines.reduce((s, { l }) => s + l.quantity, 0);
  const revenue = lines.reduce((s, { l }) => s + l.lineTotal, 0);
  const orders = new Set(lines.map(({ t }) => t.transactionId)).size;

  const times = lines.map(({ t }) => Date.parse(t.paidAt ?? t.createdAt)).filter(Number.isFinite);
  const spanDays = times.length > 1 ? Math.max(1, (Math.max(...times) - Math.min(...times)) / 86_400_000) : 1;

  const byAttr: Record<Attribution, number> = { organic: 0, cross_sell: 0, upsell: 0, revenue_agent: 0 };
  for (const { l } of lines) byAttr[l.attribution] += l.quantity;

  return {
    productId: item.item_id,
    name: item.name,
    unitsSold: units,
    revenue,
    ordersContaining: orders,
    // Per unit sold, so a discounted sale pulls it down as it should.
    averageSellingPrice: units === 0 ? 0 : Math.round((revenue / units) * 100) / 100,
    listPrice,
    currentStock: item.stock.quantity,
    stockValue: item.stock.quantity * item.price.value,
    salesVelocity: units === 0 ? 0 : Math.round((units / spanDays) * 100) / 100,
    salesWindowDays: units === 0 ? 0 : Math.round(spanDays * 10) / 10,
    byAttribution: byAttr,
    recent: lines
      .slice(0, 5)
      .map(({ t, l }) => ({ transactionId: t.transactionId, at: t.paidAt ?? t.createdAt, price: l.unitPrice, attribution: l.attribution })),
  };
}

/**
 * Does the data say what it claims to?
 *
 * Run in development and exposed on an endpoint, because a corrupted
 * transaction is worth an error rather than a plausible-looking dashboard. All
 * of these have been possible at some point in this codebase — a payment id
 * shared by eight sales was found exactly this way.
 */
export function checkIntegrity(txns: readonly Txn[], catalog: readonly CatalogItem[]): IntegrityFault[] {
  const faults: IntegrityFault[] = [];
  const known = new Set(catalog.map((i) => i.item_id));
  const seenPayments = new Map<string, string>();

  for (const t of txns) {
    const sum = t.items.reduce((s, l) => s + l.lineTotal, 0);
    if (sum !== t.amount) faults.push({ transactionId: t.transactionId, problem: `line totals sum to ₹${sum} but the transaction says ₹${t.amount}` });

    for (const l of t.items) {
      if (l.quantity <= 0) faults.push({ transactionId: t.transactionId, problem: `${l.productId} has quantity ${l.quantity}` });
      if (l.unitPrice < 0) faults.push({ transactionId: t.transactionId, problem: `${l.productId} has a negative unit price` });
      if (l.lineTotal !== l.quantity * l.unitPrice) faults.push({ transactionId: t.transactionId, problem: `${l.productId}: ₹${l.lineTotal} is not ${l.quantity} × ₹${l.unitPrice}` });
      if (!known.has(l.productId)) faults.push({ transactionId: t.transactionId, problem: `${l.productId} is not in any catalog` });
      else {
        const owner = catalog.find((i) => i.item_id === l.productId)!.merchant_id;
        if (owner !== t.merchantId) faults.push({ transactionId: t.transactionId, problem: `${l.productId} belongs to ${owner}, not ${t.merchantId}` });
      }
    }

    if (t.paymentId) {
      const prior = seenPayments.get(t.paymentId);
      if (prior) faults.push({ transactionId: t.transactionId, problem: `payment ${t.paymentId} is also on ${prior}` });
      else seenPayments.set(t.paymentId, t.transactionId);
    }
    if (isPaid(t) && !t.paidAt) faults.push({ transactionId: t.transactionId, problem: "counted as paid but has no payment time" });
  }
  return faults;
}


/* ── who the shop sells to ────────────────────────────────────────────────── */

export interface CustomerStats {
  buyerAgentId: string;
  name: string;
  orders: number;
  revenue: number;
  averageOrderValue: number;
  firstAt: string;
  lastAt: string;
  daysSinceLast: number;
  /** Share of the shop's takings, 0–1. */
  contribution: number;
  /** Bought more than once. The distinction the whole repeat story rests on. */
  repeat: boolean;
}

/**
 * Rank a shop's buyers by what they have actually spent.
 *
 * `nameFor` is passed rather than looked up here, because the ledger has no
 * business knowing that these particular buyers are demo data — it reads an
 * agent id off a signed mandate and asks the caller who that is. A shop with
 * real buyers would answer the same question from a different place.
 */
export function customerStats(
  merchantId: string,
  txns: readonly Txn[],
  nameFor: (agentId: string) => string | null,
  now: Date = new Date(),
): CustomerStats[] {
  const mine = txns.filter((t) => t.merchantId === merchantId && isPaid(t) && t.buyerAgentId);
  const total = mine.reduce((s, t) => s + t.amount, 0);

  const by = new Map<string, { orders: number; revenue: number; first: number; last: number }>();
  for (const t of mine) {
    const at = Date.parse(t.paidAt ?? t.createdAt);
    const cur = by.get(t.buyerAgentId!) ?? { orders: 0, revenue: 0, first: at, last: at };
    by.set(t.buyerAgentId!, {
      orders: cur.orders + 1,
      revenue: cur.revenue + t.amount,
      first: Math.min(cur.first, at),
      last: Math.max(cur.last, at),
    });
  }

  return [...by.entries()]
    .map(([id, v]) => ({
      buyerAgentId: id,
      name: nameFor(id) ?? id,
      orders: v.orders,
      revenue: v.revenue,
      averageOrderValue: Math.round(v.revenue / v.orders),
      firstAt: new Date(v.first).toISOString(),
      lastAt: new Date(v.last).toISOString(),
      daysSinceLast: Math.floor((now.getTime() - v.last) / 86_400_000),
      contribution: total === 0 ? 0 : v.revenue / total,
      repeat: v.orders > 1,
    }))
    .sort((a, b) => b.revenue - a.revenue);
}

/**
 * Buyers who used to come and have stopped.
 *
 * "Used to come" is doing real work: somebody who bought once, two months ago,
 * is not a lapsed regular — they are a passer-by, and putting them on a
 * win-back list wastes the shopkeeper's afternoon. So it takes more than one
 * previous order to count as having been a customer at all.
 */
export function lapsedCustomers(
  customers: readonly CustomerStats[],
  opts: { quietDays?: number; minOrders?: number } = {},
): CustomerStats[] {
  const quiet = opts.quietDays ?? 30;
  const minOrders = opts.minOrders ?? 2;
  return customers
    .filter((c) => c.daysSinceLast >= quiet && c.orders >= minOrders)
    .sort((a, b) => b.revenue - a.revenue);
}

export interface PeriodSummary {
  label: string;
  from: string;
  to: string;
  revenue: number;
  orders: number;
  units: number;
  averageOrderValue: number;
  customers: number;
  repeatCustomers: number;
  repeatShare: number;
}

/** Everything that happened between two instants, summarised once. */
export function summarise(
  merchantId: string,
  txns: readonly Txn[],
  from: Date,
  to: Date,
  label: string,
): PeriodSummary {
  const rows = txns.filter((t) => {
    if (t.merchantId !== merchantId || !isPaid(t)) return false;
    const at = Date.parse(t.paidAt ?? t.createdAt);
    return at >= from.getTime() && at < to.getTime();
  });

  const seen = new Map<string, number>();
  for (const t of rows) {
    if (!t.buyerAgentId) continue;
    seen.set(t.buyerAgentId, (seen.get(t.buyerAgentId) ?? 0) + 1);
  }
  const repeat = [...seen.values()].filter((n) => n > 1).length;
  const revenue = rows.reduce((s, t) => s + t.amount, 0);

  return {
    label,
    from: from.toISOString(),
    to: to.toISOString(),
    revenue,
    orders: rows.length,
    units: rows.reduce((s, t) => s + t.items.reduce((n, l) => n + l.quantity, 0), 0),
    averageOrderValue: rows.length === 0 ? 0 : Math.round(revenue / rows.length),
    customers: seen.size,
    repeatCustomers: repeat,
    repeatShare: seen.size === 0 ? 0 : repeat / seen.size,
  };
}

export interface Contributor {
  what: string;
  detail: string;
  /** Signed: negative pulled the total down. */
  change: number;
}

/**
 * What actually moved between two periods, biggest first.
 *
 * This is the function behind "why are sales down". It does not decide what the
 * answer is — it measures each dimension and hands back what changed, ordered
 * by how much. Whatever the assistant then says has to be one of these lines,
 * which is the difference between an explanation and a guess that sounds like
 * one. If nothing moved much, nothing is returned, and "nothing obvious
 * changed" is a true answer.
 */
export function contributors(
  now: PeriodSummary,
  before: PeriodSummary,
  opts: { products?: Array<{ name: string; now: number; before: number }> } = {},
): Contributor[] {
  const out: Contributor[] = [];
  const pct = (a: number, b: number) => (b === 0 ? (a === 0 ? 0 : 100) : Math.round(((a - b) / b) * 100));

  const orderChange = pct(now.orders, before.orders);
  if (Math.abs(orderChange) >= 5) {
    out.push({
      what: "how many orders",
      detail: `${now.orders} orders against ${before.orders} — ${Math.abs(orderChange)}% ${orderChange < 0 ? "fewer" : "more"}`,
      change: orderChange,
    });
  }

  const aovChange = pct(now.averageOrderValue, before.averageOrderValue);
  if (Math.abs(aovChange) >= 5) {
    out.push({
      what: "the size of each order",
      detail: `₹${now.averageOrderValue.toLocaleString("en-IN")} an order against ₹${before.averageOrderValue.toLocaleString("en-IN")}`,
      change: aovChange,
    });
  }

  const repeatChange = pct(now.repeatCustomers, before.repeatCustomers);
  if (Math.abs(repeatChange) >= 8) {
    out.push({
      what: "buyers coming back",
      detail: `${now.repeatCustomers} people bought more than once against ${before.repeatCustomers}`,
      change: repeatChange,
    });
  }

  const custChange = pct(now.customers, before.customers);
  if (Math.abs(custChange) >= 8) {
    out.push({
      what: "how many different buyers",
      detail: `${now.customers} buyers against ${before.customers}`,
      change: custChange,
    });
  }

  for (const p of opts.products ?? []) {
    const c = pct(p.now, p.before);
    if (Math.abs(c) >= 20 && Math.abs(p.now - p.before) > 500) {
      out.push({
        what: p.name,
        detail: `₹${Math.round(p.now).toLocaleString("en-IN")} against ₹${Math.round(p.before).toLocaleString("en-IN")}`,
        change: c,
      });
    }
  }

  return out.sort((a, b) => Math.abs(b.change) - Math.abs(a.change));
}
