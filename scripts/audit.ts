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
import { pointsAtButton, claimsPurchaseDone } from "../src/agent/buyerloop.js";
import { RateGovernor, RateBudgetExceeded } from "../src/llm/ratelimit.js";
import { normaliseKey, normaliseAttributes, valuesAgree } from "../src/mandates/authority.js";
import { readProbe } from "../src/payments/razorpay-extras.js";
import { describeThrown } from "../src/payments/gateway.js";
import { route } from "../src/agent/supervisor.js";
import { MERCHANT_TOOLS } from "../src/agent/merchant-tools.js";
import * as merchantActions from "../src/merchant/actions.js";
import { rngFor } from "../src/demo/rng.js";
import { buyersFor } from "../src/demo/buyers.js";
import { customerStats, lapsedCustomers, summarise, contributors } from "../src/analytics/ledger.js";
import { readUpiUri } from "../src/merchant/upi-qr.js";

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
      method: "POST", body: JSON.stringify({ want: "a product priced far above this", max_price: 5, opening_offer: 2 }),
    });
    check("gate", "no_deal returns without an order", nd.body.status === "no_deal" || nd.status === 404 || nd.body.status === "no_match",
      nd.body.status ?? nd.status);
    check("gate", "no gateway call was made for a failed negotiation", spy.calls === callsBefore, `${spy.calls - callsBefore} calls`);

    /**
     * The product these checks run against is taken from the live catalog
     * rather than named here.
     *
     * This used to say "blue cotton saree", which was true of one particular
     * seed and became false the moment the demo data changed — four claims
     * failed for want of a product, not for want of a working pipeline. An
     * audit that breaks when the fixtures change is testing the fixtures.
     */
    const shelf = await api("/catalog");
    const buyable = (shelf.body.items ?? []).filter(
      (i: any) => i.transactable && i.stock?.quantity > 0 && i.price?.value > 0,
    );
    const subject = buyable.sort((a: any, b: any) => b.stock.quantity - a.stock.quantity)[0];
    if (!subject) throw new Error("no buyable product in the catalog to audit against");
    const want = subject.name;
    const ceiling = Math.round(subject.price.value * 1.25);
    const opening = Math.round(subject.price.value * 0.95);

    // ── Consent chain + payment gate ───────────────────────────────────────
    heading("Stages 4–5 — mandates, and the gate in front of the money");
    const sale = await api("/transactions", {
      method: "POST", body: JSON.stringify({ want, max_price: ceiling, opening_offer: opening }),
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

    /**
     * A gateway failure has to say what went wrong.
     *
     * The Razorpay SDK rejects with a plain object, not an Error, so the usual
     * `String(err)` renders it as "[object Object]" — which is what a webhook
     * failure actually returned: no status, no code, nothing to look up. And
     * Razorpay retries a webhook that does not return 2xx, so an unreadable
     * failure is one that repeats silently.
     */
    const sdkShape = { statusCode: 400, error: { code: "BAD_REQUEST_ERROR", description: "The id provided does not exist" } };
    const said = describeThrown(sdkShape);
    check("webhook", "a Razorpay SDK failure is legible, not [object Object]",
      said.includes("400") && said.includes("BAD_REQUEST_ERROR") && said.includes("does not exist"), said);
    check("webhook", "a plain Error still reports its own message",
      describeThrown(new Error("something specific")) === "something specific", "");

    // ── Events ─────────────────────────────────────────────────────────────
    heading("Real-time — events follow actual state changes");
    const seen: string[] = [];
    bus.on((e) => seen.push(e.type));
    const t2 = await api("/transactions", {
      method: "POST", body: JSON.stringify({ want, max_price: ceiling, opening_offer: opening }),
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

    // ── Agent honesty ──────────────────────────────────────────────────────
    heading("Agent honesty — the guards in front of what it says");

    /**
     * These are pure functions, so they are checked directly rather than by
     * coaxing a model into the failure. Each line below is a real thing a model
     * said in this project, not an invented example.
     */
    const sendsToButton = [
      // The one that got through: the button named after the action, not its
      // label, so a guard anchored on the word "confirm" never saw it.
      "Set — the Chocolate Cookie from Ganesh Tea & Coffee at ₹80 is ready. Tap the Pay ₹80 button when you're good to go.",
      "Press Confirm when ready.",
      "Hit the Buy button to go ahead.",
      "It is ready — press the button below.",
    ];
    const sendsNowhere = [
      // Add to cart really is on every shelf card, so pointing there is honest.
      "Tap Add to cart on the card if you want it in the basket.",
      "The Chocolate Cookie is ₹80 at Ganesh Tea & Coffee, 26 in stock.",
      "Say the word and I'll search the chocolate cookie again.",
    ];
    check("agent", "every way of naming a button is caught, not just \"confirm\"",
      sendsToButton.every(pointsAtButton), `${sendsToButton.length} phrasings`);
    check("agent", "an answer that names no button is left alone",
      sendsNowhere.every((l) => !pointsAtButton(l)), `${sendsNowhere.length} phrasings`);
    check("agent", "a claimed purchase is caught however it is phrased",
      ["Your order is confirmed.", "Done — purchased.", "It is ready and confirmed."].every(claimsPurchaseDone),
      "3 phrasings");
    check("agent", "preparing a purchase is not mistaken for completing one",
      !claimsPurchaseDone("It is ready for you to confirm.") &&
      !claimsPurchaseDone("Press Confirm and I will send the agent."),
      "the infinitive stays allowed");

    // An interactive call must give up inside the time its caller allowed.
    // Before this was a whole-call deadline it was a per-attempt one, and a
    // shopper's question was measured taking 218 seconds to come back.
    {
      const gov = new RateGovernor();
      const always429 = () =>
        Promise.reject(Object.assign(new Error("429"), {
          status: 429,
          headers: { get: (n: string) => (n === "retry-after" ? "10s" : null) },
        }));
      const began = Date.now();
      let threw = false;
      try {
        await gov.run(1000, always429 as never, { maxWaitSeconds: 12 });
      } catch (err) {
        threw = err instanceof RateBudgetExceeded;
      }
      const took = (Date.now() - began) / 1000;
      check("agent", "a rate-limited answer gives up inside the time the caller allowed",
        threw && took <= 13, `gave up after ${took.toFixed(1)}s of an allowed 12s`);
    }

    /**
     * A shop that answered the question is never told it did not.
     *
     * The gate compares two vocabularies that were written independently — the
     * shopkeeper's and the model's — and a mismatch between them refuses a sale
     * for a reason that is not true. Every pair below has been observed: the
     * catalog says flavour, the parser says flavor, and a chocolate cake was
     * ruled out with "the shop did not state a flavor".
     */
    {
      const shopSays = normaliseAttributes({
        flavour: "chocolate", weight: "1kg", serves: "8-10", colour: "red", scent: "jasmine",
      });
      const asked: Array<[string, string]> = [
        ["flavor", "chocolate"], ["flavour", "chocolate"], ["taste", "chocolate"],
        ["color", "red"], ["colour", "red"],
        ["weight", "1kg"], ["servings", "8-10"], ["fragrance", "jasmine"],
      ];
      const missed = asked.filter(([k, want]) => {
        const have = shopSays[normaliseKey(k)];
        return !(have && valuesAgree(want, have));
      });
      check("agent", "the shopper's word and the shopkeeper's word reach the same fact",
        missed.length === 0,
        missed.length === 0 ? `${asked.length} spellings` : missed.map(([k]) => k).join(", "));
    }

    /**
     * A capability probe says whose problem a failure is.
     *
     * Razorpay refuses a product the account has not enabled with 400 "The
     * requested URL was not found on the server", which read as though we had
     * called a wrong URL. A wrong URL is answered 404 by the gateway in front of
     * the API, and the panel must not report the two the same way.
     */
    {
      const notEnabled = readProbe("/payments/qr_codes", {
        status: 400,
        body: { error: { code: "BAD_REQUEST_ERROR", description: "The requested URL was not found on the server." } },
      });
      const wrongPath = readProbe("/nope", { status: 404, body: {} });
      const enabled = readProbe("/settlements", { status: 200, body: {} });

      check("razorpay", "a product the account has not enabled is not reported as a bad call",
        notEnabled[0] === "unavailable" && /not activated on the account/.test(notEnabled[1]),
        notEnabled[0]);
      check("razorpay", "a genuinely wrong path is owned rather than blamed on the account",
        wrongPath[0] === "unknown" && /wrong on our side/.test(wrongPath[1]),
        wrongPath[0]);
      check("razorpay", "an enabled product still reads as real", enabled[0] === "real", enabled[0]);
    }

    // ── Merchant assistant ─────────────────────────────────────────────────
    heading("Merchant assistant — routing, and knowing what it does not have");

    /**
     * A shopkeeper's phrasing has to reach the right lookup without a model.
     *
     * Every line is how the question actually gets typed, not how the tool is
     * named. Three of these were misrouted when first written — "any
     * suggestions" could not match a pattern ending in `suggestion\b`, and
     * "what can't agents buy" has two words between "can't" and "buy".
     */
    const routes: Array<[string, string]> = [
      ["How did I do today?", "get_sales"],
      ["how much did I make yesterday", "get_sales"],
      ["Who hasn't paid me?", "get_pending_payments"],
      ["who owes me money", "get_pending_payments"],
      ["What are my best sellers?", "get_product_performance"],
      ["any suggestions", "get_opportunities"],
      ["what can't agents buy yet", "list_products"],
      ["does my bank match my sales", "get_reconciliation"],
      ["what is my UPI id", "get_payment_setup"],
      ["show me my orders", "get_orders"],
      ["which of those havent sold at all", "get_product_performance"],

      /**
       * Spoken, not typed.
       *
       * Speech recognition hands over lowercase text with no punctuation and
       * no apostrophes, and people say things differently from how they write
       * them — "whats my top product", not "which products are selling the
       * most". Twelve of these fell through to the generic path on the first
       * pass and were answered with today's takings, which is a real number
       * and the wrong answer.
       */
      ["how are we doing", "get_sales"],
      ["is business good", "get_sales"],
      ["tell me about today", "get_sales"],
      ["whos my biggest customer", "get_customers"],
      ["any regulars i should know about", "get_customers"],
      ["anyone stopped buying", "get_lapsed_customers"],
      ["who used to come but doesnt anymore", "get_lapsed_customers"],
      ["am i owed any money", "get_pending_payments"],
      ["what sells best", "get_product_performance"],
      ["anything not moving", "get_product_performance"],
      ["what time is my rush", "get_patterns"],
      ["which day is my busiest", "get_patterns"],
      ["how can i make more money", "get_opportunities"],
      ["whats not on sale yet", "list_products"],
    ];
    const misrouted = routes.filter(([q, want]) => {
      const r = route(q);
      const got = r.kind === "direct" ? r.tools : r.kind === "reason" ? r.seed : [];
      return !got.includes(want);
    });
    check("merchant", "a shopkeeper's own phrasing — spoken or typed — reaches the right lookup with no model call",
      misrouted.length === 0,
      misrouted.length === 0 ? `${routes.length} phrasings` : misrouted.map(([q]) => q).join("; "));

    // "Why are sales down" is a judgement across several lookups, not a lookup.
    const why = route("Why are sales down?");
    check("merchant", "a question that needs reasoning is not answered by one lookup",
      why.kind === "reason" && why.seed.length >= 2, `${why.kind}, ${why.kind === "reason" ? why.seed.length : 0} sources`);

    /**
     * Two kinds of question, and they must be told apart.
     *
     * "Who are my best customers" was declined until there were customers to
     * rank; now there are, and declining it would be the assistant refusing
     * something it can do. "Refund this" and "message them" still cannot be
     * done — there is no refund path, and a buying agent acts for somebody the
     * shop never meets, so there is no number behind the name. Saying so is the
     * point; inventing either would be worse than both.
     */
    const nowAnswerable = route("Who are my best customers?");
    const noRefunds = route("refund Rahul ₹2,400");
    const noContact = route("send that customer a reminder");
    check("merchant", "a question the data now supports is answered, not declined",
      nowAnswerable.kind === "direct" && nowAnswerable.tools.includes("get_customers"),
      nowAnswerable.kind);
    check("merchant", "a question the system genuinely cannot do is declined, not fabricated",
      noRefunds.kind === "unheld" && noContact.kind === "unheld",
      "no refund path and no way to contact a buyer — both said plainly");

    // An instruction is not a question, and must reach a tool that changes
    // something rather than one that lists something.
    const instructions: Array<[string, string]> = [
      ["mark that order as handed over", "propose_confirm_handover"],
      // "Hand these over" means the ones just counted, not a transaction id.
      // Both contain the word "hand", and answering a bulk instruction by
      // asking which one of forty-nine is how an assistant feels deaf.
      ["hand these over", "propose_bulk_handover"],
      ["mark them all delivered", "propose_bulk_handover"],
      ["deliver everything", "propose_bulk_handover"],
      ["create an invoice", "propose_invoice"],
      ["send a payment link", "propose_payment_link"],
      ["set the price of Butter Puff to 99", "propose_set_price"],
    ];
    const misheard = instructions.filter(([q, want]) => {
      const r = route(q);
      return r.kind !== "act" || r.tool !== want;
    });
    check("merchant", "an instruction reaches a tool that acts, not one that lists",
      misheard.length === 0,
      misheard.length === 0 ? `${instructions.length} instructions` : misheard.map(([q]) => q).join("; "));

    // Nothing that changes the shop runs from a model turn — every one of them
    // is proposed and waits for a person.
    const writesNeedingPress = MERCHANT_TOOLS.filter((t) => t.writes && !t.confirm);
    check("merchant", "every tool that changes the shop waits for a press",
      writesNeedingPress.length === 0,
      writesNeedingPress.length === 0
        ? `${MERCHANT_TOOLS.filter((t) => t.writes).length} write tools, all confirmed`
        : writesNeedingPress.map((t) => t.name).join(", "));

    /**
     * A merchant on a shop's connection presses twice when the first response
     * does not come back. The second press must not raise a second invoice.
     */
    {
      let ran = 0;
      const a = merchantActions.propose({
        merchant_id: "mer_audit", conversation_id: "c", tool: "propose_invoice",
        args: {}, summary: "raise an invoice", confirm: true,
      });
      const work = async () => { ran++; return { ok: true }; };
      const first = await merchantActions.execute(a.action_id, work);
      const second = await merchantActions.execute(a.action_id, work);
      check("merchant", "pressing confirm twice does the work once",
        ran === 1 && !first.replayed && second.replayed && second.action.status === "done",
        `ran ${ran} time(s); the second press replayed the first result`);
    }

    /** A failed action is never reported as a completed one. */
    {
      const a = merchantActions.propose({
        merchant_id: "mer_audit", conversation_id: "c", tool: "propose_invoice",
        args: {}, summary: "raise an invoice", confirm: true,
      });
      const { action } = await merchantActions.execute(a.action_id, async () => {
        throw new Error("the gateway refused it");
      });
      check("merchant", "an action that failed is never reported as done",
        action.status === "failed" && /gateway refused/.test(action.error ?? ""),
        action.status);
    }

    /**
     * The demo history must be the same on every reset.
     *
     * A rehearsed answer of "sales are down 14%" that becomes "up 9%" in the
     * room is worse than no demo, and analytics that move on reload are
     * indistinguishable from analytics that are made up.
     */
    {
      const a = rngFor("history:mer_hazel");
      const b = rngFor("history:mer_hazel");
      const same = Array.from({ length: 50 }, () => a() === b()).every(Boolean);
      const buyersA = buyersFor("mer_atelier", 182).map((x) => x.agent_id).join(",");
      const buyersB = buyersFor("mer_atelier", 182).map((x) => x.agent_id).join(",");
      check("demo", "the generated history is the same on every reset",
        same && buyersA === buyersB, "same seed, same buyers, same numbers");
    }

    /**
     * "Why are sales down" must measure before it explains.
     *
     * The failure this guards against is an assistant that hands a growing shop
     * a confident set of reasons for a decline that did not happen — which is
     * exactly what a template does, and exactly what a measurement cannot.
     */
    {
      const period = (revenue: number, orders: number, customers: number, repeat: number) => ({
        label: "x", from: "", to: "", revenue, orders, units: orders,
        averageOrderValue: orders === 0 ? 0 : Math.round(revenue / orders),
        customers, repeatCustomers: repeat, repeatShare: customers === 0 ? 0 : repeat / customers,
      });
      const fell = contributors(period(5000, 14, 12, 2), period(10000, 29, 26, 3));
      const flat = contributors(period(10000, 30, 25, 8), period(10050, 30, 25, 8));
      check("demo", "a real decline is broken down into what actually moved",
        fell.length >= 2 && fell.every((c) => c.change < 0),
        fell.slice(0, 2).map((c) => c.what).join(", "));
      check("demo", "a shop that did not move is given no reasons",
        flat.length === 0, `${flat.length} contributors`);
    }

    /** Somebody who bought once, months ago, was never a regular to lose. */
    {
      const one = customerStats("m", [{
        transactionId: "t1", buyerAgentId: "agent_a", orderId: null, paymentId: "p", merchantId: "m",
        status: "paid", source: "simulated", amount: 100, currency: "INR",
        createdAt: "2026-01-01T00:00:00Z", paidAt: "2026-01-01T00:00:00Z", deliveredAt: null,
        items: [{ productId: "i", productName: "i", quantity: 1, unitPrice: 100, lineTotal: 100, listPrice: null, discount: null, attribution: "organic" }],
      }], () => "One Timer", new Date("2026-06-01T00:00:00Z"));
      check("demo", "a one-time buyer is not counted as a lapsed regular",
        lapsedCustomers(one).length === 0 && one[0]!.repeat === false,
        "needs more than one previous order to count as lost");
    }

    // The QR a merchant already has on their counter, rather than a typed VPA.
    const qr = readUpiUri("upi://pay?pa=merchant@upi&pn=ABC%20Stores&cu=INR");
    const notUpi = readUpiUri("https://example.com/nope");
    const badVpa = readUpiUri("upi://pay?pa=nonsense");
    check("merchant", "a UPI QR is read into payment details",
      qr.ok && qr.details?.upi_id === "merchant@upi" && qr.details?.merchant_name === "ABC Stores",
      qr.ok ? `${qr.details!.upi_id} · ${qr.details!.merchant_name}` : (qr.problem ?? ""));
    check("merchant", "a QR that is not a payment code is refused in plain words",
      !notUpi.ok && !badVpa.ok && /payment sticker/.test(notUpi.problem ?? ""),
      "not-a-UPI-code and malformed-id both explained");

    // ── Ledger ─────────────────────────────────────────────────────────────
    heading("Ledger — what the shop is told matches what happened");

    // Buy something and watch both the shelf and the statistics move together.
    type Row = {
      item_id: string; name: string; merchant_id: string;
      price: { value: number }; stock: { quantity: number };
    };
    const onSale = (await api("/catalog")).body.items as Row[];
    const pick = onSale.find((i) => i.stock.quantity >= 2 && i.price.value > 0);

    if (!pick) {
      check("ledger", "a product was available to test against", false, "nothing sellable in stock");
    } else {
      const stockBefore = pick.stock.quantity;
      const soldBefore = (await api(`/products/${pick.item_id}/analytics`)).body.unitsSold as number;

      const sale = await api("/agent/run", {
        method: "POST",
        body: JSON.stringify({
          goal: `${pick.name} under ₹${pick.price.value}`,
          item_id: pick.item_id,
          max_price: pick.price.value,
          opening_offer: Math.round(pick.price.value * 0.88),
          settle: "test_rail",
          attribution: "cross_sell",
        }),
      });
      const took = sale.body.final_price as number | undefined;

      const after = (await api(`/products/${pick.item_id}/analytics`)).body as {
        unitsSold: number; revenue: number; currentStock: number;
        byAttribution: Record<string, number>;
      };
      const shelfNow = ((await api("/catalog")).body.items as Row[])
        .find((i) => i.item_id === pick.item_id)?.stock.quantity ?? -1;

      check("ledger", "a paid sale takes the unit off the shelf",
        shelfNow === stockBefore - 1, `${stockBefore} → ${shelfNow}`);
      check("ledger", "the catalog and the statistics agree on stock",
        after.currentStock === shelfNow, `both say ${shelfNow}`);
      check("ledger", "the sale is counted against that product and no other",
        after.unitsSold === soldBefore + 1, `${soldBefore} → ${after.unitsSold}`);
      check("ledger", "why the sale happened is recorded, not guessed at later",
        (after.byAttribution.cross_sell ?? 0) > 0, `cross_sell ${after.byAttribution.cross_sell ?? 0}`);

      // The merchant headline and the product rows are two readings of one
      // list, so they cannot disagree unless something counts on its own.
      const mStats = (await api(`/merchants/${pick.merchant_id}/analytics`)).body as { revenue: number };
      const rows = (await api(`/merchants/${pick.merchant_id}/products/analytics`)).body
        .products as Array<{ revenue: number }>;
      const summed = rows.reduce((a, x) => a + x.revenue, 0);
      check("ledger", "merchant revenue is the sum of its products",
        summed === mStats.revenue, `₹${mStats.revenue}${took ? ` (this sale ₹${took})` : ""}`);

      const integrity = (await api("/analytics/integrity")).body as {
        ok: boolean; checked: number; faults: Array<{ problem: string }>;
      };
      check("ledger", "no transaction contradicts itself",
        integrity.ok, integrity.ok ? `${integrity.checked} checked` : integrity.faults[0]?.problem ?? "");
    }

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
