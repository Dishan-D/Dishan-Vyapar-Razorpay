import Razorpay from "razorpay";
import { validatePaymentVerification, validateWebhookSignature } from "razorpay/dist/utils/razorpay-utils.js";

export interface OrderRequest {
  /** Razorpay works in currency subunits: ₹1100 is 110000 paise. */
  amount_paise: number;
  currency: "INR";
  /** Max 40 chars, unique — we use the transaction_id. */
  receipt: string;
  notes?: Record<string, string>;
}

export interface OrderResult {
  order_id: string;
  amount_paise: number;
  status: string;
}

export interface PaymentResult {
  payment_id: string;
  order_id: string;
  amount_paise: number;
  status: "captured" | "authorized" | "failed";
}

/**
 * What the gateway itself says about a transaction, asked at read time.
 *
 * Our own record is a signed claim that a payment happened. This is the other
 * side of it: Razorpay's answer about its own order, fetched now rather than
 * remembered. The two agreeing is worth far more than either alone, and a
 * demo that only ever shows its own bookkeeping cannot prove the money existed.
 */
export interface GatewayStatus {
  source: "razorpay" | "simulated";
  order_id: string;
  /** Razorpay's own order status: created | attempted | paid. */
  order_status: string;
  amount_paise: number;
  amount_paid_paise: number;
  payment_id: string | null;
  /** captured | authorized | failed | refunded | null when nothing has been paid. */
  payment_status: string | null;
  /** upi, card, netbanking … as Razorpay reports it. */
  method: string | null;
  /** Razorpay's own error, when a payment attempt failed. */
  error: string | null;
  fetched_at: string;
}

export interface PaymentGateway {
  readonly kind: "razorpay" | "simulated";
  /** Present only on gateways that sign their webhooks. */
  verifyWebhookSignature?(rawBody: string, signature: string): boolean;
  /**
   * True when a payment can only come from a real Checkout session in a browser.
   * Server-side code cannot conjure a payment_id, because there is nothing to
   * conjure: no card was entered and no UPI collect was approved.
   */
  readonly requiresCheckout: boolean;
  createOrder(req: OrderRequest): Promise<OrderResult>;
  /**
   * Confirm a Checkout callback really came from the gateway. Present only on
   * gateways that have a signature to check.
   */
  verifyCheckoutSignature?(orderId: string, paymentId: string, signature: string): boolean;
  /**
   * Settle a payment against an order.
   *
   * `paymentId` comes from Razorpay Checkout on the buyer's side. Server-side
   * code cannot conjure one — so a CLI run has no real payment to settle, and
   * only the frontend (Milestone F) exercises this end of the flow for real.
   */
  capturePayment(order: OrderResult, paymentId?: string): Promise<PaymentResult>;
  /** Ask the gateway what it currently believes about an order. */
  fetchStatus(orderId: string): Promise<GatewayStatus>;
}

/** Real Razorpay, test mode. Orders are genuinely created against the API. */
export class RazorpayGateway implements PaymentGateway {
  readonly kind = "razorpay" as const;
  readonly requiresCheckout = true;
  private readonly client: Razorpay;
  private readonly keySecret: string;

  constructor(readonly keyId: string, keySecret: string) {
    if (!keyId.startsWith("rzp_test_")) {
      // A live key here would move real money on a hackathon demo path.
      throw new Error(`Refusing to run with a non-test Razorpay key ("${keyId.slice(0, 12)}…")`);
    }
    this.client = new Razorpay({ key_id: keyId, key_secret: keySecret });
    this.keySecret = keySecret;
  }

  /**
   * HMAC-SHA256 of `order_id|payment_id` under the key secret, as Razorpay
   * Checkout returns it. Checked before the callback is believed at all: the
   * Payment Mandate is evidence, and signing one from an unverified browser
   * callback would put the platform's signature on a claim it never confirmed.
   */
  verifyCheckoutSignature(orderId: string, paymentId: string, signature: string): boolean {
    return validatePaymentVerification(
      { order_id: orderId, payment_id: paymentId },
      signature,
      this.keySecret,
    );
  }

  /**
   * A webhook is signed with its own secret over the raw request body — not the
   * key secret, and not over a reconstructed object. It must be checked against
   * the exact bytes received, because re-serialising the JSON first would let a
   * payload that differs only in whitespace or key order verify against a
   * signature computed for something else.
   */
  verifyWebhookSignature(rawBody: string, signature: string): boolean {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!secret) return false;
    try {
      return validateWebhookSignature(rawBody, signature, secret);
    } catch {
      return false;
    }
  }

  async createOrder(req: OrderRequest): Promise<OrderResult> {
    const order = await this.client.orders.create({
      amount: req.amount_paise,
      currency: req.currency,
      receipt: req.receipt,
      ...(req.notes ? { notes: req.notes } : {}),
    });
    return {
      order_id: order.id,
      amount_paise: Number(order.amount),
      status: String(order.status),
    };
  }

  /**
   * Razorpay's own view, fetched live.
   *
   * Reads the order and then the payments attached to it, so a failed attempt
   * is reported as a failed attempt rather than as silence. Nothing here is
   * inferred from our database — if Razorpay says the order is still
   * `created`, that is what comes back, even when we hold a payment mandate.
   * A disagreement is a real finding and must be visible, not smoothed over.
   */
  async fetchStatus(orderId: string): Promise<GatewayStatus> {
    const order = await this.client.orders.fetch(orderId);
    // The SDK types these, so no cast: a wrong assumption about the shape
    // should fail the build rather than at a judge's demo.
    const items = await this.client.orders
      .fetchPayments(orderId)
      .then((list) => list.items)
      .catch(() => []);
    // The captured one if there is one, else the most recent attempt — so a
    // failed attempt is reported as failed rather than as silence.
    const payment = items.find((x) => x.status === "captured") ?? items.at(-1) ?? null;
    return {
      source: "razorpay",
      order_id: String(order.id),
      order_status: String(order.status),
      amount_paise: Number(order.amount),
      amount_paid_paise: Number(order.amount_paid ?? 0),
      payment_id: payment ? String(payment.id) : null,
      payment_status: payment ? String(payment.status) : null,
      method: payment?.method ? String(payment.method) : null,
      error: payment?.error_description ? String(payment.error_description) : null,
      fetched_at: new Date().toISOString(),
    };
  }

  async capturePayment(order: OrderResult, paymentId?: string): Promise<PaymentResult> {
    if (!paymentId) {
      throw new Error(
        "No payment_id: a real capture needs a payment made through Razorpay Checkout. " +
          "Run the frontend flow, or use the simulated gateway for a CLI walkthrough.",
      );
    }
    const payment = await this.client.payments.fetch(paymentId);
    const status = String(payment.status);
    const settled =
      status === "captured"
        ? payment
        : await this.client.payments.capture(paymentId, order.amount_paise, "INR");

    return {
      payment_id: String(settled.id),
      order_id: order.order_id,
      amount_paise: Number(settled.amount),
      status: String(settled.status) as PaymentResult["status"],
    };
  }
}

/**
 * Stand-in gateway for CLI runs with no keys.
 *
 * Its ids are prefixed `sim_` rather than mimicking Razorpay's `order_`/`pay_`
 * format, so a simulated payment can never be mistaken for a real test-mode one
 * in a mandate, a log, or a screenshot.
 */
export class SimulatedGateway implements PaymentGateway {
  readonly kind = "simulated" as const;
  readonly requiresCheckout = false;
  private seq = 0;

  /**
   * Per-process, so ids cannot repeat across restarts.
   *
   * The counter alone did repeat: it resets to zero on every boot while the
   * database does not, so a store with a dozen payments held `sim_pay_0001`
   * eight times. A payment id is a reference — the thing a bank statement, a
   * refund and a dispute are all keyed on — and a repeated one silently makes
   * every lookup by it ambiguous. Reconciliation found this by reporting four
   * amount mismatches that did not exist: it had matched sales to the wrong
   * credits, because eight of them answered to the same name.
   */
  private readonly run = Math.random().toString(36).slice(2, 8);

  async createOrder(req: OrderRequest): Promise<OrderResult> {
    this.seq++;
    return {
      order_id: `sim_order_${this.run}${String(this.seq).padStart(4, "0")}`,
      amount_paise: req.amount_paise,
      status: "created",
    };
  }

  /**
   * The simulated rail has no upstream to ask, so it says so rather than
   * dressing its own memory up as a gateway's answer. `source: "simulated"` is
   * what the UI keys off to avoid ever labelling this as Razorpay's word.
   */
  async fetchStatus(orderId: string): Promise<GatewayStatus> {
    return {
      source: "simulated",
      order_id: orderId,
      order_status: "paid",
      amount_paise: 0,
      amount_paid_paise: 0,
      payment_id: `sim_pay_${orderId.replace("sim_order_", "")}`,
      payment_status: "captured",
      method: "simulated",
      error: null,
      fetched_at: new Date().toISOString(),
    };
  }

  async capturePayment(order: OrderResult): Promise<PaymentResult> {
    return {
      payment_id: `sim_pay_${order.order_id.replace("sim_order_", "")}`,
      order_id: order.order_id,
      amount_paise: order.amount_paise,
      status: "captured",
    };
  }
}

export function gatewayFromEnv(): PaymentGateway {
  const id = process.env.RAZORPAY_KEY_ID;
  const secret = process.env.RAZORPAY_KEY_SECRET;
  return id && secret ? new RazorpayGateway(id, secret) : new SimulatedGateway();
}

/** The Key ID is publishable — Checkout needs it in the browser. The secret never is. */
export function publishableKeyId(gateway: PaymentGateway): string | null {
  return gateway instanceof RazorpayGateway ? gateway.keyId : null;
}
