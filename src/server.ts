import express, { type Request, type Response } from "express";
import path from "node:path";
import { createServer, type Server as HttpServer } from "node:http";
import { Server as IOServer } from "socket.io";
import QRCode from "qrcode";
import { buildAuditBundle } from "./audit/bundle.js";
import { buildCommerceHistory } from "./audit/history.js";
import { readinessScore } from "./marketplace/readiness.js";
import { compareMerchants } from "./marketplace/compare.js";
import { parseIntent } from "./agent/intent.js";
import { discover } from "./catalog/discovery.js";
import { Store } from "./db/store.js";
import { confirmFulfillment, FulfillmentRefused } from "./fulfillment/confirm.js";
import { buildCartMandate, buildIntentMandate, type MandateChain } from "./mandates/chain.js";
import { loadOrCreateKeyring } from "./mandates/keystore.js";
import type { CatalogItem } from "./mandates/schema.js";
import { negotiate } from "./negotiation/engine.js";
import { phraseTurns, templateLine } from "./negotiation/phrasing.js";
import { indexPolicies } from "./negotiation/policies.js";
import { gatewayFromEnv, publishableKeyId, SimulatedGateway, type PaymentGateway } from "./payments/gateway.js";
import { authorizeCart, settlePayment, PaymentRefused } from "./payments/pay.js";
import { gateReasons } from "./structuring/extraction.js";
import { applyResolution, draftClarification, parseReply } from "./structuring/clarify.js";
import { clarificationMessage, DashboardNotifier, type Notifier } from "./structuring/notify.js";
import {
  parseInbound,
  saleConfirmationMessage,
  twilioConfigFromEnv,
  WhatsAppNotifier,
} from "./structuring/whatsapp.js";
import { priceSanity } from "./structuring/sanity.js";
import { EventBus, ROOM_ALL } from "./events/bus.js";
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
  /** Share a bus with a caller that wants to watch without a socket. */
  bus?: EventBus;
}

export async function createApp(options: AppOptions = {}) {
  const keyring = await loadOrCreateKeyring();
  const store = new Store();
  const gateway = options.gateway ?? gatewayFromEnv();

  const structuring = await loadServingCatalog();
  const policies = indexPolicies(structuring.policies);
  const catalogItems = structuring.items;
  const merchants = new Map(structuring.merchants.map((m) => [m.merchant_id, m]));
  // WhatsApp when Twilio is configured, the dashboard queue otherwise. The
  // fallback is not a degraded mode: the question is the same question, and the
  // loop closes either way. What must never happen is the pipeline blocking
  // because a notification channel is unconfigured.
  const twilioConfig = twilioConfigFromEnv();
  const notifier: Notifier =
    options.notifier ?? (twilioConfig ? new WhatsAppNotifier(twilioConfig) : new DashboardNotifier());
  const bus = options.bus ?? new EventBus();

  /**
   * A settlement rail the agent can finish on by itself.
   *
   * With real Razorpay keys a payment id can only come from a browser, so an
   * autonomous run always stops at the order — correct, and the right default
   * when real money is involved. But it also means the agentic loop can never be
   * shown closing. This rail lets it close, with `sim_` ids that cannot be
   * mistaken for Razorpay's and a trace that says which rail was used.
   */
  const testRail = new SimulatedGateway();

  // Items the merchant has personally answered for. Kept beside the catalog
  // rather than encoded in a confidence value, so nothing the model returns can
  // ever be mistaken for a human's word.
  const merchantConfirmed = new Set<string>(structuring.merchantConfirmed);

  /** Sanity is always recomputed against the live catalog, never a stale snapshot. */
  const sanityFor = (item: CatalogItem) =>
    priceSanity(item, catalogItems, { merchantConfirmed: merchantConfirmed.has(item.item_id) });

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

      bus.emit({
        type: "extraction.held",
        merchant_id: item.merchant_id,
        item_id: item.item_id,
        message: `${item.name} held — ${draft.trigger.replace(/_/g, " ")}`,
        data: { triggers: [draft.trigger] },
      });
      bus.emit({
        type: "clarification.sent",
        merchant_id: item.merchant_id,
        item_id: item.item_id,
        message: `Asked ${merchant?.name ?? item.merchant_id}: ${draft.question}`,
        data: { channel: delivery.channel, question: draft.question, options: draft.options },
      });
    }
  }
  /**
   * Milestone K, message type 2 — outbound only, no reply expected.
   * Fire-and-forget: a merchant not hearing about a sale is a bad afternoon,
   * but a notification failing must never unwind a captured payment.
   */
  async function confirmSale(merchantId: string, itemName: string, price: number): Promise<void> {
    const merchant = merchants.get(merchantId);
    if (!merchant) return;
    await notifier.send(merchant.whatsapp, saleConfirmationMessage(itemName, price)).catch(() => undefined);
  }

  await openClarifications();

  for (const item of catalogItems) {
    if (item.needs_merchant_confirmation) continue;
    bus.emit({
      type: "extraction.completed",
      merchant_id: item.merchant_id,
      item_id: item.item_id,
      message: `${item.name} is agent-readable at ₹${item.price.value}`,
    });
  }

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
        bus.emit({
          type: "payment.captured",
          transaction_id: transactionId,
          merchant_id: item.merchant_id,
          item_id: item.item_id,
          message: `Razorpay confirmed capture of ${paid.payment_id}`,
          data: { payment_id: paid.payment_id, order_id: paid.order_id, via: "webhook" },
        });
        void confirmSale(item.merchant_id, item.name, chain.cart?.final_price.value ?? 0);
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
      catalog_provider: structuring.provider,
      catalog_sources: structuring.sourceCounts,
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
      test_rail_available: true,
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
    const result = discover(catalogItems, { want, max_price, category });
    bus.emit({
      type: "discovery.queried",
      message: `Buyer-agent searched for "${want}" — ${result.matches.length} offer(s), ${result.withheld.length} withheld`,
      data: { want, max_price, matches: result.matches.length },
    });
    res.json(result);
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
        item_id,
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

      // Two merchants can stock the same product under the same name. When the
      // caller has already chosen one — clicking a specific shop's listing —
      // honour that instead of re-running a search that would silently pick
      // whichever is cheaper.
      const item = item_id
        ? catalogItems.find((i) => i.item_id === item_id)
        : found.matches[0]?.item;
      if (!item) {
        res.status(404).json({ error: "no offerable match", withheld: found.withheld });
        return;
      }
      if (item.needs_merchant_confirmation) {
        res.status(409).json({
          error: `${item.name} is still awaiting merchant confirmation`,
          held_because: gateReasons(item, sanityFor(item)),
        });
        return;
      }

      const policy = policies.get(item.item_id);
      if (!policy) {
        res.status(409).json({ error: `no negotiation policy set for ${item.item_id}` });
        return;
      }

      bus.emit({
        type: "discovery.queried",
        merchant_id: item.merchant_id,
        item_id: item.item_id,
        message: `Buyer-agent is looking at ${item.name}`,
        data: { want, max_price },
      });

      const outcome = negotiate(item, policy, { buyer_agent_id, max_price, opening_offer });
      const lines = phrase
        ? await phraseTurns(item, outcome.log)
        : outcome.log.map(templateLine);
      const log = outcome.log.map((turn, i) => ({ ...turn, message: lines[i]! }));

      const publishTurns = (transactionId?: string) => {
        for (const [i, turn] of outcome.log.entries()) {
          bus.emit({
            type: turn.actor === "buyer" ? "negotiation.offer_made" : "negotiation.countered",
            ...(transactionId ? { transaction_id: transactionId } : {}),
            merchant_id: item.merchant_id,
            item_id: item.item_id,
            message: lines[i]!,
            data: { round: turn.round, actor: turn.actor, amount: turn.amount, rationale: turn.rationale },
          });
        }
      };

      if (outcome.status === "no_deal") {
        publishTurns();
        bus.emit({
          type: "negotiation.no_deal",
          merchant_id: item.merchant_id,
          item_id: item.item_id,
          message: `No deal on ${item.name} — ${outcome.reason}`,
          data: { reason: outcome.reason },
        });
        res.json({ status: "no_deal", item_id: item.item_id, reason: outcome.reason, log });
        return;
      }

      const transaction_id = `txn_${Date.now().toString(36)}`;
      publishTurns(transaction_id);
      bus.emit({
        type: "negotiation.agreed",
        transaction_id,
        merchant_id: item.merchant_id,
        item_id: item.item_id,
        message: `Agreed ₹${outcome.final_price} for ${item.name}`,
        data: { final_price: outcome.final_price, list_price: item.price.value, rounds: outcome.rounds },
      });
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
      bus.emit({
        type: "payment.order_created",
        transaction_id,
        merchant_id: item.merchant_id,
        item_id: item.item_id,
        message: `Order ${order.order_id} opened for ₹${outcome.final_price}`,
        data: { order_id: order.order_id, amount_paise: order.amount_paise },
      });

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
      bus.emit({
        type: "payment.captured",
        transaction_id,
        merchant_id: item.merchant_id,
        item_id: item.item_id,
        message: `Payment captured — ₹${outcome.final_price} for ${item.name}`,
        data: { payment_id: paid.payment_id, order_id: paid.order_id, amount: outcome.final_price },
      });
      void confirmSale(item.merchant_id, item.name, outcome.final_price);
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
      bus.emit({
        type: "payment.captured",
        transaction_id: id,
        merchant_id: item.merchant_id,
        item_id: item.item_id,
        message: `Payment captured — ${paid.payment_id}`,
        data: { payment_id: paid.payment_id, order_id: paid.order_id },
      });
      void confirmSale(item.merchant_id, item.name, chain.cart?.final_price.value ?? 0);
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

  /** Replay, for a viewer that arrived late. */
  app.get("/events", (req: Request, res: Response) => {
    res.json({
      events: bus.recent({
        ...(typeof req.query.transaction_id === "string" ? { transaction_id: req.query.transaction_id } : {}),
        ...(typeof req.query.merchant_id === "string" ? { merchant_id: req.query.merchant_id } : {}),
        limit: Number(req.query.limit ?? 100),
      }),
    });
  });

  /** Fulfillment record straight from the chains — the readiness score's third component. */
  function fulfillmentRecord(merchantId: string): { confirmed: number; paid: number } {
    let confirmed = 0;
    let paid = 0;
    for (const id of store.listTransactionIdsForMerchant(merchantId)) {
      const chain = store.loadChain(id);
      if (!chain?.payment) continue;
      paid++;
      if (chain.fulfillment) confirmed++;
    }
    return { confirmed, paid };
  }

  const readinessFor = (merchantId: string) =>
    readinessScore(merchantId, catalogItems, structuring.policies, fulfillmentRecord(merchantId));

  /**
   * Milestone M — the merchant's QR, pointing at their dashboard.
   *
   * Deliberately the whole feature: one image, generated locally, no external
   * service and nothing to scan into. It exists to close a visual loop — the
   * same sticker on the counter, now opening onto something an agent can read.
   */
  app.get("/merchants/:id/qr.png", async (req: Request, res: Response) => {
    const id = String(req.params.id);
    if (!merchants.has(id)) {
      res.status(404).json({ error: `no such merchant: ${id}` });
      return;
    }
    const base = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;
    const png = await QRCode.toBuffer(`${base}/merchant.html?m=${id}`, {
      width: 320,
      margin: 1,
      color: { dark: "#0e1014", light: "#ffffff" },
    });
    res.type("image/png").send(png);
  });

  app.get("/merchants/:id/readiness", (req: Request, res: Response) => {
    const id = String(req.params.id);
    if (!merchants.has(id)) {
      res.status(404).json({ error: `no such merchant: ${id}` });
      return;
    }
    res.json(readinessFor(id));
  });

  /**
   * Milestone J.2 — one intent, every merchant, one justified choice.
   * The losing offers come back too: a comparison you cannot inspect is
   * indistinguishable from a preference.
   */
  app.post("/marketplace/compare", (req: Request, res: Response) => {
    const {
      want,
      max_price = 1000,
      opening_offer = Math.round(Number(max_price) * 0.6),
      buyer_agent_id = "agent_xyz",
    } = req.body ?? {};

    if (typeof want !== "string" || want.trim() === "") {
      res.status(400).json({ error: "`want` is required" });
      return;
    }

    const views = structuring.merchants.map((m) => ({
      merchant_id: m.merchant_id,
      name: m.name,
      readiness: readinessFor(m.merchant_id),
    }));

    const result = compareMerchants(
      want,
      { buyer_agent_id, max_price: Number(max_price), opening_offer: Number(opening_offer) },
      views,
      catalogItems,
      policies,
    );

    for (const offer of result.offers) {
      bus.emit({
        type: offer.eligible ? "negotiation.agreed" : "negotiation.no_deal",
        merchant_id: offer.merchant_id,
        item_id: offer.item_id,
        message: `${offer.merchant_name}: ${offer.note}`,
        data: {
          final_price: offer.final_price,
          effective_price: offer.effective_price,
          readiness: offer.readiness.score,
          comparison: true,
        },
      });
    }
    if (result.selected) {
      bus.emit({
        type: "discovery.queried",
        merchant_id: result.selected.merchant_id,
        item_id: result.selected.item_id,
        message: `Selected ${result.selected.merchant_name} — ${result.reasoning[result.reasoning.length - 1]}`,
        data: { selected: true },
      });
    }

    res.json(result);
  });

  /**
   * What a shopper's one digital asset actually gets them — before and after.
   *
   * This is the project's claim, made checkable rather than asserted. "Before"
   * is not a strawman: a UPI VPA really is the whole of most of these merchants'
   * machine-readable presence. It moves money and answers no questions.
   */
  app.get("/merchants/:id/before-after", (req: Request, res: Response) => {
    const id = String(req.params.id);
    const merchant = merchants.get(id);
    if (!merchant) {
      res.status(404).json({ error: `no such merchant: ${id}` });
      return;
    }

    const mine = catalogItems.filter((i) => i.merchant_id === id);
    const sellable = mine.filter((i) => !i.needs_merchant_confirmation);

    res.json({
      merchant: { merchant_id: id, name: merchant.name, city: merchant.city },
      before: {
        headline: "One UPI QR. Nothing an agent can read.",
        machine_readable: { upi_vpa: merchant.upi_vpa },
        upi_since: merchant.since,
        qr_note: merchant.qr_note,
        // Everything the merchant "has" that a machine cannot use.
        unstructured_inputs: mine.map((i) => ({
          voice_note: i.source.raw_text,
          photo: structuring.photos[i.item_id]?.filename ?? null,
        })),
        structured_fields: 1,
        products_an_agent_can_see: 0,
        can_be_queried: false,
        can_be_negotiated_with: false,
        can_be_transacted_with: false,
        why: "A VPA is a destination for money, not a description of goods. An agent that scans this QR learns where to send rupees and nothing about what it would be buying.",
      },
      after: {
        headline: "Same shop, same UPI. Now machine-readable.",
        machine_readable: { upi_vpa: merchant.upi_vpa, catalog_endpoint: `/catalog?merchant=${id}` },
        structured_fields: mine.length * 8,
        products_an_agent_can_see: mine.length,
        products_an_agent_can_buy: sellable.length,
        products_held_for_confirmation: mine.length - sellable.length,
        can_be_queried: true,
        can_be_negotiated_with: sellable.some((i) => policies.has(i.item_id)),
        can_be_transacted_with: sellable.length > 0,
        sample_record: sellable[0] ?? mine[0] ?? null,
        why: "The same voice notes, read once and written down in a shape an agent can filter, haggle over, and pay against — with the payment still landing on the same UPI ID it always did.",
      },
    });
  });

  /**
   * The agentic path: a sentence in, a completed purchase out.
   *
   * The only model call is the first step — turning what a person said into a
   * mandate with a ceiling. Every step after it is deterministic, and every step
   * is returned in `trace` so the run can be argued with rather than trusted.
   */
  app.post("/agent/run", async (req: Request, res: Response) => {
    const goal = typeof req.body?.goal === "string" ? req.body.goal.trim() : "";
    if (!goal) {
      res.status(400).json({ error: "`goal` is required — say what you want in a sentence" });
      return;
    }

    // "test_rail" lets the agent finish the purchase on its own; anything else
    // uses the configured gateway, which with real keys hands off to Checkout.
    const useTestRail = req.body?.settle === "test_rail";
    const runGateway: PaymentGateway = useTestRail ? testRail : gateway;
    const trace: Array<Record<string, unknown>> = [];
    const step = (
      stage: string,
      headline: string,
      detail: Record<string, unknown> = {},
      decidedBy: "model" | "rules" = "rules",
    ) => {
      trace.push({ stage, headline, decided_by: decidedBy, at: new Date().toISOString(), ...detail });
    };

    try {
      // 1 — language → mandate
      const { intent, parsedBy, fallbackReason } = await parseIntent(goal);
      if (fallbackReason) {
        console.warn(`[agent] intent parsing fell back to rules — ${fallbackReason}`);
      }
      step(
        "understand",
        `Read that as: ${intent.want}, ceiling ₹${intent.max_price}`,
        {
          intent,
          parsed_by: parsedBy,
          note: intent.reasoning,
          ...(fallbackReason ? { fallback_reason: fallbackReason } : {}),
        },
        parsedBy === "rules" ? "rules" : "model",
      );
      bus.emit({ type: "discovery.queried", message: `Agent understood: "${goal}" → ${intent.want} under ₹${intent.max_price}` });

      // 2 — every merchant, in parallel, each haggled with separately
      const views = structuring.merchants.map((m) => ({
        merchant_id: m.merchant_id,
        name: m.name,
        readiness: readinessFor(m.merchant_id),
      }));
      const comparison = compareMerchants(
        intent.want,
        { buyer_agent_id: "agent_xyz", max_price: intent.max_price, opening_offer: intent.opening_offer },
        views,
        catalogItems,
        policies,
      );
      step("shop", `Checked ${views.length} shops; ${comparison.offers.length} stock it`, {
        offers: comparison.offers.map((o) => ({
          merchant_id: o.merchant_id,
          merchant_name: o.merchant_name,
          item_id: o.item_id,
          item_name: o.item_name,
          readiness: o.readiness.score,
          final_price: o.final_price,
          effective_price: o.effective_price,
          rounds: o.outcome.rounds,
          log: o.outcome.log,
          eligible: o.eligible,
          note: o.note,
        })),
      });

      if (!comparison.selected) {
        step("stop", "No shop reached a price inside the mandate", { reasoning: comparison.reasoning });
        res.json({ goal, intent, status: "no_deal", trace, comparison });
        return;
      }

      const chosen = comparison.selected;
      step("choose", `Chose ${chosen.merchant_name} at ₹${chosen.final_price}`, {
        reasoning: comparison.reasoning,
        merchant_id: chosen.merchant_id,
        effective_price: chosen.effective_price,
      });

      // 3 — mandates + order, through exactly the path a human click takes
      const item = catalogItems.find((i) => i.item_id === chosen.item_id)!;
      const transaction_id = `txn_${Date.now().toString(36)}`;
      store.createTransaction({
        transaction_id,
        item_id: item.item_id,
        merchant_id: item.merchant_id,
        buyer_agent_id: "agent_xyz",
      });

      const mandateIntent = await buildIntentMandate(
        {
          issuer: keyring.get("buyer_agent").kid,
          buyer_agent_id: "agent_xyz",
          constraints: { max_price: intent.max_price, category: "", ttl_seconds: 600 },
          prompt_playback: goal,
        },
        keyring,
      );
      store.appendMandate(transaction_id, mandateIntent);

      const cart = await buildCartMandate(
        mandateIntent,
        {
          item_id: item.item_id,
          final_price: { value: chosen.final_price!, currency: "INR" },
          merchant_id: item.merchant_id,
        },
        keyring,
      );
      store.appendMandate(transaction_id, cart);
      step("sign", "Intent and cart mandates signed", {
        transaction_id,
        prompt_playback: goal,
        note: "the shopper's own words are inside the signed intent, so the mandate says what it was for",
      });

      const chain: MandateChain = { transaction_id, intent: mandateIntent, cart };
      const order = await authorizeCart(chain, item, keyring, runGateway);
      store.saveOrder(transaction_id, order);
      bus.emit({
        type: "payment.order_created",
        transaction_id,
        merchant_id: item.merchant_id,
        item_id: item.item_id,
        message: `Agent opened order ${order.order_id} for ₹${chosen.final_price}`,
      });

      if (runGateway.requiresCheckout) {
        step("pay", `Order ${order.order_id} opened — needs a human at Checkout`, {
          order_id: order.order_id,
          amount_paise: order.amount_paise,
          note: "a payment id only exists once someone actually pays; the agent stops here rather than inventing one",
        });
        res.status(201).json({
          goal, intent, status: "awaiting_payment", transaction_id,
          order_id: order.order_id, amount_paise: order.amount_paise,
          final_price: chosen.final_price, merchant: chosen.merchant_name,
          item_id: item.item_id, trace, comparison,
        });
        return;
      }

      const paid = await settlePayment(chain, item, keyring, runGateway, order, undefined);
      store.appendMandate(transaction_id, paid.payment);
      chain.payment = paid.payment;
      bus.emit({
        type: "payment.captured",
        transaction_id,
        merchant_id: item.merchant_id,
        item_id: item.item_id,
        message: `Agent paid ₹${chosen.final_price} to ${chosen.merchant_name}`,
      });
      void confirmSale(item.merchant_id, item.name, chosen.final_price!);
      step("pay", `Paid ₹${chosen.final_price}`, {
        order_id: paid.order_id,
        payment_id: paid.payment_id,
        rail: useTestRail ? "test rail" : "razorpay",
        ...(useTestRail
          ? { note: "settled on the simulated rail so the agent could finish unattended — ids are sim_ prefixed and are not Razorpay's" }
          : {}),
      });

      // 4 — and here the agent stops, unconditionally. It can spend money; it
      // cannot hand goods across a counter, and nothing here will pretend it did.
      step("wait", "Paid, not delivered", {
        note: "the agent has no way to confirm a handover — only the shopkeeper's signature closes this",
        status: "payment_confirmed_awaiting_fulfillment",
      });

      res.status(201).json({
        goal, intent, status: "paid", transaction_id,
        order_id: paid.order_id, payment_id: paid.payment_id,
        rail: useTestRail ? "test_rail" : "razorpay",
        final_price: chosen.final_price, merchant: chosen.merchant_name,
        item_id: item.item_id, trace, comparison,
      });
    } catch (err) {
      if (err instanceof PaymentRefused) {
        step("refused", "Payment refused before any gateway call", { reasons: err.reasons });
        res.status(402).json({ goal, status: "refused", reasons: err.reasons, trace });
        return;
      }
      res.status(500).json({ error: err instanceof Error ? err.message : String(err), trace });
    }
  });

  /**
   * Milestone H — the merchant's verifiable trading record, signed.
   * Not a lending product; a repackaging of what the chains already prove.
   */
  app.get("/merchants/:id/commerce-history", async (req: Request, res: Response) => {
    const merchantId = String(req.params.id);
    const merchant = merchants.get(merchantId);
    if (!merchant) {
      res.status(404).json({ error: `no such merchant: ${merchantId}` });
      return;
    }

    const chains = store
      .listTransactionIdsForMerchant(merchantId)
      .map((id) => store.loadChain(id))
      .filter((c): c is NonNullable<typeof c> => Boolean(c));

    const from = typeof req.query.from === "string" ? req.query.from : "1970-01-01";
    const to = typeof req.query.to === "string" ? req.query.to : new Date().toISOString().slice(0, 10);

    res.json(
      await buildCommerceHistory(merchant, chains, structuring.policies, keyring, { from, to }),
    );
  });

  app.get("/merchants", (_req, res) => {
    res.json({
      merchants: structuring.merchants.map((m) => ({
        ...m,
        items: catalogItems.filter((i) => i.merchant_id === m.merchant_id).length,
        held: catalogItems.filter((i) => i.merchant_id === m.merchant_id && i.needs_merchant_confirmation).length,
        readiness: readinessFor(m.merchant_id),
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
  interface ResolveOutcome { cleared: boolean; remaining: string[]; followUp: string | null; value: number }

  /** One resolution path, whether the answer arrived over HTTP or WhatsApp. */
  function resolveClarification(id: string, value: number): ResolveOutcome | null {
    const clarification = store.getClarification(id);
    if (!clarification || clarification.status === "resolved") return null;

    const index = catalogItems.findIndex((i) => i.item_id === clarification.item_id);
    if (index < 0) return null;

    if (clarification.field === "price") merchantConfirmed.add(clarification.item_id);

    const outcome = applyResolution(catalogItems[index]!, clarification, value, (updated) =>
      priceSanity(
        updated,
        catalogItems.map((i) => (i.item_id === updated.item_id ? updated : i)),
        { merchantConfirmed: merchantConfirmed.has(updated.item_id) },
      ),
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
        store.saveClarification(next);
        void notifier.send(merchant?.whatsapp ?? outcome.item.merchant_id, clarificationMessage(next));
        followUp = next.question;
      }
    }

    bus.emit({
      type: "clarification.resolved",
      merchant_id: clarification.merchant_id,
      item_id: clarification.item_id,
      message: outcome.cleared
        ? `${clarification.item_name} confirmed at ${clarification.field === "price" ? `₹${value}` : `${value} in stock`} — now sellable`
        : `${clarification.item_name} set to ${value}, still held`,
      data: { value, cleared: outcome.cleared, follow_up: followUp },
    });

    return { cleared: outcome.cleared, remaining: outcome.remaining, followUp, value };
  }

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

    const outcome = resolveClarification(id, value);
    if (!outcome) {
      res.status(409).json({ error: "could not resolve" });
      return;
    }

    res.json({
      clarification_id: id,
      item_id: clarification.item_id,
      resolved_value: outcome.value,
      transactable: outcome.cleared,
      still_held_because: outcome.remaining,
      follow_up: outcome.followUp,
    });
  });

  /**
   * Milestone K — the merchant's WhatsApp reply comes back here.
   *
   * Twilio posts form-encoded. The reply is matched to the oldest open question
   * for whoever sent it: a merchant answering "110" is answering the thing they
   * were last asked, and asking them to quote a clarification id would defeat
   * the point of using WhatsApp at all.
   */
  app.post(
    "/webhooks/whatsapp",
    express.urlencoded({ extended: false }),
    (req: Request, res: Response) => {
      const inbound = parseInbound(req.body ?? {});
      if (!inbound) {
        res.status(400).type("text/xml").send("<Response/>");
        return;
      }

      const merchant = structuring.merchants.find(
        (m) => m.whatsapp.replace(/\s/g, "") === inbound.from.replace(/\s/g, ""),
      );
      if (!merchant) {
        res.type("text/xml").send("<Response><Message>Sorry, I don't recognise this number.</Message></Response>");
        return;
      }

      const open = store.listClarifications(merchant.merchant_id).find((c) => c.status === "open");
      if (!open) {
        res.type("text/xml").send("<Response><Message>Nothing is waiting on you right now — thanks!</Message></Response>");
        return;
      }

      const value = parseReply(inbound.text);
      if (value === null) {
        res
          .type("text/xml")
          .send(`<Response><Message>Sorry, I couldn't read a number in that. ${open.question}</Message></Response>`);
        return;
      }

      const outcome = resolveClarification(open.clarification_id, value);
      const reply = outcome?.cleared
        ? `Thanks! ${open.item_name} is live at ${open.field === "price" ? "₹" : ""}${value}.`
        : outcome?.followUp ?? `Noted — ${open.item_name} is still on hold.`;
      res.type("text/xml").send(`<Response><Message>${reply}</Message></Response>`);
    },
  );

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
      bus.emit({
        type: "fulfillment.confirmed",
        transaction_id: chain.transaction_id,
        merchant_id: chain.cart?.merchant_id,
        item_id: chain.cart?.item_id,
        message: `Merchant confirmed handover`,
        data: { note: req.body?.evidence_note ?? null },
      });
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
    const bundle = await buildAuditBundle(chain, keyring);
    bus.emit({
      type: "audit.chain_verified",
      transaction_id: id,
      merchant_id: chain.cart?.merchant_id,
      message: bundle.verified
        ? `Chain verified — ${bundle.timeline.filter((t) => t.present).length} signed mandates`
        : `Chain REJECTED — ${bundle.failures.join("; ")}`,
      data: { verified: bundle.verified, status: bundle.status },
    });
    res.json(bundle);
  });

  app.get("/transactions", (_req, res) => {
    res.json({ transactions: store.listTransactions() });
  });

  return { app, store, keyring, catalog: catalogItems, gateway, structuring, notifier, bus };
}

/**
 * Attach the realtime layer to a listening HTTP server.
 *
 * Separate from createApp because the bus works perfectly well without a socket
 * — the milestone scripts subscribe in-process — and an Express app has no
 * server to attach to until someone listens.
 */
export function attachRealtime(httpServer: HttpServer, bus: EventBus): IOServer {
  const io = new IOServer(httpServer, { cors: { origin: "*" } });

  io.on("connection", (socket) => {
    // Until told otherwise a viewer sees everything.
    socket.join(ROOM_ALL);

    // A viewer says what it wants to watch; it gets the backlog immediately so
    // a dashboard opened mid-transaction is not staring at an empty panel.
    socket.on("watch", (filter: { transaction_id?: string; merchant_id?: string }) => {
      const scoped = Boolean(filter?.transaction_id || filter?.merchant_id);
      // Narrowing means leaving the firehose — otherwise a scoped viewer would
      // receive both the broadcast and its own room's copy.
      if (scoped) socket.leave(ROOM_ALL);
      if (filter?.transaction_id) socket.join(`txn:${filter.transaction_id}`);
      if (filter?.merchant_id) socket.join(`merchant:${filter.merchant_id}`);
      socket.emit("backlog", bus.recent({ ...filter, limit: 200 }));
    });

    socket.emit("backlog", bus.recent({ limit: 200 }));
  });

  bus.attach(io);
  return io;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()!);
if (isMain) {
  const port = Number(process.env.PORT || 3000);
  createApp()
    .then(({ app, gateway, bus, notifier }) => {
      const httpServer = createServer(app);
      attachRealtime(httpServer, bus);
      httpServer.listen(port, () => {
        console.log(
          `Vyapar-to-Agent on http://localhost:${port}  ` +
            `(gateway: ${gateway.kind}, clarifications: ${notifier.channel}, realtime: on)`,
        );
      });
    })
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    });
}
