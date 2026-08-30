/**
 * Milestone L — Razorpay webhook.
 *
 *   npm run milestone-l
 *
 * Definition of done: a signed payment.captured event transitions the
 * transaction; an unsigned or forged one is rejected — tamper test #9.
 */
import { createHmac } from "node:crypto";
import type { Server } from "node:http";
import { createApp } from "../src/server.js";
import { RazorpayGateway, type OrderRequest, type OrderResult, type PaymentGateway, type PaymentResult } from "../src/payments/gateway.js";

const g = (s: string) => `\x1b[32m${s}\x1b[0m`;
const r = (s: string) => `\x1b[31m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

const WEBHOOK_SECRET = "whsec_milestone_l";

function heading(t: string): void {
  console.log(`\n${bold(t)}\n${dim("─".repeat(t.length))}`);
}

/**
 * Behaves like Razorpay at both signed boundaries — Checkout and webhooks —
 * without needing live keys. Webhook verification is delegated to the real
 * RazorpayGateway so the code under test is the code that ships.
 */
class WebhookGateway implements PaymentGateway {
  readonly kind = "razorpay" as const;
  readonly requiresCheckout = true;
  private seq = 0;
  private readonly real = new RazorpayGateway("rzp_test_milestonel", "keysecret");

  async createOrder(req: OrderRequest): Promise<OrderResult> {
    this.seq++;
    return {
      order_id: `order_TESTL${String(this.seq).padStart(4, "0")}`,
      amount_paise: req.amount_paise,
      status: "created",
    };
  }
  verifyCheckoutSignature(): boolean {
    return false; // unused here — this milestone settles via the webhook
  }
  verifyWebhookSignature(rawBody: string, signature: string): boolean {
    return this.real.verifyWebhookSignature(rawBody, signature);
  }
  async capturePayment(order: OrderResult, paymentId?: string): Promise<PaymentResult> {
    return {
      payment_id: paymentId ?? "pay_TESTLmissing",
      order_id: order.order_id,
      amount_paise: order.amount_paise,
      status: "captured",
    };
  }
}

const sign = (body: string): string => createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");

async function main(): Promise<void> {
  process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;
  console.log(bold("\nVyapar-to-Agent · Milestone L — Razorpay webhook"));

  const { app, store } = await createApp({ gateway: new WebhookGateway() });
  const server: Server = await new Promise((res) => {
    const s = app.listen(0, () => res(s));
  });
  const port = (server.address() as { port: number }).port;
  const base = `http://localhost:${port}`;

  const api = async (p: string, init?: RequestInit) => {
    const res = await fetch(`${base}${p}`, {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  const postWebhook = async (raw: string, signature: string | null) => {
    const res = await fetch(`${base}/webhooks/razorpay`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(signature ? { "x-razorpay-signature": signature } : {}),
      },
      body: raw,
    });
    return { status: res.status, body: (await res.json()) as any };
  };

  try {
    heading("An order is opened, and waits");
    const { body: deal } = await api("/transactions", {
      method: "POST",
      body: JSON.stringify({ want: "blue cotton saree", max_price: 1500, opening_offer: 1100 }),
    });
    console.log(`  ${deal.status}  ${bold(deal.order_id)}  ${dim(`₹${deal.final_price}`)}`);
    const txn = deal.transaction_id;

    const event = (orderId: string, paymentId: string) =>
      JSON.stringify({
        event: "payment.captured",
        payload: { payment: { entity: { id: paymentId, order_id: orderId, status: "captured" } } },
      });

    const good = event(deal.order_id, "pay_TESTL0001");

    // ── Tamper test #9 ──────────────────────────────────────────────────────
    heading("Tamper test #9 — an unverified webhook must change nothing");
    const attacks: Array<[string, string, string | null]> = [
      ["no signature header at all", good, null],
      ["a forged signature", good, "0".repeat(64)],
      ["a valid signature for a different body", event(deal.order_id, "pay_ATTACKER"), sign(good)],
      // Must alter something the body actually contains — an earlier version of
      // this test edited a field that was not in the payload, so it signed and
      // submitted an unmodified body and "failed" by correctly succeeding.
      ["the order id swapped after signing", good.replace(deal.order_id, "order_ATTACKER"), sign(good)],
    ];

    let rejected = 0;
    for (const [name, body, signature] of attacks) {
      const res = await postWebhook(body, signature);
      const ok = res.status === 401;
      rejected += ok ? 1 : 0;
      console.log(`  ${ok ? g("✅ rejected") : r("❌ ACCEPTED")}  ${name} ${dim(`→ ${res.status}`)}`);
    }

    const midway = store.loadChain(txn);
    const untouched = !midway?.payment;
    console.log(
      `  ${untouched ? g("✅") : r("❌")} no payment mandate was written by any of them`,
    );

    // ── The genuine event ───────────────────────────────────────────────────
    heading("A genuine payment.captured");
    const accepted = await postWebhook(good, sign(good));
    console.log(`  ${accepted.status === 200 ? g("✅") : r("❌")} ${accepted.body.status ?? accepted.body.error} ${dim(accepted.body.payment_id ?? "")}`);

    const replay = await postWebhook(good, sign(good));
    const idempotent = replay.body.status === "already_settled";
    console.log(
      `  ${idempotent ? g("✅") : r("❌")} a retry of the same event settles nothing twice ` +
        `${dim("(Razorpay retries webhooks)")}`,
    );

    const { body: audit } = await api(`/transactions/${txn}/audit`);
    const stages = audit.timeline.filter((s: any) => s.present).length;
    console.log(`  ${audit.verified ? g("✅") : r("❌")} chain verifies with ${stages} mandates ${dim(`status ${audit.status}`)}`);

    heading("Milestone L — definition of done");
    const allRejected = rejected === attacks.length;
    const settled = accepted.status === 200 && accepted.body.status === "settled";
    console.log(`  ${allRejected ? g("✅") : r("❌")} forged/unsigned webhooks rejected: ${rejected}/${attacks.length}`);
    console.log(`  ${untouched ? g("✅") : r("❌")} rejected webhooks wrote nothing`);
    console.log(`  ${settled ? g("✅") : r("❌")} a signed payment.captured settles the transaction`);
    console.log(`  ${idempotent ? g("✅") : r("❌")} retries are idempotent`);
    console.log(`  ${audit.verified ? g("✅") : r("❌")} resulting chain verifies`);
    console.log();

    if (!allRejected || !untouched || !settled || !idempotent || !audit.verified) process.exitCode = 1;
  } finally {
    server.close();
    store.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
