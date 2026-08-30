import type { Keyring } from "../mandates/keys.js";
import { buildPaymentMandate, verifyChain, type MandateChain } from "../mandates/chain.js";
import { mandateHash } from "../mandates/sign.js";
import type { CartMandate, CatalogItem, IntentMandate, PaymentMandate } from "../mandates/schema.js";
import type { OrderResult, PaymentGateway } from "./gateway.js";

export class PaymentRefused extends Error {
  constructor(readonly reasons: string[]) {
    super(`Payment refused before any gateway call: ${reasons.join("; ")}`);
    this.name = "PaymentRefused";
  }
}

export interface PayResult {
  payment: PaymentMandate;
  order_id: string;
  payment_id: string;
  gateway: PaymentGateway["kind"];
}

export const toPaise = (rupees: number): number => Math.round(rupees * 100);

/**
 * Everything that must be true before money moves.
 *
 * Signature validity is necessary but not sufficient: a perfectly signed cart
 * can still exceed what the buyer's Intent Mandate authorized, name a different
 * item's category, or arrive after its own authorization expired. All of it is
 * checked here, and all of it before the gateway exists in this function's world.
 */
function preflight(
  chain: MandateChain,
  item: CatalogItem,
  chainOk: { ok: boolean; failures: string[] },
  now: Date,
): string[] {
  const reasons: string[] = [];
  const intent = chain.intent;
  const cart = chain.cart;

  if (!intent) return ["no intent mandate on this transaction"];
  if (!cart) return ["no cart mandate on this transaction"];

  if (!chainOk.ok) reasons.push(...chainOk.failures);

  if (cart.intent_mandate_hash !== mandateHash(intent)) {
    reasons.push("cart mandate does not reference this intent mandate");
  }

  const price = cart.final_price.value;
  if (price > intent.constraints.max_price) {
    reasons.push(
      `agreed ₹${price} exceeds the ₹${intent.constraints.max_price} the buyer-agent was authorized to spend`,
    );
  }
  if (price <= 0) reasons.push(`agreed price ₹${price} is not payable`);

  if (cart.item_id !== item.item_id) {
    reasons.push(`cart names ${cart.item_id} but ${item.item_id} was supplied for validation`);
  }
  if (!item.category.startsWith(intent.constraints.category)) {
    reasons.push(
      `item category "${item.category}" is outside the intent's "${intent.constraints.category}"`,
    );
  }

  const issued = Date.parse(intent.issued_at);
  const ageSeconds = (now.getTime() - issued) / 1000;
  if (!Number.isFinite(issued)) {
    reasons.push("intent mandate has an unparseable issued_at");
  } else if (ageSeconds > intent.constraints.ttl_seconds) {
    reasons.push(
      `intent mandate expired ${Math.round(ageSeconds - intent.constraints.ttl_seconds)}s ago ` +
        `(ttl ${intent.constraints.ttl_seconds}s)`,
    );
  }

  if (item.needs_merchant_confirmation) {
    reasons.push(`item ${item.item_id} is still awaiting merchant confirmation`);
  }

  return reasons;
}

/**
 * Stage 5a — authorize a signed cart and open an order.
 *
 * The ordering here is the whole point, and it is deliberately not a matter of
 * remembering to check first: verification happens, and only its result decides
 * whether `gateway` is ever called. Nothing above the throw touches the network.
 *
 * No Payment Mandate is issued here. An order is a request to be paid, not a
 * payment — signing a mandate at this point would assert a capture that has not
 * happened.
 */
export async function authorizeCart(
  chain: MandateChain,
  item: CatalogItem,
  keyring: Keyring,
  gateway: PaymentGateway,
  opts: { now?: Date } = {},
): Promise<OrderResult> {
  const report = await verifyChain(chain, keyring);
  const reasons = preflight(chain, item, report, opts.now ?? new Date());
  if (reasons.length > 0) throw new PaymentRefused(reasons);

  const cart = chain.cart as CartMandate;
  const intent = chain.intent as IntentMandate;

  // Past this line the mandate is trusted, and only now does the gateway appear.
  return gateway.createOrder({
    amount_paise: toPaise(cart.final_price.value),
    currency: "INR",
    receipt: chain.transaction_id,
    notes: {
      item_id: cart.item_id,
      merchant_id: cart.merchant_id,
      buyer_agent_id: intent.buyer_agent_id,
      cart_mandate_hash: mandateHash(cart),
    },
  });
}

export interface CheckoutCallback {
  razorpay_payment_id: string;
  razorpay_signature?: string;
}

/**
 * Stage 5b — settle a payment against an authorized order and issue the mandate.
 *
 * The whole gate runs again rather than trusting that authorizeCart already
 * passed. In a two-phase flow the chain can be swapped between the calls, and
 * "we checked a moment ago" is not a property of the object in front of us.
 *
 * On a gateway that requires Checkout, the browser's callback is verified before
 * any of it is believed. An unsigned or badly signed callback is refused rather
 * than trusted, because everything downstream of here gets the platform's
 * signature on it.
 */
export async function settlePayment(
  chain: MandateChain,
  item: CatalogItem,
  keyring: Keyring,
  gateway: PaymentGateway,
  order: OrderResult,
  callback: CheckoutCallback | undefined,
  opts: { now?: Date } = {},
): Promise<PayResult> {
  const report = await verifyChain(chain, keyring);
  const reasons = preflight(chain, item, report, opts.now ?? new Date());
  if (reasons.length > 0) throw new PaymentRefused(reasons);

  const cart = chain.cart as CartMandate;
  const amountPaise = toPaise(cart.final_price.value);

  if (order.amount_paise !== amountPaise) {
    throw new PaymentRefused([
      `order ${order.order_id} is for ${order.amount_paise} paise but the cart says ${amountPaise}`,
    ]);
  }

  if (gateway.requiresCheckout) {
    if (!callback?.razorpay_payment_id || !callback.razorpay_signature) {
      throw new PaymentRefused([
        "this gateway settles only through Razorpay Checkout — a payment id and its signature are required",
      ]);
    }
    const genuine = gateway.verifyCheckoutSignature?.(
      order.order_id,
      callback.razorpay_payment_id,
      callback.razorpay_signature,
    );
    if (!genuine) {
      throw new PaymentRefused(["Razorpay checkout signature did not verify"]);
    }
  }

  const settled = await gateway.capturePayment(order, callback?.razorpay_payment_id);

  if (settled.amount_paise !== amountPaise) {
    throw new PaymentRefused([
      `gateway settled ${settled.amount_paise} paise against a cart for ${amountPaise}`,
    ]);
  }
  if (settled.order_id !== order.order_id) {
    throw new PaymentRefused([
      `gateway settled against order ${settled.order_id}, not the authorized ${order.order_id}`,
    ]);
  }

  const payment = await buildPaymentMandate(
    cart,
    {
      razorpay_order_id: settled.order_id,
      razorpay_payment_id: settled.payment_id,
      amount: cart.final_price.value,
      currency: "INR",
      status: settled.status === "captured" ? "captured" : "created",
    },
    keyring,
  );

  return { payment, order_id: settled.order_id, payment_id: settled.payment_id, gateway: gateway.kind };
}

/**
 * Both phases in one call — only usable on a gateway that does not require a
 * browser Checkout. The CLI walkthrough and the milestone scripts use this.
 */
export async function payForCart(
  chain: MandateChain,
  item: CatalogItem,
  keyring: Keyring,
  gateway: PaymentGateway,
  opts: { paymentId?: string; now?: Date } = {},
): Promise<PayResult> {
  const order = await authorizeCart(chain, item, keyring, gateway, opts);
  const callback = opts.paymentId ? { razorpay_payment_id: opts.paymentId } : undefined;
  return settlePayment(chain, item, keyring, gateway, order, callback, opts);
}
