import type { CatalogItem, NegotiationPolicy } from "../mandates/schema.js";
import type { Keyring } from "../mandates/keys.js";
import {
  buildIntentMandate, buildCartMandate, buildPaymentMandate, buildFulfillmentMandate,
} from "../mandates/chain.js";
import { negotiate } from "../negotiation/engine.js";
import { rngFor, around, chance, intBetween, weighted } from "./rng.js";
import { buyersFor, buyerOn, type DemoBuyer } from "./buyers.js";
import { storyFor, type Story } from "./stories.js";

/**
 * Six months of shop history, generated but not invented.
 *
 * The distinction is the whole point of this file. Every order below goes
 * through the **production negotiation engine** and comes out as four
 * **genuinely signed mandates**, backdated. So the history is synthetic in the
 * sense that these buyers never existed, and real in the sense that every price
 * in it is one the engine would actually have agreed to, every chain verifies,
 * and every figure the merchant screens derive from it is derived the same way
 * a figure from this afternoon's sale would be.
 *
 * The alternative — writing rows straight into a transactions table — would
 * have been an hour's work and would have quietly disconnected the dashboards
 * from the machinery they claim to summarise. The first time a price appeared
 * that the engine would have refused, the demo would be asserting something the
 * product cannot do.
 *
 * What the stories in `stories.ts` control is *demand*: how many buyers come,
 * when, who they are, and what they are drawn to. What happens when they arrive
 * is not up to this file.
 */

export interface GeneratedOrder {
  transaction_id: string;
  merchant_id: string;
  item_id: string;
  buyer_agent_id: string;
  buyer_name: string;
  at: Date;
  price: number;
  paid: boolean;
  delivered: boolean;
}

export interface GenerationResult {
  merchant_id: string;
  story: Story["kind"];
  headline: string;
  orders: GeneratedOrder[];
  buyers: DemoBuyer[];
  /** Rejected by the engine — kept as a count, because it is a real outcome. */
  noDeal: number;
}

const DAY_MS = 86_400_000;

/**
 * Where in the six months this day sits, as a month index 0…5.
 *
 * Fractional deliberately: a shop does not step up on the first of the month,
 * and a hard step shows up in a daily chart as a cliff nobody would believe.
 */
function monthWeight(story: Story, day: number, windowDays: number): number {
  const pos = (day / windowDays) * (story.monthly.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(story.monthly.length - 1, lo + 1);
  const t = pos - lo;
  return story.monthly[lo]! * (1 - t) + story.monthly[hi]! * t;
}

/** A product's own arc through the window, if the story gave it one. */
function arcWeight(story: Story, index: number, day: number, windowDays: number): number {
  const arc = story.arcs?.[String(index)];
  if (!arc) return 1;
  const pos = (day / windowDays) * (arc.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(arc.length - 1, lo + 1);
  const t = pos - lo;
  return arc[lo]! * (1 - t) + arc[hi]! * t;
}

export async function generateHistory(opts: {
  merchantId: string;
  items: readonly CatalogItem[];
  policies: ReadonlyMap<string, NegotiationPolicy>;
  keyring: Keyring;
  windowDays?: number;
  /** The last day of the window. Defaults to today. */
  until?: Date;
}): Promise<GenerationResult | null> {
  const story = storyFor(opts.merchantId);
  if (!story) return null;

  const windowDays = opts.windowDays ?? 182;
  const until = opts.until ?? new Date();
  const sellable = opts.items.filter(
    (i) => i.merchant_id === opts.merchantId && !i.needs_merchant_confirmation && i.price.value > 0,
  );
  if (sellable.length === 0) return null;

  const r = rngFor(`history:${opts.merchantId}`);
  const buyers = buyersFor(opts.merchantId, windowDays);
  const seen = new Set<string>();
  const orders: GeneratedOrder[] = [];
  let noDeal = 0;
  let n = 0;

  for (let day = 0; day < windowDays; day++) {
    const date = new Date(until.getTime() - (windowDays - 1 - day) * DAY_MS);
    // getDay() is 0=Sunday; the story's week starts on Monday.
    const dow = (date.getDay() + 6) % 7;

    let expected =
      story.perDay *
      monthWeight(story, day, windowDays) *
      story.week[dow]! *
      // Ordinary variation. Without it a daily chart is a smooth curve, which
      // no shopkeeper has ever seen and nobody believes.
      (0.72 + r() * 0.56);

    for (const e of story.events ?? []) {
      if (day >= e.from && day <= e.to) expected *= e.factor;
    }
    // A genuinely dead day now and then. Real weeks have them.
    if (chance(r, 0.035)) expected *= 0.25;

    const count = Math.max(0, Math.round(expected));
    const hours = Object.entries(story.hours).map(([h, w]) => [Number(h), w] as const);

    for (let k = 0; k < count; k++) {
      const buyer = buyerOn(r, buyers, day, story.repeatShare, seen);
      if (!buyer) continue;

      // What they are drawn to: the shop's own prices, tilted by any arc the
      // story gave a product. Cheaper things sell more often, which is why the
      // weight leans against price rather than being flat.
      const item = weighted(
        r,
        sellable.map((it, idx) => {
          const affordability = 1 / Math.max(1, Math.log10(Math.max(10, it.price.value)));
          return [it, affordability * arcWeight(story, idx, day, windowDays) * (0.6 + r() * 0.8)] as const;
        }),
      );

      const policy = opts.policies.get(item.item_id);
      if (!policy) continue;

      // A ceiling a real shopper might carry: usually close to the shelf price,
      // occasionally under it — which is what makes some of these fail.
      const ceiling = around(r, item.price.value * 1.0, item.price.value * 0.14,
        Math.round(item.price.value * 0.8), Math.round(item.price.value * 1.15));
      const opening = Math.round(ceiling * (0.82 + r() * 0.1));

      const outcome = negotiate(item, policy, {
        buyer_agent_id: buyer.agent_id,
        max_price: ceiling,
        opening_offer: opening,
      });
      if (outcome.status !== "agreed" || outcome.final_price === undefined) {
        noDeal++;
        continue;
      }

      const hour = weighted(r, hours);
      const at = new Date(date);
      at.setHours(hour, intBetween(r, 0, 59), intBetween(r, 0, 59), 0);

      /**
       * Never sell something in the future.
       *
       * The last day of the window is today, and a shop's evening hours are
       * weighted heavily — so on a morning run the generator cheerfully dated
       * orders at 6pm and the customer analytics reported buyers who had last
       * bought "-1 days ago". A negative age is the kind of number that makes
       * every figure beside it suspect.
       */
      if (at.getTime() > until.getTime()) continue;

      /**
       * Whether the money arrived, and whether the goods did.
       *
       * The collection story lives here: `unpaidShare` rises through the window
       * for the shop whose problem is collection, so "outstanding payments have
       * grown" is something the transactions say rather than something a
       * caption asserts.
       */
      const drift = story.kind === "collection_problem" ? 0.55 + (day / windowDays) * 0.9 : 1;
      const paid = !chance(r, story.unpaidShare * drift);
      // Handover is only ever pending on recent orders — a shopkeeper does not
      // leave a five-month-old sale unconfirmed.
      const recent = windowDays - day < 12;
      const delivered = paid && !(recent && chance(r, story.unconfirmedShare * 3));

      seen.add(buyer.agent_id);
      orders.push({
        transaction_id: `txn_h${day.toString(36)}${(n++).toString(36)}${opts.merchantId.slice(4, 8)}`,
        merchant_id: opts.merchantId,
        item_id: item.item_id,
        buyer_agent_id: buyer.agent_id,
        buyer_name: buyer.name,
        at,
        price: outcome.final_price,
        paid,
        delivered,
      });
    }
  }

  return { merchant_id: opts.merchantId, story: story.kind, headline: story.headline, orders, buyers, noDeal };
}

/**
 * Turn a generated order into the four signed mandates and store them.
 *
 * The same builders the live pipeline uses, with `issued_at` set back in time —
 * an override the chain module already supported, because a mandate's timestamp
 * has always been part of what is signed rather than a column written beside it.
 */
export async function persistOrder(
  order: GeneratedOrder,
  item: CatalogItem,
  keyring: Keyring,
  store: {
    createTransaction(row: { transaction_id: string; item_id: string; merchant_id: string; buyer_agent_id: string }): void;
    appendMandate(id: string, m: never): void;
    recordAttribution(id: string, a: string): void;
  },
): Promise<void> {
  const iso = order.at.toISOString();

  const intent = await buildIntentMandate(
    {
      issuer: keyring.get("buyer_agent").kid,
      buyer_agent_id: order.buyer_agent_id,
      constraints: {
        max_price: Math.max(order.price, item.price.value),
        category: item.category,
        ttl_seconds: 600,
      },
      prompt_playback: `${item.name} for ${order.buyer_name}`,
      issued_at: iso,
    },
    keyring,
  );

  const cart = await buildCartMandate(
    intent,
    {
      item_id: order.item_id,
      final_price: { value: order.price, currency: "INR" },
      merchant_id: order.merchant_id,
      issued_at: iso,
    },
    keyring,
  );

  store.createTransaction({
    transaction_id: order.transaction_id,
    item_id: order.item_id,
    merchant_id: order.merchant_id,
    buyer_agent_id: order.buyer_agent_id,
  });
  store.appendMandate(order.transaction_id, intent as never);
  store.appendMandate(order.transaction_id, cart as never);

  if (!order.paid) return;

  // Payment lands minutes after the price is agreed, not instantly.
  const paidAt = new Date(order.at.getTime() + intBetween(rngFor(order.transaction_id), 20, 400) * 1000);
  const payment = await buildPaymentMandate(
    cart,
    {
      razorpay_order_id: `order_demo${order.transaction_id.slice(5, 15)}`,
      razorpay_payment_id: `sim_pay_demo${order.transaction_id.slice(5, 15)}`,
      amount: order.price,
      currency: "INR",
      status: "captured",
      issued_at: paidAt.toISOString(),
    },
    keyring,
  );
  store.appendMandate(order.transaction_id, payment as never);
  store.recordAttribution(order.transaction_id, "organic");

  if (!order.delivered) return;

  const doneAt = new Date(paidAt.getTime() + intBetween(rngFor(`f${order.transaction_id}`), 600, 36_000) * 1000);
  const fulfillment = await buildFulfillmentMandate(
    payment,
    {
      confirmed_by: "merchant",
      evidence_note: null,
      evidence_photo_ref: null,
      confirmed_at: doneAt.toISOString(),
    },
    keyring,
  );
  store.appendMandate(order.transaction_id, fulfillment as never);
}
