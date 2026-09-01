/**
 * Milestone D — negotiation → mandates → Razorpay test order → payment mandate.
 *
 *   npm run milestone-d    # simulated gateway unless RAZORPAY_KEY_ID/SECRET are set
 *
 * Definition of done: a full transaction from catalog query to captured payment
 * produces a 3-mandate chain that verifies under Milestone A's logic — and a
 * tampered cart never reaches the payment API at all.
 */
import { buildCartMandate, buildIntentMandate, verifyChain, type MandateChain } from "../src/mandates/chain.js";
import { Keyring } from "../src/mandates/keys.js";
import { discover } from "../src/catalog/discovery.js";
import { negotiate } from "../src/negotiation/engine.js";
import { templateLine } from "../src/negotiation/phrasing.js";
import { indexPolicies } from "../src/negotiation/policies.js";
import { runStructuring } from "../src/structuring/run.js";
import { SimulatedGateway, type OrderRequest, type OrderResult, type PaymentGateway, type PaymentResult } from "../src/payments/gateway.js";
import { authorizeCart, payForCart, settlePayment, PaymentRefused } from "../src/payments/pay.js";
import { createHmac } from "node:crypto";

const g = (s: string) => `\x1b[32m${s}\x1b[0m`;
const r = (s: string) => `\x1b[31m${s}\x1b[0m`;
const y = (s: string) => `\x1b[33m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

function heading(text: string): void {
  console.log(`\n${bold(text)}\n${dim("─".repeat(text.length))}`);
}

/**
 * Wraps a gateway and counts calls. The tamper test below asserts this stays at
 * zero — proving the refusal happened before the API, not after it.
 */
class SpyGateway implements PaymentGateway {
  calls = 0;
  readonly kind: PaymentGateway["kind"];
  readonly requiresCheckout: boolean;
  constructor(private readonly inner: PaymentGateway) {
    this.kind = inner.kind;
    this.requiresCheckout = inner.requiresCheckout;
  }
  verifyCheckoutSignature(orderId: string, paymentId: string, signature: string): boolean {
    return this.inner.verifyCheckoutSignature?.(orderId, paymentId, signature) ?? true;
  }
  async createOrder(req: OrderRequest): Promise<OrderResult> {
    this.calls++;
    return this.inner.createOrder(req);
  }
  /** Test double: the read is not what these spies are testing. */
  async fetchStatus(orderId: string) { return this.inner.fetchStatus(orderId); }

  async capturePayment(order: OrderResult, paymentId?: string): Promise<PaymentResult> {
    this.calls++;
    return this.inner.capturePayment(order, paymentId);
  }
}

/**
 * A gateway that behaves like Razorpay does at the Checkout boundary: it will
 * not settle without a payment id and a signature that verifies as
 * HMAC-SHA256("<order_id>|<payment_id>") under the key secret.
 *
 * This exists because the real Razorpay path cannot be exercised without live
 * test keys, and the callback-verification code is the most security-sensitive
 * thing added for it. Untested verification code is worse than none — it looks
 * like a check.
 */
class CheckoutGateway implements PaymentGateway {
  readonly kind = "razorpay" as const;
  readonly requiresCheckout = true;
  private seq = 0;
  constructor(private readonly secret: string) {}

  /** This double exists to exercise signature verification, not the read. */
  async fetchStatus(orderId: string) {
    return {
      source: "razorpay" as const, order_id: orderId, order_status: "paid",
      amount_paise: 0, amount_paid_paise: 0, payment_id: null, payment_status: null,
      method: null, error: null, fetched_at: new Date().toISOString(),
    };
  }

  async createOrder(req: OrderRequest): Promise<OrderResult> {
    this.seq++;
    return {
      order_id: `order_TEST${String(this.seq).padStart(4, "0")}`,
      amount_paise: req.amount_paise,
      status: "created",
    };
  }

  verifyCheckoutSignature(orderId: string, paymentId: string, signature: string): boolean {
    const expected = createHmac("sha256", this.secret).update(`${orderId}|${paymentId}`).digest("hex");
    return expected === signature;
  }

  async capturePayment(order: OrderResult, paymentId?: string): Promise<PaymentResult> {
    return {
      payment_id: paymentId ?? "pay_TESTmissing",
      order_id: order.order_id,
      amount_paise: order.amount_paise,
      status: "captured",
    };
  }
}

async function main(): Promise<void> {
  console.log(bold("\nVyapar-to-Agent · Milestone D — mandates and payment"));

  const keyring = await Keyring.generate();
  const structuring = await runStructuring(false);
  const policies = indexPolicies(structuring.policies);

  // The end-to-end leg runs simulated so it does not depend on .env; the real
  // Checkout boundary is covered separately by CheckoutGateway below.
  const gateway = new SimulatedGateway();

  heading("Gateway");
  console.log(`  ${y("simulated")} ${dim("— deliberately, so this proof does not depend on local .env")}`);
  console.log(`  ${dim("the real Checkout boundary is exercised further down")}`);

  // ── Stages 2–3 ────────────────────────────────────────────────────────────
  heading("Discovery and negotiation");
  const query = { want: "blue cotton saree", max_price: 1500 };
  const item = discover(structuring.items, query).matches[0]?.item;
  if (!item) throw new Error("no offerable match for the demo query");
  const policy = policies.get(item.item_id);
  if (!policy) throw new Error(`no negotiation policy for ${item.item_id}`);

  const buyer = { buyer_agent_id: "agent_xyz", max_price: query.max_price, opening_offer: 1100 };
  const outcome = negotiate(item, policy, buyer);
  for (const turn of outcome.log) console.log(`  ${dim(`r${turn.round}`)} ${templateLine(turn)}`);
  if (outcome.status !== "agreed") {
    console.log(`  ${r("negotiation ended without a deal — nothing to pay for")}`);
    process.exitCode = 1;
    return;
  }
  console.log(`  ${g("agreed")} ₹${outcome.final_price}`);

  // ── Stage 4 ───────────────────────────────────────────────────────────────
  heading("Consent chain");
  const transaction_id = `txn_${Date.now().toString(36)}`;
  const intent = await buildIntentMandate(
    {
      issuer: keyring.get("buyer_agent").kid,
      buyer_agent_id: buyer.buyer_agent_id,
      constraints: { max_price: buyer.max_price, category: "apparel.saree", ttl_seconds: 600 },
      prompt_playback: `Find a ${query.want} under ${query.max_price}`,
    },
    keyring,
  );
  const cart = await buildCartMandate(
    intent,
    {
      item_id: item.item_id,
      final_price: { value: outcome.final_price, currency: "INR" },
      merchant_id: item.merchant_id,
    },
    keyring,
  );
  console.log(`  ${g("✅")} intent mandate  ${dim("signed by buyer_agent")}`);
  console.log(`  ${g("✅")} cart mandate    ${dim("signed by merchant, then buyer_agent")}`);

  const chain: MandateChain = { transaction_id, intent, cart };

  // ── Stage 5 ───────────────────────────────────────────────────────────────
  heading("Payment");
  const spy = new SpyGateway(gateway);
  const paid = await payForCart(chain, item, keyring, spy, { paymentId: process.env.RAZORPAY_PAYMENT_ID });
  chain.payment = paid.payment;
  console.log(`  ${g("✅")} order   ${bold(paid.order_id)}`);
  console.log(`  ${g("✅")} payment ${bold(paid.payment_id)} ${dim(`(${paid.gateway})`)}`);
  console.log(`  ${g("✅")} payment mandate signed by platform`);

  // ── Verify with Milestone A's logic, unchanged ────────────────────────────
  heading("Chain verification");
  const report = await verifyChain(chain, keyring);
  for (const m of report.mandates.filter((x) => x.present)) {
    const sigs = m.signatures.map((s) => `${s.ok ? g("✅") : r("❌")} ${s.field.replace(/_signature$/, "")}`).join("  ");
    console.log(`  ${bold(m.type.padEnd(8))} ${m.link ? (m.link.ok ? g("✅ link") : r("❌ link")) : dim("— root")}  ${sigs}`);
  }
  console.log(`  ${dim("status:")} ${report.status}`);
  const chainOk = report.ok;
  console.log(chainOk ? `  ${g("CHAIN VERIFIED")}` : `  ${r("CHAIN REJECTED")} ${report.failures.join("; ")}`);

  // ── The gate, tested rather than asserted ─────────────────────────────────
  heading("Gate: a tampered cart must never reach the payment API");
  const checks: Array<[string, MandateChain, string]> = [];

  const repriced = structuredClone(chain);
  repriced.cart!.final_price.value = 100;
  delete repriced.payment;
  checks.push(["price lowered after both signatures", repriced, "signature"]);

  // Properly signed by both parties — nothing is tampered here. The cart is
  // simply for more than the Intent Mandate authorized, which is what the
  // authorization check exists for. Mutating a signed cart instead would only
  // re-test the signature check and leave this one unexercised.
  const overAuth: MandateChain = {
    transaction_id: `${transaction_id}_over`,
    intent,
    cart: await buildCartMandate(
      intent,
      {
        item_id: item.item_id,
        final_price: { value: 9999, currency: "INR" },
        merchant_id: item.merchant_id,
      },
      keyring,
    ),
  };
  checks.push(["validly signed cart above the buyer's authorization", overAuth, "authorization"]);

  const expired = structuredClone(chain);
  delete expired.payment;
  checks.push(["intent mandate past its TTL", expired, "ttl"]);

  let caught = 0;
  for (const [name, tampered, kind] of checks) {
    const guard = new SpyGateway(gateway);
    // The expired case needs a clock past the TTL; the others fail on content.
    const now = kind === "ttl" ? new Date(Date.now() + 601_000) : undefined;
    try {
      await payForCart(tampered, item, keyring, guard, now ? { now } : {});
      console.log(`  ${r("❌ PAID")}  ${name} ${r(`— gateway called ${guard.calls}×`)}`);
    } catch (err) {
      if (!(err instanceof PaymentRefused)) throw err;
      const clean = guard.calls === 0;
      caught += clean ? 1 : 0;
      console.log(
        `  ${clean ? g("✅ refused") : r("❌ refused too late")}  ${name} ` +
          `${dim(`gateway calls: ${guard.calls}`)}`,
      );
      console.log(`     ${dim(err.reasons[0] ?? "")}`);
    }
  }

  // ── The Checkout callback boundary ────────────────────────────────────────
  heading("Gate: a Checkout callback is not believed until it verifies");
  const secret = "test_secret_not_a_real_key";
  const checkout = new CheckoutGateway(secret);
  const coChain = structuredClone(chain);
  delete coChain.payment;
  const order = await authorizeCart(coChain, item, keyring, checkout);
  console.log(`  ${dim("authorized order")} ${order.order_id} ${dim("— no payment mandate issued yet")}`);

  const goodSig = createHmac("sha256", secret).update(`${order.order_id}|pay_TEST0001`).digest("hex");
  const callbacks: Array<[string, { razorpay_payment_id: string; razorpay_signature?: string }, boolean]> = [
    ["no signature at all", { razorpay_payment_id: "pay_TEST0001" }, false],
    ["a forged signature", { razorpay_payment_id: "pay_TEST0001", razorpay_signature: "0".repeat(64) }, false],
    [
      "a signature for a different payment",
      {
        razorpay_payment_id: "pay_TEST9999",
        razorpay_signature: goodSig,
      },
      false,
    ],
    ["the genuine callback", { razorpay_payment_id: "pay_TEST0001", razorpay_signature: goodSig }, true],
  ];

  let checkoutOk = 0;
  for (const [name, callback, shouldPass] of callbacks) {
    try {
      const settled = await settlePayment(coChain, item, keyring, checkout, order, callback);
      if (shouldPass) {
        checkoutOk++;
        console.log(`  ${g("✅ settled ")}  ${name} ${dim(`→ ${settled.payment_id}`)}`);
      } else {
        console.log(`  ${r("❌ SETTLED")}  ${name} ${r("— an unverified callback was believed")}`);
      }
    } catch (err) {
      if (!(err instanceof PaymentRefused)) throw err;
      if (shouldPass) {
        console.log(`  ${r("❌ refused")}  ${name} ${r(err.reasons[0] ?? "")}`);
      } else {
        checkoutOk++;
        console.log(`  ${g("✅ refused")}  ${name}`);
        console.log(`     ${dim(err.reasons[0] ?? "")}`);
      }
    }
  }

  heading("Milestone D — definition of done");
  console.log(`  ${chainOk ? g("✅") : r("❌")} 3-mandate chain verifies under Milestone A's logic`);
  console.log(`  ${caught === checks.length ? g("✅") : r("❌")} tampered carts refused before any API call: ${caught}/${checks.length}`);
  console.log(`  ${checkoutOk === callbacks.length ? g("✅") : r("❌")} checkout callbacks: ${checkoutOk}/${callbacks.length} handled correctly`);
  if (gateway.kind === "simulated") {
    console.log(`  ${y("⚠")}  order and payment ids are simulated — set Razorpay test keys for real ones`);
  }
  console.log();

  if (!chainOk || caught !== checks.length || checkoutOk !== callbacks.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
