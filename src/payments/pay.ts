import type { Keyring } from "../mandates/keys.js";
import { buildPaymentMandate, verifyChain, type MandateChain } from "../mandates/chain.js";
import { mandateHash } from "../mandates/sign.js";
import type { CartMandate, CatalogItem, IntentMandate, PaymentMandate } from "../mandates/schema.js";
import type { PaymentGateway } from "./gateway.js";

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
 * Stage 5 — pay for a signed cart.
 *
 * The ordering here is the whole point, and it is deliberately not a matter of
 * remembering to check first: verification happens, and only its result decides
 * whether `gateway` is ever called. Nothing above the throw touches the network.
 */
export async function payForCart(
  chain: MandateChain,
  item: CatalogItem,
  keyring: Keyring,
  gateway: PaymentGateway,
  opts: { paymentId?: string; now?: Date } = {},
): Promise<PayResult> {
  const now = opts.now ?? new Date();

  // Gate — verify signatures and hash links across everything issued so far.
  const report = await verifyChain(chain, keyring);
  const reasons = preflight(chain, item, report, now);
  if (reasons.length > 0) throw new PaymentRefused(reasons);

  const cart = chain.cart as CartMandate;
  const intent = chain.intent as IntentMandate;

  // Past this line the mandate is trusted, and only now does the gateway appear.
  const amountPaise = toPaise(cart.final_price.value);
  const order = await gateway.createOrder({
    amount_paise: amountPaise,
    currency: "INR",
    receipt: chain.transaction_id,
    notes: {
      item_id: cart.item_id,
      merchant_id: cart.merchant_id,
      buyer_agent_id: intent.buyer_agent_id,
      cart_mandate_hash: mandateHash(cart),
    },
  });

  const settled = await gateway.capturePayment(order, opts.paymentId);

  if (settled.amount_paise !== amountPaise) {
    throw new PaymentRefused([
      `gateway settled ${settled.amount_paise} paise against a cart for ${amountPaise}`,
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
