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
import { loadPolicies } from "./negotiation/policies.js";
import { gatewayFromEnv, publishableKeyId, type PaymentGateway } from "./payments/gateway.js";
import { authorizeCart, settlePayment, PaymentRefused } from "./payments/pay.js";
import { gateReasons } from "./structuring/extraction.js";
import { loadServingCatalog } from "./structuring/run.js";

export interface AppOptions {
  /**
   * Override the gateway. The milestone scripts pass a simulated one so their
   * proofs hold regardless of which keys happen to be sitting in .env — a test
   * whose result depends on the developer's local config proves nothing.
   */
  gateway?: PaymentGateway;
}

export async function createApp(options: AppOptions = {}) {
  const keyring = await loadOrCreateKeyring();
  const store = new Store();
  const gateway = options.gateway ?? gatewayFromEnv();
  const policies = await loadPolicies();
  const structuring = await loadServingCatalog();
  const catalog: CatalogItem[] = structuring.items;

  const app = express();
  app.use(express.json());
  app.use(express.static(path.resolve("frontend")));
  // The merchant's own photos, served as-is. They are the input to Stage 1, so
  // showing them next to what was extracted is the point, not decoration.
  app.use("/media", express.static(path.resolve("data", "sample_products")));

  app.get("/health", (_req, res) => {
    res.json({ ok: true, gateway: gateway.kind, catalog_size: catalog.length });
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
      items: catalog.map((item) => {
        const photo = structuring.photos[item.item_id];
        return {
          ...item,
          transactable: !item.needs_merchant_confirmation,
          held_because: gateReasons(item),
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
    res.json(discover(catalog, { want, max_price, category }));
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
      const found = discover(catalog, { want, max_price, category });
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
    const item = catalog.find((i) => i.item_id === chain.cart?.item_id);
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

  return { app, store, keyring, catalog, gateway };
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
