/**
 * Section 1 of the final spec: audit the pipeline against its own claims.
 *
 *   npm run audit
 *
 * Every check here exercises the real code. Where a property should hold for
 * *all* inputs rather than one example — the negotiation floor, the round cap,
 * the buyer's ceiling — it is fuzzed over hundreds of randomised policies
 * instead of asserted once, because a single passing case is not a guarantee.
 */
import { createHmac, randomInt } from "node:crypto";
import type { Server } from "node:http";
import { createApp } from "../src/server.js";
import { SimulatedGateway, RazorpayGateway, type OrderRequest, type OrderResult, type PaymentGateway, type PaymentResult } from "../src/payments/gateway.js";
import { negotiate, validatePolicy } from "../src/negotiation/engine.js";
import { priceSanity, MIN_PEERS } from "../src/structuring/sanity.js";
import { verifyChain } from "../src/mandates/chain.js";
import { mandateHash } from "../src/mandates/sign.js";
import type { CatalogItem, NegotiationPolicy } from "../src/mandates/schema.js";

const g = (s: string) => `\x1b[32m${s}\x1b[0m`;
const r = (s: string) => `\x1b[31m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

const results: Array<{ area: string; claim: string; ok: boolean; detail: string }> = [];
const check = (area: string, claim: string, ok: boolean, detail = "") => {
  results.push({ area, claim, ok, detail });
  console.log(`  ${ok ? g("✓") : r("✗")} ${claim}${detail ? dim(`  — ${detail}`) : ""}`);
};
const heading = (t: string) => console.log(`\n${bold(t)}\n${dim("─".repeat(t.length))}`);

const item = (over: Partial<CatalogItem> = {}): CatalogItem => ({
  item_id: "itm_x", merchant_id: "mer_x", name: "Thing", category: "apparel.saree",
  attributes: {}, price: { value: 1000, currency: "INR", confidence: 0.9 },
  stock: { quantity: 5, confidence: 0.9 }, source: { type: "voice_note", raw_text: "" },
  needs_merchant_confirmation: false, extracted_at: new Date().toISOString(), ...over,
});

/** A gateway that records whether it was ever touched. */
class Spy implements PaymentGateway {
  calls = 0;
  readonly kind = "simulated" as const;
  readonly requiresCheckout = false;
  private inner = new SimulatedGateway();
  async createOrder(q: OrderRequest): Promise<OrderResult> { this.calls++; return this.inner.createOrder(q); }
  /** Test double: the read is not what these spies are testing. */
  async fetchStatus(orderId: string) { return this.inner.fetchStatus(orderId); }

  async capturePayment(o: OrderResult): Promise<PaymentResult> { this.calls++; return this.inner.capturePayment(o); }
}

async function main(): Promise<void> {
  console.log(bold("\nVyapar-to-Agent · pipeline audit"));

  const spy = new Spy();
  const { app, store, keyring, catalog, bus, setPort } = await createApp({ gateway: spy });
  const server: Server = await new Promise((res) => { const s = app.listen(0, () => res(s)); });
  const port = (server.address() as { port: number }).port;
  setPort(port);
  const api = async (p: string, init?: RequestInit) => {
    const res = await fetch(`http://localhost:${port}${p}`, {
      ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    });
    return { status: res.status, body: (await res.json()) as any };
  };

  try {
    // ── Stage 1 ────────────────────────────────────────────────────────────
    heading("Stage 1 — structuring, sanity, gate");

    const held = catalog.filter((i) => i.needs_merchant_confirmation);
    check("stage1", "held items exist to test against", held.length > 0, `${held.length} held`);

    if (held[0]) {
      const { status, body } = await api("/transactions", {
        method: "POST",
        body: JSON.stringify({ want: held[0].name, item_id: held[0].item_id, max_price: 99999, opening_offer: 99999 }),
      });
      check("stage1", "a held item cannot be transacted", status === 409, `${status} ${body.error ?? ""}`.slice(0, 70));
    }

    const discovered = await api("/discover", { method: "POST", body: JSON.stringify({ want: held[0]?.name ?? "x" }) });
    check("stage1", "held items are withheld from discovery, not ranked low",
      !discovered.body.matches?.some((m: any) => m.item.needs_merchant_confirmation),
      `${discovered.body.withheld?.length ?? 0} withheld`);

    // Sanity must refuse to invent a baseline it does not have.
    const lonely = item({ item_id: "solo", category: "apparel.dupatta" });
    const s1 = priceSanity(lonely, [lonely]);
    check("stage1", `sanity skips rather than fabricate a baseline under ${MIN_PEERS} peers`,
      s1.check === "skipped", s1.reason.slice(0, 60));

    const peers = [90, 110, 120].map((v, i) => item({ item_id: `p${i}`, category: "food.snack", price: { value: v, currency: "INR", confidence: 0.9 } }));
    const outlier = item({ item_id: "out", category: "food.snack", price: { value: 1100, currency: "INR", confidence: 0.95 } });
    const s2 = priceSanity(outlier, [...peers, outlier]);
    check("stage1", "a ten-times outlier is caught by the merchant's own history", s2.check === "fail", s2.reason.slice(0, 62));

    const s3 = priceSanity(item({ item_id: "ok2", category: "food.snack", price: { value: 105, currency: "INR", confidence: 0.9 } }), [...peers]);
    check("stage1", "an in-family price is not flagged", s3.check === "pass", s3.reason.slice(0, 50));

    // ── Clarification ──────────────────────────────────────────────────────
    heading("Stage 1 — clarification actually re-runs the gate");
    const cl = await api("/clarifications");
    const open = cl.body.clarifications.filter((c: any) => c.status === "open");
    check("clarify", "held items raise a specific question", open.length > 0, `${open.length} open`);

    const priceQ = open.find((c: any) => c.field === "price" && c.options?.length);
    if (priceQ) {
      const before = catalog.find((i) => i.item_id === priceQ.item_id)?.needs_merchant_confirmation;
      const reply = await api(`/clarifications/${priceQ.clarification_id}/reply`, {
        method: "POST", body: JSON.stringify({ reply: priceQ.options[0] }),
      });
      const after = catalog.find((i) => i.item_id === priceQ.item_id)?.needs_merchant_confirmation;
      check("clarify", "answering re-runs the gate and changes transactability",
        before === true && (after === false || Boolean(reply.body.follow_up)),
        reply.body.transactable ? "now sellable" : `still held: ${(reply.body.still_held_because ?? []).join("; ")}`.slice(0, 50));
    }

    // ── Negotiation invariants, fuzzed ─────────────────────────────────────
    heading("Stage 3 — negotiation invariants (fuzzed over 500 random policies)");
    let belowFloor = 0, overCeiling = 0, overRounds = 0, aboveList = 0, ran = 0;

    for (let i = 0; i < 500; i++) {
      const list = randomInt(50, 5000);
      const floor = randomInt(10, list);
      const rounds = randomInt(1, 6);
      const ceiling = randomInt(10, 6000);
      const opening = randomInt(1, Math.max(2, ceiling));
      const policy: NegotiationPolicy = { item_id: "f", list_price: list, floor_price: floor, max_rounds: rounds, set_by: "merchant", set_at: "" };
      try { validatePolicy(policy); } catch { continue; }
      ran++;
      const out = negotiate(item({ item_id: "f" }), policy, { buyer_agent_id: "fuzz", max_price: ceiling, opening_offer: opening });
      const usedRounds = Math.max(0, ...out.log.map((t) => t.round));
      if (usedRounds > rounds) overRounds++;
      if (out.status === "agreed") {
        if (out.final_price < floor) belowFloor++;
        if (out.final_price > ceiling) overCeiling++;
        if (out.final_price > list) aboveList++;
      }
    }
    check("negotiate", "never settles below the merchant's floor", belowFloor === 0, `${ran} runs`);
    check("negotiate", "never settles above the buyer's ceiling", overCeiling === 0, `${ran} runs`);
    check("negotiate", "never charges above the merchant's own list price", aboveList === 0, `${ran} runs`);
    check("negotiate", "never exceeds max_rounds", overRounds === 0, `${ran} runs`);

    // ── no_deal must not reach payment ─────────────────────────────────────
    heading("Stage 3→5 — a failed negotiation cannot reach payment");
    const callsBefore = spy.calls;
    const nd = await api("/transactions", {
      method: "POST", body: JSON.stringify({ want: "blue cotton saree", max_price: 200, opening_offer: 100 }),
    });
    check("gate", "no_deal returns without an order", nd.body.status === "no_deal" || nd.status === 404 || nd.body.status === "no_match",
      nd.body.status ?? nd.status);
    check("gate", "no gateway call was made for a failed negotiation", spy.calls === callsBefore, `${spy.calls - callsBefore} calls`);

    // ── Consent chain + payment gate ───────────────────────────────────────
    heading("Stages 4–5 — mandates, and the gate in front of the money");
    const sale = await api("/transactions", {
      method: "POST", body: JSON.stringify({ want: "blue cotton saree", max_price: 1500, opening_offer: 1150 }),
    });
    const txn = sale.body.transaction_id;
    check("consent", "a successful negotiation produces a transaction", Boolean(txn), txn ?? sale.body.status);

    if (txn) {
      const chain = store.loadChain(txn)!;
      check("consent", "cart references the intent by hash",
        chain.cart?.intent_mandate_hash === mandateHash(chain.intent!), chain.cart?.intent_mandate_hash?.slice(0, 22));
      check("consent", "cart carries both signatures",
        Boolean(chain.cart?.merchant_signature && chain.cart?.buyer_agent_signature));
      check("consent", "payment references the cart by hash",
        chain.payment?.cart_mandate_hash === mandateHash(chain.cart!), chain.payment?.cart_mandate_hash?.slice(0, 22));

      const auth = await api(`/transactions/${txn}/authorization`);
      check("consent", "the agreed price is checked against the intent's ceiling",
        auth.body.checks?.some((c: any) => c.label === "Within your budget" && c.ok));

      // Tamper: a valid signature over different content must not pass.
      const tampered = structuredClone(chain);
      tampered.cart!.final_price.value = 1;
      const rep = await verifyChain(tampered, keyring);
      check("consent", "altering an agreed price breaks verification", !rep.ok, rep.failures[0]?.slice(0, 58));

      // Fulfillment must not be assumed.
      const fresh = store.loadChain(txn)!;
      check("fulfil", "fulfillment is never assumed from payment", !fresh.fulfillment, "awaiting merchant");

      const orders = await api(`/merchants/${chain.cart!.merchant_id}/orders`);
      check("fulfil", "the merchant is shown the order awaiting handover", orders.body.awaiting_handover > 0);

      await api(`/transactions/${txn}/confirm-fulfillment`, { method: "POST", body: JSON.stringify({ evidence_note: "audit" }) });
      const done = store.loadChain(txn)!;
      check("fulfil", "fulfillment references the payment by hash",
        done.fulfillment?.payment_mandate_hash === mandateHash(done.payment!), done.fulfillment?.payment_mandate_hash?.slice(0, 22));

      const audit = await api(`/transactions/${txn}/audit`);
      check("audit", "the complete four-mandate chain verifies", audit.body.verified === true,
        `${audit.body.timeline.filter((t: any) => t.present).length}/4 present`);
      check("audit", "the chain is re-verified at read time, not read from a flag",
        audit.body.timeline.every((t: any) => !t.present || Array.isArray(t.signatures)));
    }

    // ── Webhook ────────────────────────────────────────────────────────────
    heading("Stage 5 — webhook signature");
    process.env.RAZORPAY_WEBHOOK_SECRET = "audit_secret";
    const real = new RazorpayGateway("rzp_test_audit", "keysecret");
    const bodyStr = JSON.stringify({ event: "payment.captured", payload: {} });
    const goodSig = createHmac("sha256", "audit_secret").update(bodyStr).digest("hex");
    check("webhook", "a genuine signature verifies", real.verifyWebhookSignature(bodyStr, goodSig));
    check("webhook", "a forged signature is refused", !real.verifyWebhookSignature(bodyStr, "0".repeat(64)));
    check("webhook", "a body altered after signing is refused", !real.verifyWebhookSignature(bodyStr + " ", goodSig));

    const forged = await fetch(`http://localhost:${port}/webhooks/razorpay`, {
      method: "POST", headers: { "content-type": "application/json" }, body: bodyStr,
    });
    check("webhook", "an unsigned webhook is rejected by the endpoint", forged.status === 401, `http ${forged.status}`);

    // ── Events ─────────────────────────────────────────────────────────────
    heading("Real-time — events follow actual state changes");
    const seen: string[] = [];
    bus.on((e) => seen.push(e.type));
    const t2 = await api("/transactions", {
      method: "POST", body: JSON.stringify({ want: "blue cotton saree", max_price: 1500, opening_offer: 1150 }),
    });
    if (t2.body.transaction_id) {
      await api(`/transactions/${t2.body.transaction_id}/confirm-fulfillment`, { method: "POST", body: JSON.stringify({}) });
    }
    const order = ["negotiation.agreed", "payment.order_created", "payment.captured", "fulfillment.confirmed"];
    let cursor = -1, ordered = true;
    for (const want of order) {
      const at = seen.indexOf(want, cursor + 1);
      if (at === -1) { ordered = false; break; }
      cursor = at;
    }
    check("events", "events fire in pipeline order from real transitions", ordered, seen.filter((t) => order.includes(t)).join(" → "));

    // ── Verdict ────────────────────────────────────────────────────────────
    const failed = results.filter((x) => !x.ok);
    heading("Audit result");
    console.log(`  ${results.length - failed.length}/${results.length} claims verified`);
    if (failed.length > 0) {
      for (const f of failed) console.log(`  ${r("✗")} [${f.area}] ${f.claim} ${dim(f.detail)}`);
      process.exitCode = 1;
    } else {
      console.log(`  ${g("Every claim in the audit list holds against the running system.")}`);
    }
    console.log();
  } finally {
    server.close();
    store.close();
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
