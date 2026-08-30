import Razorpay from "razorpay";

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

export interface PaymentGateway {
  readonly kind: "razorpay" | "simulated";
  createOrder(req: OrderRequest): Promise<OrderResult>;
  /**
   * Settle a payment against an order.
   *
   * `paymentId` comes from Razorpay Checkout on the buyer's side. Server-side
   * code cannot conjure one — so a CLI run has no real payment to settle, and
   * only the frontend (Milestone F) exercises this end of the flow for real.
   */
  capturePayment(order: OrderResult, paymentId?: string): Promise<PaymentResult>;
}

/** Real Razorpay, test mode. Orders are genuinely created against the API. */
export class RazorpayGateway implements PaymentGateway {
  readonly kind = "razorpay" as const;
  private readonly client: Razorpay;

  constructor(keyId: string, keySecret: string) {
    if (!keyId.startsWith("rzp_test_")) {
      // A live key here would move real money on a hackathon demo path.
      throw new Error(`Refusing to run with a non-test Razorpay key ("${keyId.slice(0, 12)}…")`);
    }
    this.client = new Razorpay({ key_id: keyId, key_secret: keySecret });
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
  private seq = 0;

  async createOrder(req: OrderRequest): Promise<OrderResult> {
    this.seq++;
    return {
      order_id: `sim_order_${String(this.seq).padStart(4, "0")}`,
      amount_paise: req.amount_paise,
      status: "created",
    };
  }

  async capturePayment(order: OrderResult): Promise<PaymentResult> {
    return {
      payment_id: `sim_pay_${order.order_id.slice(-4)}`,
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
