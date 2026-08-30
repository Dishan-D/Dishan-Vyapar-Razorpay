import express, { type Request, type Response } from "express";
import path from "node:path";
import { buildAuditBundle } from "./audit/bundle.js";
import { discover } from "./catalog/discovery.js";
import { Store } from "./db/store.js";
import { confirmFulfillment, FulfillmentRefused } from "./fulfillment/confirm.js";
import { buildCartMandate, buildIntentMandate, type MandateChain } from "./mandates/chain.js";
import { loadOrCreateKeyring } from "./mandates/keystore.js";
import type { CatalogItem } from "./mandates/schema.js";
import { negotiate } from "./negotiation/engine.js";
import { phraseTurns, templateLine } from "./negotiation/phrasing.js";
import { indexPolicies } from "./negotiation/policies.js";
import { gatewayFromEnv, publishableKeyId, type PaymentGateway } from "./payments/gateway.js";
import { authorizeCart, settlePayment, PaymentRefused } from "./payments/pay.js";
import { gateReasons } from "./structuring/extraction.js";
import { applyResolution, draftClarification, parseReply } from "./structuring/clarify.js";
import { clarificationMessage, DashboardNotifier, type Notifier } from "./structuring/notify.js";
import { priceSanity } from "./structuring/sanity.js";
import { loadServingCatalog } from "./structuring/run.js";

export interface AppOptions {
  /**
   * Override the gateway. The milestone scripts pass a simulated one so their
   * proofs hold regardless of which keys happen to be sitting in .env — a test
   * whose result depends on the developer's local config proves nothing.
   */
  gateway?: PaymentGateway;
  /** Override where merchant questions go. Defaults to the dashboard queue. */
  notifier?: Notifier;
}

export async function createApp(options: AppOptions = {}) {
  const keyring = await loadOrCreateKeyring();
  const store = new Store();
  const gateway = options.gateway ?? gatewayFromEnv();

  const structuring = await loadServingCatalog();
  const policies = indexPolicies(structuring.policies);
  const catalogItems = structuring.items;
  const merchants = new Map(structuring.merchants.map((m) => [m.merchant_id, m]));
  const notifier: Notifier = options.notifier ?? new DashboardNotifier();

  /** Sanity is always recomputed against the live catalog, never a stale snapshot. */
  const sanityFor = (item: CatalogItem) => priceSanity(item, catalogItems);

  /**
   * Ask about everything currently held (Addendum G.4). Runs at boot so the
   * dashboard has a queue to show; an item already asked about is not asked
   * about twice.
   */
  async function openClarifications(): Promise<void> {
    for (const item of catalogItems) {
      if (!item.needs_merchant_confirmation) continue;
      if (store.openClarificationFor(item.item_id)) continue;

      const draft = draftClarification(item, sanityFor(item), notifier.channel);
      if (!draft) continue;

      const merchant = merchants.get(item.merchant_id);
      const delivery = await notifier.send(merchant?.whatsapp ?? item.merchant_id, clarificationMessage(draft));
      store.saveClarification({ ...draft, channel: delivery.channel });
    }
  }
  await openClarifications();

  const app = express();

  /**
   * Milestone L — Razorpay's webhook.
   *
   * Registered before express.json() so the HMAC can be checked against the
   * exact bytes Razorpay signed. Parsing first and re-serialising would change
   * whitespace and key order, and the signature would never match.
   */
  app.post(
    "/webhooks/razorpay",
    express.raw({ type: "application/json" }),
    async (req: Request, res: Response) => {
      const raw = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : String(req.body ?? "");
      const signature = String(req.header("x-razorpay-signature") ?? "");

      if (!gateway.verifyWebhookSignature) {
        res.status(503).json({ error: "no webhook verification available on this gateway" });
        return;
      }
      if (!signature || !gateway.verifyWebhookSignature(raw, signature)) {
        // Anyone can POST here. Nothing below this line runs on an unsigned body.
        res.status(401).json({ error: "webhook signature did not verify" });
        return;
      }

      let event: any;
      try {
        event = JSON.parse(raw);
      } catch {
        res.status(400).json({ error: "unparseable webhook body" });
        return;
      }

      if (event?.event !== "payment.captured") {
        res.json({ ignored: event?.event ?? "unknown" });
        return;
      }

      const entity = event.payload?.payment?.entity ?? {};
      const orderId = String(entity.order_id ?? "");
      const paymentId = String(entity.id ?? "");
      const transactionId = orderId ? store.findTransactionByOrder(orderId) : undefined;

      if (!transactionId) {
        res.status(404).json({ error: `no transaction for order ${orderId}` });
        return;
      }

      const chain = store.loadChain(transactionId);
      const order = store.loadOrder(transactionId);
      if (!chain || !order) {
        res.status(409).json({ error: "transaction is missing its chain or order" });
        return;
      }
      if (chain.payment) {
        // Razorpay retries webhooks. Settling twice would mean two payment
        // mandates for one payment, which the append-only store refuses anyway.
        res.json({ status: "already_settled", transaction_id: transactionId });
        return;
      }

      const item = catalogItems.find((i) => i.item_id === chain.cart?.item_id);
      if (!item) {
        res.status(409).json({ error: `catalog no longer has ${chain.cart?.item_id}` });
        return;
      }

      try {
        const paid = await settlePayment(
          chain,
          item,
          keyring,
          gateway,
          order,
          { razorpay_payment_id: paymentId },
          { verifiedByGateway: true },
        );
        store.appendMandate(transactionId, paid.payment);
        res.json({ status: "settled", transaction_id: transactionId, payment_id: paid.payment_id });
      } catch (err) {
        if (err instanceof PaymentRefused) {
          res.status(402).json({ error: "payment refused", reasons: err.reasons });
          return;
        }
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  app.use(express.json());
  app.use(express.static(path.resolve("frontend")));
  // The merchant's own photos, served as-is. They are the input to Stage 1, so
  // showing them next to what was extracted is the point, not decoration.
  app.use("/media", express.static(path.resolve("data", "sample_products")));

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      gateway: gateway.kind,
      merchants: structuring.merchants.length,
      catalog_size: catalogItems.length,
      clarification_channel: notifier.channel,
    });
  });

  /**
   * What the browser needs to know to run Checkout. The Key ID is publishable by
   * design — Razorpay expects it in the page. The secret stays here.
   */
  app.get("/config", (_req, res) => {
    res.json({
      gateway: gateway.kind,
      requires_checkout: gateway.requiresCheckout,
      razorpay_key_id: publishableKeyId(gateway),
    });
  });

  /** The agent-readable catalog. Held items are listed but marked, never hidden. */
  app.get("/catalog", (_req, res) => {
    res.json({
      provider: structuring.provider,
      items: catalogItems.map((item) => {
        const photo = structuring.photos[item.item_id];
        const sanity = sanityFor(item);
        return {
          ...item,
          transactable: !item.needs_merchant_confirmation,
          held_because: gateReasons(item, sanity),
          sanity,
          audit: structuring.audits[item.item_id] ?? null,
          photo_url: photo?.present && photo.filename ? `/media/${photo.filename}` : null,
          photo_filename: photo?.filename ?? null,
        };
      }),
    });
  });

  app.post("/discover", (req: Request, res: Response) => {
    const { want, max_price, category } = req.body ?? {};
    if (typeof want !== "string" || want.trim() === "") {
      res.status(400).json({ error: "`want` is required" });
      return;
    }
    res.json(discover(catalogItems, { want, max_price, category }));
  });

  /**
   * Stages 2–5 in one call: find, haggle, sign, pay.
   *
   * A failed negotiation returns 200 with status "no_deal" — the buyer-agent
   * asked a legitimate question and got a legitimate answer. Nothing went wrong,
   * so nothing here is an error.
   */
  app.post("/transactions", async (req: Request, res: Response) => {
    try {
      const {
        want = "blue cotton saree",
        max_price = 1500,
        opening_offer = 800,
        buyer_agent_id = "agent_xyz",
        // "" means the buyer-agent was not constrained to a category. Defaulting
        // to a guess like "apparel" silently narrows a mandate the buyer never gave.
        category = "",
        phrase = false,
      } = req.body ?? {};

      // The intent's category constraint is applied at discovery, not just at payment.
      const found = discover(catalogItems, { want, max_price, category });
      const item = found.matches[0]?.item;
      if (!item) {
        res.status(404).json({ error: "no offerable match", withheld: found.withheld });
        return;
      }

      const policy = policies.get(item.item_id);
      if (!policy) {
        res.status(409).json({ error: `no negotiation policy set for ${item.item_id}` });
        return;
      }

      const outcome = negotiate(item, policy, { buyer_agent_id, max_price, opening_offer });
      const lines = phrase
        ? await phraseTurns(item, outcome.log)
        : outcome.log.map(templateLine);
      const log = outcome.log.map((turn, i) => ({ ...turn, message: lines[i]! }));

      if (outcome.status === "no_deal") {
        res.json({ status: "no_deal", item_id: item.item_id, reason: outcome.reason, log });
        return;
      }

      const transaction_id = `txn_${Date.now().toString(36)}`;
      store.createTransaction({
        transaction_id,
        item_id: item.item_id,
        merchant_id: item.merchant_id,
        buyer_agent_id,
      });

      const intent = await buildIntentMandate(
        {
          issuer: keyring.get("buyer_agent").kid,
          buyer_agent_id,
          constraints: { max_price, category, ttl_seconds: 600 },
          prompt_playback: `Find a ${want} under ${max_price}`,
        },
        keyring,
      );
      store.appendMandate(transaction_id, intent);

      const cart = await buildCartMandate(
        intent,
        {
          item_id: item.item_id,
          final_price: { value: outcome.final_price, currency: "INR" },
          merchant_id: item.merchant_id,
        },
        keyring,
      );
      store.appendMandate(transaction_id, cart);

      const chain: MandateChain = { transaction_id, intent, cart };

      // Authorize only. The order is a request to be paid, not a payment.
      const order = await authorizeCart(chain, item, keyring, gateway);
      store.saveOrder(transaction_id, order);

      const common = {
        transaction_id,
        item_id: item.item_id,
        final_price: outcome.final_price,
        order_id: order.order_id,
        amount_paise: order.amount_paise,
        gateway: gateway.kind,
        log,
      };

      if (gateway.requiresCheckout) {
        // A real payment_id can only come from a browser Checkout session, so
        // the transaction stops here and waits rather than inventing one.
        res.status(201).json({ ...common, status: "awaiting_payment" });
        return;
      }

      const paid = await settlePayment(chain, item, keyring, gateway, order, undefined);
      store.appendMandate(transaction_id, paid.payment);
      res.status(201).json({ ...common, status: "paid", payment_id: paid.payment_id });
    } catch (err) {
      if (err instanceof PaymentRefused) {
        res.status(402).json({ error: "payment refused", reasons: err.reasons });
        return;
      }
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Stage 5b — settle a Razorpay Checkout callback and issue the Payment Mandate.
   *
   * Everything in the body arrived from a browser, so none of it is believed
   * until the signature checks out against the order this server authorized.
   */
  app.post("/transactions/:id/settle-payment", async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const chain = store.loadChain(id);
    if (!chain) {
      res.status(404).json({ error: `no such transaction: ${id}` });
      return;
    }
    if (chain.payment) {
      res.status(409).json({ error: "this transaction is already paid" });
      return;
    }
    const order = store.loadOrder(id);
    if (!order) {
      res.status(409).json({ error: "no authorized order for this transaction" });
      return;
    }
    const item = catalogItems.find((i) => i.item_id === chain.cart?.item_id);
    if (!item) {
      res.status(409).json({ error: `catalog no longer has ${chain.cart?.item_id}` });
      return;
    }

    try {
      const paid = await settlePayment(chain, item, keyring, gateway, order, {
        razorpay_payment_id: String(req.body?.razorpay_payment_id ?? ""),
        razorpay_signature: req.body?.razorpay_signature,
      });
      store.appendMandate(id, paid.payment);
      res.status(201).json({
        status: "paid",
        transaction_id: id,
        order_id: paid.order_id,
        payment_id: paid.payment_id,
      });
    } catch (err) {
      if (err instanceof PaymentRefused) {
        res.status(402).json({ error: "payment refused", reasons: err.reasons });
        return;
      }
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/merchants", (_req, res) => {
    res.json({
      merchants: structuring.merchants.map((m) => ({
        ...m,
        items: catalogItems.filter((i) => i.merchant_id === m.merchant_id).length,
        held: catalogItems.filter((i) => i.merchant_id === m.merchant_id && i.needs_merchant_confirmation).length,
      })),
    });
  });

  /** The open questions waiting on a merchant (Addendum G.4). */
  app.get("/clarifications", (req: Request, res: Response) => {
    const merchantId = typeof req.query.merchant_id === "string" ? req.query.merchant_id : undefined;
    res.json({ channel: notifier.channel, clarifications: store.listClarifications(merchantId) });
  });

  /**
   * The merchant's answer (Addendum G.1.5). Accepts what someone would actually
   * type — "110", "₹110", "Rs 110" — rather than demanding a clean number.
   */
  app.post("/clarifications/:id/reply", (req: Request, res: Response) => {
    const id = String(req.params.id);
    const clarification = store.getClarification(id);
    if (!clarification) {
      res.status(404).json({ error: `no such clarification: ${id}` });
      return;
    }
    if (clarification.status === "resolved") {
      res.status(409).json({ error: "already resolved" });
      return;
    }

    const raw = req.body?.reply ?? req.body?.value;
    const value = typeof raw === "number" ? raw : parseReply(String(raw ?? ""));
    if (value === null) {
      res.status(400).json({ error: `could not read a number from "${raw}"` });
      return;
    }

    const index = catalogItems.findIndex((i) => i.item_id === clarification.item_id);
    if (index < 0) {
      res.status(409).json({ error: `catalog no longer has ${clarification.item_id}` });
      return;
    }

    const outcome = applyResolution(catalogItems[index]!, clarification, value, (updated) =>
      priceSanity(updated, catalogItems.map((i) => (i.item_id === updated.item_id ? updated : i))),
    );
    catalogItems[index] = outcome.item;

    store.saveClarification({
      ...clarification,
      status: "resolved",
      resolved_value: value,
      resolved_at: new Date().toISOString(),
    });

    const audit = structuring.audits[clarification.item_id];
    if (audit) {
      audit.clarification_sent = true;
      audit.clarification_channel = clarification.channel;
      audit.resolved_value = value;
      audit.resolved_at = new Date().toISOString();
      audit.gate_result = outcome.cleared ? "passed" : "held";
    }

    // An item can be wrong in more than one way. The merchant answered what they
    // were asked; if something else is still missing, that is a new question,
    // not a failure of theirs. Asking it is what makes this a loop.
    let followUp: string | null = null;
    if (!outcome.cleared) {
      const next = draftClarification(outcome.item, sanityFor(outcome.item), notifier.channel);
      if (next && next.trigger !== clarification.trigger) {
        const merchant = merchants.get(outcome.item.merchant_id);
        void notifier
          .send(merchant?.whatsapp ?? outcome.item.merchant_id, clarificationMessage(next))
          .then((delivery) => store.saveClarification({ ...next, channel: delivery.channel }));
        store.saveClarification(next);
        followUp = next.question;
      }
    }

    res.json({
      clarification_id: id,
      item_id: clarification.item_id,
      resolved_value: value,
      transactable: outcome.cleared,
      still_held_because: outcome.remaining,
      follow_up: followUp,
    });
  });

  /** Stage 6 — the merchant says the goods changed hands. */
  app.post("/transactions/:id/confirm-fulfillment", async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const chain = store.loadChain(id);
    if (!chain) {
      res.status(404).json({ error: `no such transaction: ${id}` });
      return;
    }
    try {
      const fulfillment = await confirmFulfillment(chain, keyring, {
        evidence_note: req.body?.evidence_note ?? null,
        evidence_photo_ref: req.body?.evidence_photo_ref ?? null,
      });
      store.appendMandate(chain.transaction_id, fulfillment);
      res.status(201).json({ status: "fulfilled", transaction_id: chain.transaction_id });
    } catch (err) {
      if (err instanceof FulfillmentRefused) {
        res.status(409).json({ error: "fulfillment refused", reasons: err.reasons });
        return;
      }
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /** Stage 7 — the closing visual. */
  app.get("/transactions/:id/audit", async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const chain = store.loadChain(id);
    if (!chain) {
      res.status(404).json({ error: `no such transaction: ${id}` });
      return;
    }
    res.json(await buildAuditBundle(chain, keyring));
  });

  app.get("/transactions", (_req, res) => {
    res.json({ transactions: store.listTransactions() });
  });

  return { app, store, keyring, catalog: catalogItems, gateway, structuring, notifier };
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()!);
if (isMain) {
  const port = Number(process.env.PORT ?? 3000);
  createApp()
    .then(({ app, gateway }) => {
      app.listen(port, () => {
        console.log(`Vyapar-to-Agent listening on http://localhost:${port}  (gateway: ${gateway.kind})`);
      });
    })
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    });
}
