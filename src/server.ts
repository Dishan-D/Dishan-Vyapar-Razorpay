import express, { type Request, type Response } from "express";
import path from "node:path";
import { createServer, type Server as HttpServer } from "node:http";
import { Server as IOServer } from "socket.io";
import QRCode from "qrcode";
import multer from "multer";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { OnboardingStore, type OnboardedMerchant } from "./onboarding/store.js";
import { DemandLog } from "./revenue/demand.js";
import { findOpportunities } from "./revenue/opportunities.js";
import { buildRecoveryCases, RecoveryLog, RECOVERY_POLICY } from "./revenue/recovery.js";
import { reconcile } from "./finance/reconcile.js";
import { assessSignals } from "./risk/signals.js";
import { recommend, type Intervention } from "./risk/intervention.js";
import { extractStorefront } from "./structuring/storefront.js";
import { transcribe, AUDIO_EXTENSIONS, TRANSCRIBE_MODEL } from "./structuring/transcribe.js";
import { toCatalogItem, evaluateGate } from "./structuring/extraction.js";
import { buildAuditBundle } from "./audit/bundle.js";
import { buildCommerceHistory } from "./audit/history.js";
import { readinessScore } from "./marketplace/readiness.js";
import { compareMerchants } from "./marketplace/compare.js";
import { parseIntent } from "./agent/intent.js";
import { readPolicyRequest, proposeChange } from "./agent/policy.js";
import { ask as askMerchantAgent } from "./agent/merchant.js";
import { TOOLS, type ToolCall, type ToolResult } from "./agent/tools.js";
import { discover } from "./catalog/discovery.js";
import { Store } from "./db/store.js";
import { confirmFulfillment, FulfillmentRefused } from "./fulfillment/confirm.js";
import { buildCartMandate, buildIntentMandate, type MandateChain, verifyChain } from "./mandates/chain.js";
import { loadOrCreateKeyring } from "./mandates/keystore.js";
import type { CatalogItem, NegotiationPolicy } from "./mandates/schema.js";
import { negotiate } from "./negotiation/engine.js";
import { phraseTurns, templateLine } from "./negotiation/phrasing.js";
import { indexPolicies } from "./negotiation/policies.js";
import { gatewayFromEnv, publishableKeyId, razorpayCredentials, SimulatedGateway, type PaymentGateway } from "./payments/gateway.js";
import {
  probeCapabilities, createPaymentLink, fetchPaymentLink, cancelPaymentLink, createInvoice,
  type Capability,
} from "./payments/razorpay-extras.js";
import { authorizeCart, settlePayment, PaymentRefused, authorizationFor } from "./payments/pay.js";
import { gateReasons } from "./structuring/extraction.js";
import { applyResolution, draftClarification, parseReply } from "./structuring/clarify.js";
import { clarificationMessage, DashboardNotifier, type Notifier } from "./structuring/notify.js";
import {
  parseInbound,
  saleConfirmationMessage,
  twilioConfigFromEnv,
  WhatsAppNotifier,
} from "./structuring/whatsapp.js";
import { converse, shopperText, type Turn } from "./agent/converse.js";
import { converseWithTools } from "./agent/buyerloop.js";
import {
  stateFor, resolveProduct, rank, complementsOf, alternativesTo, variantsOf,
  type ShoppingState,
} from "./agent/shopping.js";
import type { BuyerToolCall, BuyerToolResult } from "./agent/buyer.js";
import { reconcileUpi } from "./finance/upi.js";
import { buildStatement } from "./finance/statement.js";
import { buildDemandHistory } from "./revenue/dataset.js";
import { priceElasticity } from "./revenue/elasticity.js";
import { crossSell, upsell, deadStock, type Opportunity } from "./revenue/agent.js";
import OpenAI from "openai";
import { GROQ_BASE_URL, GROQ_MODEL } from "./llm/provider.js";
import { INTERACTIVE_MAX_WAIT_SECONDS, sharedGroqGovernor } from "./llm/ratelimit.js";
import { buyersFor as demoBuyers } from "./demo/buyers.js";
import * as merchantActions from "./merchant/actions.js";
import { readUpiUri, fixedAmountWarning } from "./merchant/upi-qr.js";
import { describeThrown } from "./payments/gateway.js";
import {
  MERCHANT_TOOLS,
  toolByName as merchantToolByName,
  asFunctionSchemas as merchantFunctionSchemas,
  unheld,
  activityFor,
} from "./agent/merchant-tools.js";
import { route as routeMerchant, DOMAIN_LABEL, suggestions as merchantOpeners } from "./agent/supervisor.js";
import {
  toTransactions,
  merchantStats,
  productStats,
  checkIntegrity,
  customerStats,
  lapsedCustomers,
  summarise,
  contributors,
  type Txn,
  type Attribution,
} from "./analytics/ledger.js";
import { productTile } from "./catalog/tile.js";
import { priceSanity } from "./structuring/sanity.js";
import { EventBus, ROOM_ALL } from "./events/bus.js";
import { activeProvider } from "./llm/provider.js";
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

  // ── Onboarding: shops created at runtime join the seeded three ─────────────
  const onboarding = new OnboardingStore(store.handle);
  const demand = new DemandLog(store.handle);
  const recoveryLog = new RecoveryLog(store.handle);
  const UPLOAD_DIR = path.resolve("data", "uploads");
  await mkdir(UPLOAD_DIR, { recursive: true });

  /** Audio goes to the same folder; only the accepted types differ. */
  const uploadAudio = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
      filename: (_req, file, cb) =>
        cb(null, `${randomUUID().slice(0, 8)}${AUDIO_EXTENSIONS[file.mimetype] ?? path.extname(file.originalname) ?? ".webm"}`),
    }),
    limits: { fileSize: 25 * 1024 * 1024, files: 1 },
    fileFilter: (_req, file, cb) => cb(null, /^audio\/|^video\/webm/.test(file.mimetype)),
  });

  const upload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
      filename: (_req, file, cb) =>
        cb(null, `${randomUUID().slice(0, 8)}${path.extname(file.originalname).toLowerCase() || ".jpg"}`),
    }),
    limits: { fileSize: 12 * 1024 * 1024, files: 8 },
    fileFilter: (_req, file, cb) => cb(null, /^image\//.test(file.mimetype)),
  });

  /** Photos a merchant uploaded, served back for their own catalog. */
  const photoUrlFor = new Map<string, string>();

  /** Load anything onboarded in a previous run back into the live catalog. */
  function restoreOnboarded(): void {
    for (const m of onboarding.listMerchants()) {
      if (!merchants.has(m.merchant_id)) {
        merchants.set(m.merchant_id, m);
        structuring.merchants.push(m);
      }
    }
    /**
     * A stored row is the merchant's own word and outranks the seed.
     *
     * This used to skip any product that already existed in the catalog, which
     * silently made every edit to a shipped product temporary: a shopkeeper
     * corrected a price, replaced a photo, changed a stock count, saw it work,
     * reloaded, and got the seeded values back. The write had gone to the
     * database each time and been ignored on the way out.
     *
     * The seed is a starting point. Once a merchant has touched a row, theirs
     * is the version that counts.
     */
    // Anything the merchant deleted stays deleted, however it got there.
    const gone = new Set(onboarding.listDeleted());
    for (let i = catalogItems.length - 1; i >= 0; i--) {
      const id = catalogItems[i]!.item_id;
      if (!gone.has(id)) continue;
      catalogItems.splice(i, 1);
      policies.delete(id);
      merchantConfirmed.delete(id);
    }

    for (const row of onboarding.listItems()) {
      if (gone.has(row.item.item_id)) continue;
      const at = catalogItems.findIndex((i) => i.item_id === row.item.item_id);
      if (at === -1) catalogItems.push(row.item);
      else catalogItems[at] = row.item;

      if (row.policy) policies.set(row.policy.item_id, row.policy);
      if (row.photo_url) photoUrlFor.set(row.item.item_id, row.photo_url);
      // Anything the merchant has edited is confirmed by definition — they
      // typed it — so it must not come back wearing the seed's held flag.
      if (!row.item.needs_merchant_confirmation) merchantConfirmed.add(row.item.item_id);
    }
  }
  /** Which products have a fetched stock photo on disk. Read once. */
  const genericPhotos = new Set<string>();
  try {
    for (const f of readdirSync(path.resolve("data", "sample_products", "generic"))) {
      if (f.endsWith(".jpg")) genericPhotos.add(f.replace(/\.jpg$/, ""));
    }
  } catch {
    /* none fetched yet — every product falls back to a drawn tile */
  }

  restoreOnboarded();

  /**
   * Give each seeded shop a history of AI-buyer demand.
   *
   * The revenue screens are answers to "what did buyers want and what did you
   * lose"; on an empty database the honest answer is "nothing yet", which is
   * correct and shows a merchant nothing. So each seed shop starts with a body
   * of past demand whose outcomes were decided by the production negotiation
   * engine rather than written down here.
   *
   * Only for the shops that ship with the demo. A shop somebody onboards during
   * a demo gets a real, empty history — inventing customers for a stranger's
   * shop would be a lie told to the one person able to catch it.
   */
  function seedDemandHistory(): void {
    for (const merchantId of merchants.keys()) {
      if (demand.forMerchant(merchantId, "1970-01-01").length > 0) continue;
      for (const event of buildDemandHistory(merchantId, catalogItems, policies)) {
        demand.record(event);
      }
    }
  }
  seedDemandHistory();

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
  async function confirmSale(merchantId: string, itemName: string, price: number, txn = ""): Promise<void> {
    const merchant = merchants.get(merchantId);
    if (!merchant) return;
    const sent = await notifier
      .send(merchant.whatsapp, saleConfirmationMessage(itemName, price))
      .catch((err) => ({ sent: false, error: describeThrown(err) }));
    console.log(
      `[sale] ${txn} ${merchant.name} · ${itemName} ₹${price} · ${notifier.channel} ` +
        ((sent as { sent: boolean }).sent ? "sent" : `not sent: ${(sent as { error?: string }).error ?? "unknown"}`),
    );
  }

  /**
   * Tell the shop a sale happened, once, however the payment arrived.
   *
   * Every capture path routes through here — the browser's Checkout callback,
   * the Razorpay webhook, and the simulated rail — because a shopkeeper does
   * not care which of those settled it and a message that only fires on one of
   * them is worse than none. Deduplicated per transaction, since the webhook
   * and the callback routinely both land.
   */
  /**
   * Read the caller's stated reason for this purchase.
   *
   * The storefront knows it and nothing else does: a run started from the
   * search results is organic, one started from the "add these too" panel is a
   * cross-sell, one from the bigger-size suggestion is an upsell. An unstated
   * or unrecognised value is recorded as organic rather than guessed at —
   * under-crediting the Revenue Agent is a much smaller sin than a growth
   * figure that counts sales it had nothing to do with.
   */
  const ATTRIBUTIONS: readonly Attribution[] = ["organic", "cross_sell", "upsell", "revenue_agent"];
  function statedAttribution(body: unknown): Attribution {
    const said = String((body as { attribution?: unknown } | null)?.attribution ?? "").trim();
    return (ATTRIBUTIONS as readonly string[]).includes(said) ? (said as Attribution) : "organic";
  }

  const announced = new Set<string>();
  function announceSale(transactionId: string, itemId: string, price: number): void {
    if (announced.has(transactionId)) return;
    announced.add(transactionId);
    const item = catalogItems.find((i) => i.item_id === itemId);
    if (!item) return;
    sellStock(item, transactionId);
    void confirmSale(item.merchant_id, item.name, price, transactionId);
  }

  /**
   * Take the sold unit off the shelf.
   *
   * This had been missing entirely: a product could be bought repeatedly and
   * still report the stock it shipped with, so "3 in stock" meant "3 when we
   * seeded it" and the shop could sell its last saree four times over. Stock
   * is the one number a shopkeeper checks against the physical shelf, and a
   * dashboard that disagrees with the shelf is worse than no dashboard.
   *
   * Only on money actually captured — the caller is the deduped capture point,
   * so an abandoned checkout, a failed payment or a webhook arriving twice all
   * leave the count alone. It floors at zero rather than going negative:
   * negative inventory is never true, and if two sales race for the last unit
   * that is a real oversell for a human to sort out, not something to record as
   * "-1 on the shelf".
   */
  function sellStock(item: CatalogItem, transactionId: string, qty = 1): void {
    const before = item.stock.quantity;
    const after = Math.max(0, before - qty);
    if (after === before) return;

    item.stock = { ...item.stock, quantity: after };
    // Persist through the same path a merchant's own edit takes, so the new
    // count survives a restart instead of being restored from the seed.
    onboarding.saveItem({
      item,
      policy: policies.get(item.item_id),
      photo_url: photoUrlFor.get(item.item_id),
    });

    if (before - qty < 0) {
      console.warn(`[stock] ${transactionId} sold ${item.name} with ${before} on the shelf — oversold, floored at 0`);
    }
    bus.emit({
      type: "stock.changed",
      merchant_id: item.merchant_id,
      item_id: item.item_id,
      message: `${item.name}: ${before} → ${after} after a sale`,
      data: { before, after, transaction_id: transactionId },
    });
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

  // Set once the server binds; the agent's tools read our own endpoints so
  // there is exactly one implementation of every answer.
  let localPort = Number(process.env.PORT || 3000);

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

      // Anyone can POST here, so nothing below this line runs on a body this
      // endpoint cannot authenticate. A gateway with no way to check a
      // signature is the same answer as a bad signature — "I cannot establish
      // that this is you" — and it is 401, not 503: a service-unavailable reply
      // invites a retry that will fail identically, and blurs a refusal into an
      // outage.
      if (!gateway.verifyWebhookSignature) {
        res.status(401).json({
          error: "this gateway cannot verify webhook signatures, so no webhook is accepted",
        });
        return;
      }
      if (!signature || !gateway.verifyWebhookSignature(raw, signature)) {
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
          { verifiedByGateway: true, merchant: merchants.get(item.merchant_id) },
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
        announceSale(transactionId, item.item_id, chain.cart?.final_price.value ?? 0);
        res.json({ status: "settled", transaction_id: transactionId, payment_id: paid.payment_id });
      } catch (err) {
        if (err instanceof PaymentRefused) {
          console.warn(`[webhook] ${transactionId} refused: ${err.reasons.join("; ")}`);
          res.status(402).json({ error: "payment refused", reasons: err.reasons });
          return;
        }
        // Razorpay retries a webhook that does not return 2xx, so a failure
        // that is never logged is one that will happen again, silently, for as
        // long as they keep trying.
        const why = describeThrown(err);
        console.error(`[webhook] ${transactionId} (order ${orderId}) failed: ${why}`);
        res.status(500).json({ error: why });
      }
    },
  );

  app.use(express.json());
  // No caching on the front end. A demo machine reloading a page it edited two
  // minutes ago and getting yesterday's JavaScript is a whole afternoon lost to
  // a bug that was already fixed.
  app.use(
    express.static(path.resolve("frontend"), {
      etag: false,
      lastModified: false,
      setHeaders: (res) => res.setHeader("Cache-Control", "no-store, must-revalidate"),
    }),
  );
  // The merchant's own photos, served as-is. They are the input to Stage 1, so
  // showing them next to what was extracted is the point, not decoration.
  app.use("/media", express.static(path.resolve("data", "sample_products")));
  // Illustrative stock photos, one per product, fetched once by
  // scripts/fetch-photos.mjs and served locally so a demo never depends on
  // someone else's CDN being up.
  app.use("/generic", express.static(path.resolve("data", "sample_products", "generic")));
  app.use("/uploads", express.static(path.resolve("data", "uploads")));

  /**
   * jsQR, served from node_modules rather than a CDN.
   *
   * A shop's connection is not something to depend on mid-demo, and a merchant
   * uploading their payment QR should not need the page to reach a third party
   * to read it. The decode happens in their browser; the image never leaves the
   * device for this.
   */
  app.use(
    "/vendor",
    express.static(path.resolve("node_modules", "jsqr", "dist"), {
      // The page imports it as an ES module; the package ships UMD, so the one
      // file is aliased to the name the page asks for.
      index: false,
      setHeaders: (res) => res.setHeader("cache-control", "public, max-age=86400"),
    }),
  );
  app.get("/vendor/jsQR.js", (_req: Request, res: Response) => {
    res.type("application/javascript").sendFile(path.resolve("node_modules", "jsqr", "dist", "jsQR.js"));
  });

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      gateway: gateway.kind,
      merchants: structuring.merchants.length,
      catalog_size: catalogItems.length,
      catalog_provider: structuring.provider,
      catalog_sources: structuring.sourceCounts,
      transcription: activeProvider() === "groq" ? TRANSCRIBE_MODEL : null,
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
  /**
   * A generated tile for a product with no photograph.
   *
   * Rendered on request rather than written to disk: it is derived entirely
   * from the product's id, name and category, so there is nothing to keep in
   * sync and nothing to clean up when a real photo replaces it.
   */
  app.get("/media/tile/:itemId.svg", (req: Request, res: Response) => {
    const id = String(req.params.itemId);
    const item = catalogItems.find((i) => i.item_id === id);
    if (!item) {
      res.status(404).type("text/plain").send("no such product");
      return;
    }
    res.type("image/svg+xml");
    res.setHeader("cache-control", "public, max-age=3600");
    res.send(productTile(item.item_id, item.name, item.category));
  });

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
          // Three sources, in descending order of what they prove. The
          // merchant's own upload is evidence of their stock. A stock photo
          // matched by keyword looks like the product but is somebody else's
          // cake. A drawn tile claims nothing at all. Whichever is used, the
          // row says which — a screen that cannot tell them apart would be
          // presenting a stranger's photograph as evidence of this shop's
          // inventory.
          photo_url:
            photoUrlFor.get(item.item_id) ??
            (photo?.present && photo.filename
              ? `/media/${photo.filename}`
              : genericPhotos.has(item.item_id)
                ? `/generic/${item.item_id}.jpg`
                : `/media/tile/${item.item_id}.svg`),
          photo_is_illustrative:
            !photoUrlFor.get(item.item_id) &&
            !(photo?.present && photo.filename) &&
            genericPhotos.has(item.item_id),
          photo_is_placeholder:
            !photoUrlFor.get(item.item_id) &&
            !(photo?.present && photo.filename) &&
            !genericPhotos.has(item.item_id),
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
      store.recordAttribution(transaction_id, statedAttribution(req.body));

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
      const order = await authorizeCart(chain, item, keyring, gateway, {
        merchant: merchants.get(item.merchant_id),
      });
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

      const paid = await settlePayment(chain, item, keyring, gateway, order, undefined, {
        merchant: merchants.get(item.merchant_id),
      });
      store.appendMandate(transaction_id, paid.payment);
      bus.emit({
        type: "payment.captured",
        transaction_id,
        merchant_id: item.merchant_id,
        item_id: item.item_id,
        message: `Payment captured — ₹${outcome.final_price} for ${item.name}`,
        data: { payment_id: paid.payment_id, order_id: paid.order_id, amount: outcome.final_price },
      });
      announceSale(transaction_id, item.item_id, outcome.final_price);
      res.status(201).json({ ...common, status: "paid", payment_id: paid.payment_id });
    } catch (err) {
      if (err instanceof PaymentRefused) {
        res.status(402).json({ error: "payment refused", reasons: err.reasons });
        return;
      }
      res.status(500).json({ error: describeThrown(err) });
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
      const paid = await settlePayment(
        chain,
        item,
        keyring,
        gateway,
        order,
        {
          razorpay_payment_id: String(req.body?.razorpay_payment_id ?? ""),
          razorpay_signature: req.body?.razorpay_signature,
        },
        { merchant: merchants.get(item.merchant_id) },
      );
      store.appendMandate(id, paid.payment);
      bus.emit({
        type: "payment.captured",
        transaction_id: id,
        merchant_id: item.merchant_id,
        item_id: item.item_id,
        message: `Payment captured — ${paid.payment_id}`,
        data: { payment_id: paid.payment_id, order_id: paid.order_id },
      });
      announceSale(id, item.item_id, chain.cart?.final_price.value ?? 0);
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
      res.status(500).json({ error: describeThrown(err) });
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
    // The client sends its own run id so it can subscribe to the steps before
    // the response comes back — otherwise it would only learn the id at the end,
    // which is exactly when live progress stops being useful.
    const runId = typeof req.body?.run_id === "string" && req.body.run_id
      ? String(req.body.run_id).slice(0, 64)
      : `run_${Date.now().toString(36)}`;

    const trace: Array<Record<string, unknown>> = [];
    const startedAt = Date.now();

    const step = (
      stage: string,
      headline: string,
      detail: Record<string, unknown> = {},
      decidedBy: "model" | "rules" = "rules",
      merchantId?: string,
    ) => {
      const elapsed_ms = Date.now() - startedAt;
      const entry = { stage, headline, decided_by: decidedBy, at: new Date().toISOString(), elapsed_ms, ...detail };
      trace.push(entry);

      console.log(
        `[agent ${runId}] ${String(elapsed_ms).padStart(5)}ms  ${stage.padEnd(10)} ${decidedBy.padEnd(5)}  ${headline}`,
      );

      // Published as it happens, so a watcher sees the run unfold rather than a
      // spinner followed by everything at once.
      bus.emit({
        type: "agent.step",
        message: headline,
        // Named where one applies, so a view of the market can light the shop
        // this step is about. Without it every step looked market-wide and the
        // network view sat still through an entire purchase.
        ...(merchantId ? { merchant_id: merchantId } : {}),
        // The step's own detail travels with it. Without this a watcher got
        // the headline and nothing else, so a live view could say "checked 3
        // shops" but could not show which three — the interesting half.
        data: { run_id: runId, stage, decided_by: decidedBy, elapsed_ms, ...detail },
      });
    };

    try {
      console.log(`[agent ${runId}] goal: "${goal}" (settle: ${useTestRail ? "test_rail" : "gateway"})`);
      step("start", "Reading what you asked for…");

      // 1 — language → mandate
      const parsed = await parseIntent(goal);
      // A caller may pin the mandate instead of having it read. Useful when a
      // run has to behave the same way twice — the model's opening offer varies
      // between runs, which is fine in life and unhelpful on stage.
      const pinned = {
        ...(typeof req.body?.max_price === "number" ? { max_price: req.body.max_price } : {}),
        ...(typeof req.body?.opening_offer === "number" ? { opening_offer: req.body.opening_offer } : {}),
      };
      const { parsedBy, fallbackReason, droppedAttributes } = parsed;
      const intent = { ...parsed.intent, ...pinned };
      if (fallbackReason) {
        console.warn(`[agent] intent parsing fell back to rules — ${fallbackReason}`);
      }
      if (droppedAttributes?.length) {
        console.warn(`[agent ${runId}] discarded invented requirements: ${droppedAttributes.join(", ")}`);
      }
      step(
        "understand",
        `Read that as: ${intent.want}, ceiling ₹${intent.max_price}`,
        {
          intent,
          parsed_by: parsedBy,
          note: intent.reasoning,
          ...(fallbackReason ? { fallback_reason: fallbackReason } : {}),
          ...(droppedAttributes?.length ? { dropped_attributes: droppedAttributes } : {}),
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
      step("shopping", `Checking ${views.length} shops…`);
      for (const view of views) {
        bus.emit({
          type: "discovery.queried",
          merchant_id: view.merchant_id,
          message: `Asking ${view.name}`,
          data: { run_id: runId, want: intent.want },
        });
      }
      const attributes: Record<string, string> = {};
      for (const { key, value } of intent.attributes ?? []) attributes[key] = value;

      /**
       * When the shopper confirmed a specific product, buy that product.
       *
       * A confirmation names one thing — "Buy Blue Cotton Saree from Meena's,
       * up to ₹1,400" — and the run that follows must not re-open the question
       * by searching the whole shelf again. Text search is how the wrong saree
       * gets bought after the right one was approved, so the catalog handed to
       * the comparison is narrowed to exactly the confirmed item.
       */
      const pinnedItemId = typeof req.body?.item_id === "string" ? req.body.item_id.trim() : "";
      const shoppable = pinnedItemId
        ? catalogItems.filter((i) => i.item_id === pinnedItemId)
        : catalogItems;
      if (pinnedItemId && shoppable.length === 0) {
        step("stop", `No product with id ${pinnedItemId}`, { item_id: pinnedItemId });
        res.status(404).json({ run_id: runId, goal, status: "no_match", reason: `no such product: ${pinnedItemId}`, trace });
        return;
      }

      /**
       * A pinned purchase carries no category or attribute filter.
       *
       * The shopper has already picked the product; re-applying a constraint
       * the model inferred could only exclude the very thing they confirmed.
       *
       * This reasoning was written for the search and then applied only there,
       * while the authorization gate below went on testing the same inferred
       * adjectives — so a run could find the confirmed cake and then refuse it.
       * The money ceiling is untouched either way: that is the shopper's own
       * number and the only one the gate exists to enforce. An adjective a
       * model guessed from a sentence is not authorization, and it has no
       * business overruling a product the shopper pointed at.
       */
      const filters = pinnedItemId ? {} : attributes;

      const comparison = compareMerchants(
        intent.want,
        { buyer_agent_id: "agent_xyz", max_price: intent.max_price, opening_offer: intent.opening_offer },
        views,
        shoppable,
        policies,
        pinnedItemId
          ? {}
          : {
              ...(intent.category ? { category: intent.category } : {}),
              ...(Object.keys(filters).length > 0 ? { attributes: filters } : {}),
            },
      );
      // Recorded per shop, not per search: a merchant needs to know that buyers
      // came to them and left, which a search-level log cannot tell them.
      const now = new Date().toISOString();
      for (const offer of comparison.offers) {
        demand.record({
          at: now,
          want: intent.want,
          max_price: intent.max_price,
          merchant_id: offer.merchant_id,
          item_id: offer.item_id,
          outcome: offer.eligible ? "sold" : "lost_on_price",
          asked_price: offer.list_price,
          offered_price: offer.final_price,
          opening_offer: intent.opening_offer,
          detail: offer.note,
        });
      }
      // Shops that stock nothing matching still saw the demand go past them.
      for (const view of views) {
        if (comparison.offers.some((o) => o.merchant_id === view.merchant_id)) continue;
        const heldMatch = catalogItems.some(
          (i) => i.merchant_id === view.merchant_id && i.needs_merchant_confirmation,
        );
        demand.record({
          at: now,
          want: intent.want,
          max_price: intent.max_price,
          merchant_id: view.merchant_id,
          item_id: null,
          outcome: heldMatch ? "held" : "no_match",
          asked_price: null,
          offered_price: null,
          opening_offer: intent.opening_offer,
          detail: null,
        });
      }

      step("shop", `Checked ${views.length} shops; ${comparison.offers.length} stock it`, {
        offers: comparison.offers.map((o) => ({
          merchant_id: o.merchant_id,
          merchant_name: o.merchant_name,
          item_id: o.item_id,
          item_name: o.item_name,
          readiness: o.readiness.score,
          list_price: o.list_price,
          final_price: o.final_price,
          effective_price: o.effective_price,
          rounds: o.outcome.rounds,
          log: o.outcome.log,
          eligible: o.eligible,
          note: o.note,
        })),
      });

      if (!comparison.selected) {
        // Two different answers used to wear one label: nobody stocking the
        // thing is not the same as nobody agreeing a price for it, and a
        // shopper needs to know which of those happened.
        const nobodyStocks = comparison.offers.length === 0;
        step(
          "stop",
          nobodyStocks ? `No shop stocks ${intent.want}` : "Nobody would sell it inside your budget",
          { reasoning: comparison.reasoning },
        );
        res.json({
          run_id: runId,
          goal,
          intent,
          status: nobodyStocks ? "no_match" : "no_deal",
          reason: nobodyStocks
            ? `Nothing matching "${intent.want}" is on offer from the shops I can reach.`
            : comparison.reasoning[comparison.reasoning.length - 1] ?? "no agreement reached",
          trace,
          comparison,
        });
        return;
      }

      // Work down the eligible offers rather than stopping at the first one that
      // fails the gate. A blocked candidate is information, not a dead end —
      // the shopper asked for a thing, and another shop may still have it.
      const candidates = comparison.offers.filter((o) => o.eligible);
      const rejected: Array<{ merchant: string; reasons: string[] }> = [];

      let chosen: (typeof candidates)[number] | null = null;
      let item: CatalogItem | null = null;
      let mandateIntent: Awaited<ReturnType<typeof buildIntentMandate>> | null = null;
      let cart: Awaited<ReturnType<typeof buildCartMandate>> | null = null;
      let transaction_id = "";
      let authority: ReturnType<typeof authorizationFor> = null;

      for (const candidate of candidates) {
        const candidateItem = catalogItems.find((i) => i.item_id === candidate.item_id);
        if (!candidateItem) continue;

        const draftIntent = await buildIntentMandate(
          {
            issuer: keyring.get("buyer_agent").kid,
            buyer_agent_id: "agent_xyz",
            constraints: {
              max_price: intent.max_price,
              category: intent.category ?? "",
              ttl_seconds: 600,
              ...(Object.keys(filters).length > 0 ? { attributes: filters } : {}),
              ...(intent.deliver_within_days >= 0 ? { deliver_within_days: intent.deliver_within_days } : {}),
            },
            prompt_playback: goal,
          },
          keyring,
        );

        const draftCart = await buildCartMandate(
          draftIntent,
          {
            item_id: candidateItem.item_id,
            final_price: { value: candidate.final_price!, currency: "INR" },
            merchant_id: candidateItem.merchant_id,
          },
          keyring,
        );

        const result = authorizationFor(
          { transaction_id: "draft", intent: draftIntent, cart: draftCart },
          candidateItem,
          merchants.get(candidateItem.merchant_id),
        );

        if (result?.authorized) {
          chosen = candidate;
          item = candidateItem;
          mandateIntent = draftIntent;
          cart = draftCart;
          authority = result;
          break;
        }

        rejected.push({ merchant: candidate.merchant_name, reasons: result?.failures ?? ["authorization failed"] });
        demand.record({
          at: new Date().toISOString(),
          want: intent.want,
          max_price: intent.max_price,
          merchant_id: candidate.merchant_id,
          item_id: candidate.item_id,
          outcome: "no_match",
          asked_price: candidate.list_price,
          offered_price: candidate.final_price,
          opening_offer: intent.opening_offer,
          detail: (result?.failures ?? []).join("; "),
        });
        step(
          "blocked",
          `${candidate.merchant_name} ruled out — ${result?.failures[0] ?? "does not match"}`,
          { merchant_id: candidate.merchant_id, item_name: candidate.item_name, checks: result?.checks ?? [] },
          "rules",
          candidate.merchant_id,
        );
      }

      if (!chosen || !item || !mandateIntent || !cart) {
        step("stop", "Nothing on offer satisfied what you asked for", {
          considered: comparison.offers.length,
          rejected,
        });
        res.json({
          run_id: runId, goal, intent, status: "no_match",
          reason: rejected.length > 0
            ? `${rejected.length} shop(s) had something close, but none matched every requirement`
            : "no shop stocks a match",
          rejected, trace, comparison,
        });
        return;
      }

      step(
        "choose",
        `Chose ${chosen.merchant_name} at ₹${chosen.final_price}`,
        {
          reasoning: comparison.reasoning,
          merchant_id: chosen.merchant_id,
          effective_price: chosen.effective_price,
          ...(rejected.length > 0 ? { after_ruling_out: rejected.length } : {}),
        },
        "rules",
        chosen.merchant_id,
      );

      transaction_id = `txn_${Date.now().toString(36)}`;
      store.createTransaction({
        transaction_id,
        item_id: item.item_id,
        merchant_id: item.merchant_id,
        buyer_agent_id: "agent_xyz",
      });
      store.recordAttribution(transaction_id, statedAttribution(req.body));
      store.appendMandate(transaction_id, mandateIntent);
      store.appendMandate(transaction_id, cart);

      step(
        "sign",
        "Intent and cart mandates signed",
        {
          transaction_id,
          prompt_playback: goal,
          constraints: mandateIntent.constraints,
          note: "the shopper's own words are inside the signed intent, so the mandate says what it was for",
        },
        "rules",
        item.merchant_id,
      );

      step("authorize", "Purchase authorized", { checks: authority?.checks ?? [], authorized: true }, "rules", item.merchant_id);

      const chain: MandateChain = { transaction_id, intent: mandateIntent, cart };

      const order = await authorizeCart(chain, item, keyring, runGateway, {
        merchant: merchants.get(item.merchant_id),
      });
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
        console.log(`[agent ${runId}] handed off to checkout in ${Date.now() - startedAt}ms`);
        res.status(201).json({
          run_id: runId, goal, intent, status: "awaiting_payment", transaction_id,
          order_id: order.order_id, amount_paise: order.amount_paise,
          final_price: chosen.final_price, merchant: chosen.merchant_name,
          item_id: item.item_id, trace, comparison,
        });
        return;
      }

      const paid = await settlePayment(chain, item, keyring, runGateway, order, undefined, {
        merchant: merchants.get(item.merchant_id),
      });
      store.appendMandate(transaction_id, paid.payment);
      chain.payment = paid.payment;
      bus.emit({
        type: "payment.captured",
        transaction_id,
        merchant_id: item.merchant_id,
        item_id: item.item_id,
        message: `Agent paid ₹${chosen.final_price} to ${chosen.merchant_name}`,
        data: { payment_id: paid.payment.razorpay_payment_id, amount: chosen.final_price },
      });
      announceSale(transaction_id, item.item_id, chosen.final_price!);
      step("pay", `Paid ₹${chosen.final_price}`, {
        merchant_id: item.merchant_id,
        order_id: paid.order_id,
        payment_id: paid.payment_id,
        rail: useTestRail ? "test rail" : "razorpay",
        ...(useTestRail
          ? { note: "settled on the simulated rail so the agent could finish unattended — ids are sim_ prefixed and are not Razorpay's" }
          : {}),
      }, "rules", item.merchant_id);

      // 4 — and here the agent stops, unconditionally. It can spend money; it
      // cannot hand goods across a counter, and nothing here will pretend it did.
      step(
        "wait",
        "Paid, not delivered",
        {
          note: "the agent has no way to confirm a handover — only the shopkeeper's signature closes this",
          status: "payment_confirmed_awaiting_fulfillment",
        },
        "rules",
        item.merchant_id,
      );

      console.log(`[agent ${runId}] done in ${Date.now() - startedAt}ms`);
      res.status(201).json({
        run_id: runId, goal, intent, status: "paid", transaction_id,
        order_id: paid.order_id, payment_id: paid.payment_id,
        rail: useTestRail ? "test_rail" : "razorpay",
        final_price: chosen.final_price, merchant: chosen.merchant_name,
        item_id: item.item_id, trace, comparison,
      });
    } catch (err) {
      if (err instanceof PaymentRefused) {
        step("refused", "Payment refused before any gateway call", { reasons: err.reasons });
        res.status(402).json({ run_id: runId, goal, status: "refused", reasons: err.reasons, trace });
        return;
      }
      const message = describeThrown(err);
      console.error(`[agent ${runId}] failed after ${Date.now() - startedAt}ms:`, message);
      step("failed", `The run stopped: ${message}`);
      res.status(500).json({ run_id: runId, error: message, trace });
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

  /**
   * Every merchant and product statistic on one path.
   *
   * Nothing below counts anything itself. Each endpoint asks this for the
   * transactions and then asks the ledger for the summary, so the revenue on
   * the dashboard, the units against a product row and the figures the Revenue
   * Agent reasons over cannot disagree with each other — they are three
   * readings of one list.
   */
  function transactionsNow(): Txn[] {
    const attributions = store.attributions();
    const ids = new Set<string>();
    for (const m of merchants.keys()) {
      for (const id of store.listTransactionIdsForMerchant(m)) ids.add(id);
    }
    const chains = [...ids]
      .map((id) => store.loadChain(id))
      .filter((c): c is NonNullable<typeof c> => Boolean(c));

    return toTransactions(chains, catalogItems, {
      // The catalog price is today's shelf price, which is what a discount on
      // an old sale should be measured against — the shop wants to know what
      // it is giving away now, not what it charged last month.
      listPriceFor: (itemId) => catalogItems.find((i) => i.item_id === itemId)?.price.value ?? null,
      attributionFor: (txnId) => (attributions.get(txnId) as Attribution | undefined) ?? "organic",
    });
  }

  /**
   * Who an agent id belongs to.
   *
   * Regenerated from the same deterministic seed that produced the demo
   * history rather than stored, so there is no second table to fall out of step
   * with the mandates — the id in the signed intent is the key, and the name is
   * derived from it the same way every time. An id nobody recognises comes back
   * as itself, which is the honest answer for a genuinely anonymous agent.
   */
  const buyerNames = new Map<string, string>();
  for (const m of merchants.keys()) {
    for (const b of demoBuyers(m, 182)) buyerNames.set(b.agent_id, b.name);
  }
  const nameForAgent = (agentId: string): string | null => buyerNames.get(agentId) ?? null;

  /** The window a question is about, and the one before it to compare against. */
  function windowsFor(period: string): { now: [Date, Date]; before: [Date, Date]; label: string } {
    const end = new Date();
    const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const back = (d: Date, n: number) => new Date(d.getTime() - n * 86_400_000);

    if (period === "today") {
      const a = startOfDay(end);
      return { now: [a, end], before: [back(a, 1), a], label: "today" };
    }
    if (period === "yesterday") {
      const a = back(startOfDay(end), 1);
      return { now: [a, startOfDay(end)], before: [back(a, 1), a], label: "yesterday" };
    }
    if (period === "month") {
      const a = back(end, 30);
      return { now: [a, end], before: [back(end, 60), a], label: "the last 30 days" };
    }
    const a = back(end, 7);
    return { now: [a, end], before: [back(end, 14), a], label: "the last 7 days" };
  }

  /**
   * How much of this shop's past was generated.
   *
   * Asked by the interface so it can say so. A shop somebody onboards during
   * the demo has a real, empty history and must not be labelled as fiction —
   * and the shops that were seeded should not pretend otherwise.
   */
  app.get("/merchants/:id/history-source", (req: Request, res: Response) => {
    const id = String(req.params.id);
    const ids = store.listTransactionIdsForMerchant(id);
    const generated = ids.filter((t) => t.startsWith("txn_h"));
    const oldest = transactionsNow()
      .filter((t) => t.merchantId === id)
      .map((t) => t.paidAt ?? t.createdAt)
      .sort()[0];
    res.json({
      merchant_id: id,
      total: ids.length,
      generated: generated.length,
      real: ids.length - generated.length,
      since: oldest ? new Date(oldest).toLocaleDateString("en-GB", { month: "short", year: "numeric" }) : null,
      note: "Generated orders run through the real negotiation engine and are signed like any other.",
    });
  });

  /** Ranked buyers, and the ones who have stopped coming. */
  app.get("/merchants/:id/customers", (req: Request, res: Response) => {
    const id = String(req.params.id);
    if (!merchants.has(id)) {
      res.status(404).json({ error: `no such merchant: ${id}` });
      return;
    }
    const all = customerStats(id, transactionsNow(), nameForAgent);
    const quiet = Number(req.query.quiet_days ?? 30);
    res.json({
      merchant_id: id,
      customers: all,
      lapsed: lapsedCustomers(all, { quietDays: quiet }),
      totals: {
        buyers: all.length,
        repeat: all.filter((c) => c.repeat).length,
        repeat_share: all.length === 0 ? 0 : all.filter((c) => c.repeat).length / all.length,
        top5_share: all.slice(0, 5).reduce((s, c) => s + c.contribution, 0),
      },
      note: "Buyers are AI shopping agents acting for people. These are demo identities.",
    });
  });

  /**
   * One period against the one before it, with what moved.
   *
   * The endpoint behind "why are sales down". It measures; it does not
   * conclude — `contributors` returns what changed, ordered by how much, and
   * whatever is said about it upstream has to be one of those lines.
   */
  app.get("/merchants/:id/trend", (req: Request, res: Response) => {
    const id = String(req.params.id);
    if (!merchants.has(id)) {
      res.status(404).json({ error: `no such merchant: ${id}` });
      return;
    }
    const period = String(req.query.period ?? "week");
    const w = windowsFor(period);
    const txns = transactionsNow();

    const now = summarise(id, txns, w.now[0], w.now[1], w.label);
    const before = summarise(id, txns, w.before[0], w.before[1], "the period before");

    // Product movement, measured the same way, so a single line's collapse can
    // be named rather than left inside the total.
    const revBy = (from: Date, to: Date) => {
      const m = new Map<string, number>();
      for (const t of txns) {
        if (t.merchantId !== id) continue;
        const at = Date.parse(t.paidAt ?? t.createdAt);
        if (at < from.getTime() || at >= to.getTime()) continue;
        if (t.status === "awaiting_payment") continue;
        for (const l of t.items) m.set(l.productName, (m.get(l.productName) ?? 0) + l.lineTotal);
      }
      return m;
    };
    const nowP = revBy(w.now[0], w.now[1]);
    const beforeP = revBy(w.before[0], w.before[1]);
    const products = [...new Set([...nowP.keys(), ...beforeP.keys()])].map((name) => ({
      name, now: nowP.get(name) ?? 0, before: beforeP.get(name) ?? 0,
    }));

    const changePct = before.revenue === 0 ? null
      : Math.round(((now.revenue - before.revenue) / before.revenue) * 100);

    res.json({
      merchant_id: id,
      period: w.label,
      now, before,
      change_pct: changePct,
      direction: changePct === null ? "unknown" : changePct > 2 ? "up" : changePct < -2 ? "down" : "flat",
      contributors: contributors(now, before, { products }),
    });
  });

  /** When the shop actually trades, by hour and by weekday. */
  app.get("/merchants/:id/patterns", (req: Request, res: Response) => {
    const id = String(req.params.id);
    if (!merchants.has(id)) {
      res.status(404).json({ error: `no such merchant: ${id}` });
      return;
    }
    const txns = transactionsNow().filter((t) => t.merchantId === id && t.status !== "awaiting_payment");
    const hours = new Array(24).fill(0);
    const days = new Array(7).fill(0);
    for (const t of txns) {
      const d = new Date(t.paidAt ?? t.createdAt);
      hours[d.getHours()] += t.amount;
      days[(d.getDay() + 6) % 7] += t.amount;
    }
    const best = hours.indexOf(Math.max(...hours));
    const DAYNAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
    res.json({
      merchant_id: id,
      by_hour: hours.map((revenue, hour) => ({ hour, revenue })),
      by_weekday: days.map((revenue, i) => ({ day: DAYNAMES[i], revenue })),
      busiest_hour: best,
      busiest_day: DAYNAMES[days.indexOf(Math.max(...days))],
    });
  });

  /** Merchant-level: revenue, orders, by day, by category, by attribution. */
  app.get("/merchants/:id/analytics", (req: Request, res: Response) => {
    const id = String(req.params.id);
    if (!merchants.has(id)) {
      res.status(404).json({ error: `no such merchant: ${id}` });
      return;
    }
    res.json(merchantStats(id, transactionsNow(), catalogItems));
  });

  /** Every product in one shop, so the catalog screen can show real numbers. */
  app.get("/merchants/:id/products/analytics", (req: Request, res: Response) => {
    const id = String(req.params.id);
    if (!merchants.has(id)) {
      res.status(404).json({ error: `no such merchant: ${id}` });
      return;
    }
    const txns = transactionsNow();
    res.json({
      merchant_id: id,
      products: catalogItems
        .filter((i) => i.merchant_id === id)
        .map((i) => productStats(i, txns, i.price.value))
        .sort((a, b) => b.revenue - a.revenue),
    });
  });

  /** One product, including which transactions it came from. */
  app.get("/products/:itemId/analytics", (req: Request, res: Response) => {
    const item = catalogItems.find((i) => i.item_id === String(req.params.itemId));
    if (!item) {
      res.status(404).json({ error: `no such product: ${req.params.itemId}` });
      return;
    }
    res.json(productStats(item, transactionsNow(), item.price.value));
  });

  /**
   * The transactions themselves, unaggregated.
   *
   * Here so that any figure on any screen can be checked against the rows it
   * came from without opening the database. A statistic nobody can audit is
   * indistinguishable from one that is made up.
   */
  app.get("/analytics/transactions", (req: Request, res: Response) => {
    const merchantId = typeof req.query.merchant_id === "string" ? req.query.merchant_id : null;
    const all = transactionsNow();
    res.json({ transactions: merchantId ? all.filter((t) => t.merchantId === merchantId) : all });
  });

  /** Does the data hold together? Empty `faults` is the healthy answer. */
  app.get("/analytics/integrity", (_req: Request, res: Response) => {
    const txns = transactionsNow();
    const faults = checkIntegrity(txns, catalogItems);
    res.status(faults.length === 0 ? 200 : 409).json({
      checked: txns.length,
      ok: faults.length === 0,
      faults,
    });
  });

  /**
   * Step 1 — the shop itself. Deliberately tiny: a name, a place, a UPI id.
   * Anything more would be a form, and the point is that they do not fill in
   * forms.
   */
  app.post("/onboarding/merchants", (req: Request, res: Response) => {
    const name = String(req.body?.name ?? "").trim();
    if (!name) {
      res.status(400).json({ error: "a shop name is required" });
      return;
    }

    const merchant: OnboardedMerchant = {
      merchant_id: `mer_${randomUUID().slice(0, 8)}`,
      name,
      city: String(req.body?.city ?? "").trim() || "—",
      whatsapp: String(req.body?.whatsapp ?? "").trim(),
      upi_vpa: String(req.body?.upi_vpa ?? "").trim() || "not linked yet",
      since: String(req.body?.since ?? new Date().getFullYear()),
      qr_note: String(req.body?.qr_note ?? "").trim() || "QR at the counter",
      delivers_within_days: Number(req.body?.delivers_within_days ?? 1),
      onboarded: true,
      store_summary: null,
      created_at: new Date().toISOString(),
    };

    onboarding.createMerchant(merchant);
    merchants.set(merchant.merchant_id, merchant);
    structuring.merchants.push(merchant);

    bus.emit({
      type: "extraction.completed",
      merchant_id: merchant.merchant_id,
      message: `${merchant.name} started setting up`,
    });
    res.status(201).json(merchant);
  });

  /**
   * Step 2 — whatever they have. Photos, transcribed voice notes, a sentence.
   * No modality is required and none is privileged; they are all just evidence
   * about the same shop, read together in step 3.
   */
  app.post(
    "/onboarding/merchants/:id/inputs",
    upload.array("photos", 8),
    (req: Request, res: Response) => {
      const id = String(req.params.id);
      if (!onboarding.getMerchant(id)) {
        res.status(404).json({ error: `no such shop: ${id}` });
        return;
      }

      const now = new Date().toISOString();
      const files = (req.files as Express.Multer.File[] | undefined) ?? [];
      for (const f of files) onboarding.addInput(id, { kind: "photo", value: f.filename, added_at: now });

      const voice = req.body?.voice_note;
      for (const v of Array.isArray(voice) ? voice : voice ? [voice] : []) {
        if (String(v).trim()) onboarding.addInput(id, { kind: "voice", value: String(v).trim(), added_at: now });
      }
      const description = String(req.body?.description ?? "").trim();
      if (description) onboarding.addInput(id, { kind: "text", value: description, added_at: now });

      const all = onboarding.listInputs(id);
      res.status(201).json({
        merchant_id: id,
        added: { photos: files.length, voice_notes: Array.isArray(voice) ? voice.length : voice ? 1 : 0, text: description ? 1 : 0 },
        totals: {
          photos: all.filter((i) => i.kind === "photo").length,
          voice_notes: all.filter((i) => i.kind === "voice").length,
          text: all.filter((i) => i.kind === "text").length,
        },
      });
    },
  );

  /**
   * A recording, turned into words the merchant can correct.
   *
   * Returned rather than stored straight away: Whisper on a noisy shop floor
   * gets things wrong, and a price it mishears would flow into the catalog as
   * though the shopkeeper had said it. They see the text first.
   */
  app.post(
    "/onboarding/transcribe",
    uploadAudio.single("audio"),
    async (req: Request, res: Response) => {
      const file = req.file as Express.Multer.File | undefined;
      if (!file) {
        res.status(400).json({ error: "no audio received" });
        return;
      }
      try {
        const result = await transcribe(path.join(UPLOAD_DIR, file.filename));
        res.json({ ...result, file: file.filename });
      } catch (err) {
        const message = describeThrown(err);
        console.error("[transcribe] failed:", message);
        res.status(502).json({ error: message, model: TRANSCRIBE_MODEL });
      }
    },
  );

  /**
   * Products the shopkeeper typed out themselves, each with its own photo.
   *
   * The photo-and-voice path has one structural weakness: nothing reliably ties
   * a particular photo to a particular product. A shelf photo may hold six
   * items; two photos may show one. The extraction pairs them positionally and
   * the code says outright that this is a display hint, not a fact.
   *
   * This path removes the ambiguity instead of modelling it. The merchant says
   * "this is the thing, this is its picture, this is what it costs" — and a
   * merchant's own statement is the highest-confidence input in the system, so
   * nothing here is scored, sanity-checked against a model's guess, or held for
   * confirmation. They have already confirmed it by typing it.
   *
   * It is not a replacement for reading photos. It is what a shopkeeper reaches
   * for when they have five things to list and want them right.
   */
  app.post(
    "/onboarding/merchants/:id/items",
    upload.array("photos", 12),
    (req: Request, res: Response) => {
      const id = String(req.params.id);
      /**
       * Any shop this server knows, not only one created in this session.
       *
       * This route was written for the onboarding wizard and checked the
       * onboarding table alone, which meant a merchant who had finished
       * setting up — or who shipped with the demo — could edit and delete
       * products but never add one. A shop that cannot take on a new line is
       * not a shop, and stocking something new is the most ordinary thing a
       * kirana does.
       */
      const merchant = onboarding.getMerchant(id) ?? merchants.get(id);
      if (!merchant) {
        res.status(404).json({ error: `no such shop: ${id}` });
        return;
      }

      let rows: Array<{ name?: unknown; price?: unknown; stock?: unknown; category?: unknown; photo_index?: unknown }>;
      try {
        rows = JSON.parse(String(req.body?.items ?? "[]"));
      } catch {
        res.status(400).json({ error: "`items` must be a JSON array" });
        return;
      }
      if (!Array.isArray(rows) || rows.length === 0) {
        res.status(400).json({ error: "send at least one item" });
        return;
      }

      const files = (req.files as Express.Multer.File[] | undefined) ?? [];
      const now = new Date().toISOString();
      const existing = onboarding.listItems().filter((r) => r.item.merchant_id === id).length;
      const saved: CatalogItem[] = [];
      const rejected: Array<{ index: number; why: string }> = [];

      rows.forEach((row, i) => {
        const name = String(row.name ?? "").trim();
        if (!name) {
          rejected.push({ index: i, why: "no name" });
          return;
        }
        const price = Number(row.price ?? 0);
        const stock = Number(row.stock ?? 0);
        if (!Number.isFinite(price) || price < 0 || !Number.isFinite(stock) || stock < 0) {
          rejected.push({ index: i, why: "price and stock must be zero or more" });
          return;
        }

        const item: CatalogItem = {
          item_id: `itm_${id.slice(4)}_m${String(existing + saved.length + 1).padStart(3, "0")}`,
          merchant_id: id,
          name,
          category: String(row.category ?? "general.other"),
          attributes: {},
          // Stated by the person who owns the stock. There is no more reliable
          // source available to this system, and pretending to be unsure about
          // it would only generate a question they have already answered.
          price: { value: Math.round(price), currency: "INR", confidence: 1 },
          stock: { quantity: Math.round(stock), confidence: 1 },
          source: { type: "merchant_entry", raw_text: name },
          // A priced item is sellable immediately; an unpriced one is not, and
          // that is the merchant's own choice rather than a doubt about them.
          needs_merchant_confirmation: price <= 0,
          extracted_at: now,
        };

        const idx = Number(row.photo_index ?? -1);
        const file = Number.isInteger(idx) && idx >= 0 ? files[idx] : undefined;

        onboarding.clearDeleted(item.item_id);
        onboarding.saveItem({
          item,
          ...(price > 0
            ? {
                policy: {
                  item_id: item.item_id,
                  list_price: item.price.value,
                  floor_price: Math.round(item.price.value * 0.85),
                  max_rounds: 3,
                  set_by: "merchant" as const,
                  set_at: now,
                },
              }
            : {}),
          ...(file ? { photo_url: `/uploads/${file.filename}` } : {}),
        });
        saved.push(item);
      });

      restoreOnboarded();

      res.status(201).json({
        merchant_id: id,
        added: saved.length,
        rejected,
        items: saved.map((i) => ({
          item_id: i.item_id,
          name: i.name,
          price: i.price.value,
          stock: i.stock.quantity,
          sellable: !i.needs_merchant_confirmation,
        })),
      });
    },
  );

  app.get("/onboarding/merchants/:id/inputs", (req: Request, res: Response) => {
    const id = String(req.params.id);
    if (!onboarding.getMerchant(id)) {
      res.status(404).json({ error: `no such shop: ${id}` });
      return;
    }
    res.json({ merchant_id: id, inputs: onboarding.listInputs(id) });
  });

  /**
   * Step 3 — read the lot and build the storefront.
   *
   * Runs the same five stages the seeded merchants go through: draft
   * extraction, price sanity against this shop's own other prices, the combined
   * gate, and a clarification for anything held. Nothing here is a special
   * onboarding path — a shop set up on stage is gated exactly like the fixtures.
   */
  app.post("/onboarding/merchants/:id/structure", async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const merchant = onboarding.getMerchant(id);
    if (!merchant) {
      res.status(404).json({ error: `no such shop: ${id}` });
      return;
    }

    const inputs = onboarding.listInputs(id);
    if (inputs.length === 0) {
      res.status(409).json({ error: "nothing to read yet — add photos, a voice note, or a description first" });
      return;
    }

    try {
      const extraction = await extractStorefront({
        merchant_name: merchant.name,
        ...(inputs.find((i) => i.kind === "text") ? { description: inputs.filter((i) => i.kind === "text").map((i) => i.value).join(" ") } : {}),
        voice_notes: inputs.filter((i) => i.kind === "voice").map((i) => i.value),
        photos: inputs.filter((i) => i.kind === "photo").map((i) => path.join(UPLOAD_DIR, i.value)),
      });

      const photos = inputs.filter((i) => i.kind === "photo");
      const rows = extraction.products.map((product, index) => {
        const item = toCatalogItem(
          {
            item_id: `itm_${id.slice(4)}_${String(index + 1).padStart(3, "0")}`,
            sample_id: `onboard_${index}`,
            merchant_id: id,
            merchant_name: merchant.name,
            voice_note: product.notes,
          },
          {
            sample_id: `onboard_${index}`,
            extraction: product,
            provider: extraction.provider,
            extracted_at: new Date().toISOString(),
          },
        );
        // Photos are attached in order; with a shelf photo there is no reliable
        // mapping back to a single product, so this is a display hint only.
        const photo = photos[index];
        return { item, ...(photo ? { photo_url: `/uploads/${photo.value}` } : {}) };
      });

      // Stage 2–3: sanity against this shop's own prices, then the combined gate.
      const draft = rows.map((r) => r.item);
      for (const row of rows) {
        const sanity = priceSanity(row.item, draft);
        row.item.needs_merchant_confirmation = evaluateGate(row.item, sanity).held;
      }

      // A sellable item needs a floor before an agent may haggle over it. The
      // merchant has not set one yet, so it opens at list with a modest band
      // they can tighten — never a floor the system invented and hid.
      const stored = rows.map((r) => ({
        ...r,
        ...(r.item.price.value > 0
          ? {
              policy: {
                item_id: r.item.item_id,
                list_price: r.item.price.value,
                floor_price: Math.round(r.item.price.value * 0.85),
                max_rounds: 3,
                set_by: "merchant" as const,
                set_at: new Date().toISOString(),
              },
            }
          : {}),
      }));

      onboarding.replaceItems(id, stored);
      const updated: OnboardedMerchant = { ...merchant, store_summary: extraction.store_summary };
      onboarding.updateMerchant(updated);
      merchants.set(id, updated);

      // Splice into the live catalog, replacing any earlier attempt.
      for (let i = catalogItems.length - 1; i >= 0; i--) {
        if (catalogItems[i]!.merchant_id === id) catalogItems.splice(i, 1);
      }
      for (const row of stored) {
        catalogItems.push(row.item);
        if (row.policy) policies.set(row.policy.item_id, row.policy);
        if (row.photo_url) photoUrlFor.set(row.item.item_id, row.photo_url);
      }

      await openClarifications();

      const held = stored.filter((r) => r.item.needs_merchant_confirmation).length;
      bus.emit({
        type: "extraction.completed",
        merchant_id: id,
        message: `${merchant.name} is agent-readable — ${stored.length} products, ${held} awaiting confirmation`,
      });

      res.status(201).json({
        merchant_id: id,
        store_summary: extraction.store_summary,
        provider: extraction.provider,
        photos_used: extraction.photos_used,
        products: stored.length,
        held,
        items: stored.map((r) => ({
          ...r.item,
          transactable: !r.item.needs_merchant_confirmation,
          photo_url: r.photo_url ?? null,
          policy: r.policy ?? null,
        })),
      });
    } catch (err) {
      const message = describeThrown(err);
      console.error(`[onboarding ${id}] structuring failed:`, message);

      // A spent token quota is not a broken app, and saying "could not read the
      // shop" for it sends the merchant to re-take their photos. Name it, and
      // say when it comes back — the photos are already stored, so retrying
      // later costs them nothing.
      // The governor's own error says only "would need to wait 1890s" — the TPD
      // wording lives on the upstream 429 it already swallowed. A wait measured
      // in tens of minutes is the daily ceiling; a per-minute one resets inside
      // sixty seconds and never asks for more.
      const waited = Number(/wait (\d+(?:\.\d+)?)s/i.exec(message)?.[1] ?? 0);
      const daily = /tokens per day|TPD/i.test(message) || waited > 120;
      const rate = daily || /rate.?limit|budget exhausted|429/i.test(message);
      if (rate) {
        const when =
          /try again in ([0-9hms.]+)/i.exec(message)?.[1] ??
          (waited > 0 ? `${Math.ceil(waited / 60)} min` : undefined);
        res.status(429).json({
          error: daily
            ? `The vision model's daily token allowance is used up${when ? `, back in ${when}` : ""}. Your photos are saved — press this again once it resets.`
            : `The vision model is rate limited right now${when ? `, back in ${when}` : ""}. Your photos are saved — press this again in a moment.`,
          retry_after: when ?? null,
          kind: daily ? "daily_quota" : "rate_limit",
        });
        return;
      }
      res.status(502).json({ error: `could not read the shop: ${message}` });
    }
  });

  /**
   * Milestone: revenue. What buyers asked for, what the shop lost, and what
   * could be changed about it — each with the evidence behind it.
   */
  app.get("/merchants/:id/opportunities", (req: Request, res: Response) => {
    const id = String(req.params.id);
    if (!merchants.has(id)) {
      res.status(404).json({ error: `no such merchant: ${id}` });
      return;
    }
    const events = demand.forMerchant(id);
    res.json({
      merchant_id: id,
      searches_seen: events.length,
      buyers_lost: events.filter((e) => e.outcome !== "sold").length,
      opportunities: findOpportunities(id, events, catalogItems, policies),
      recent: events.slice(0, 12),
    });
  });

  /**
   * The merchant's decision, not the system's.
   *
   * An opportunity carries the exact change it would make; approving applies
   * that and nothing else. Nothing adjusts a floor without passing through
   * here — an AI that can quietly move a merchant's margin is not a tool they
   * can trust with their shop.
   */
  app.post("/merchants/:id/opportunities/:oppId/approve", (req: Request, res: Response) => {
    const id = String(req.params.id);
    const oppId = String(req.params.oppId);
    if (!merchants.has(id)) {
      res.status(404).json({ error: `no such merchant: ${id}` });
      return;
    }

    const opportunity = findOpportunities(id, demand.forMerchant(id), catalogItems, policies).find(
      (o) => o.id === oppId,
    );
    if (!opportunity) {
      res.status(404).json({ error: `no such opportunity: ${oppId}` });
      return;
    }
    if (!opportunity.change) {
      res.status(409).json({ error: "this one is advice, not a change — there is nothing to apply" });
      return;
    }

    const policy = policies.get(opportunity.change.item_id);
    if (!policy) {
      res.status(409).json({ error: `no negotiation policy for ${opportunity.change.item_id}` });
      return;
    }
    if (opportunity.change.to >= policy.list_price) {
      res.status(409).json({ error: "a floor at or above the asking price is not a floor" });
      return;
    }

    const updated: NegotiationPolicy = { ...policy, floor_price: opportunity.change.to, set_at: new Date().toISOString() };
    policies.set(policy.item_id, updated);

    const row = onboarding.listItems().find((r) => r.item.item_id === policy.item_id);
    if (row) onboarding.saveItem({ ...row, policy: updated });

    const item = catalogItems.find((i) => i.item_id === policy.item_id);
    bus.emit({
      type: "clarification.resolved",
      merchant_id: id,
      item_id: policy.item_id,
      message: `Floor on ${item?.name ?? policy.item_id} lowered to ₹${updated.floor_price} — approved by the merchant`,
      data: { from: opportunity.change.from, to: opportunity.change.to },
    });

    res.json({
      approved: oppId,
      item_id: policy.item_id,
      floor_price: { from: opportunity.change.from, to: updated.floor_price },
      note: "Applied because you approved it. Nothing here changes a price on its own.",
    });
  });

  /**
   * What the whole system has actually done. Every number is counted from
   * stored state, so an empty install honestly reports zeroes rather than
   * decorating the home page with invented traction.
   */
  app.get("/overview", async (_req, res) => {
    const txns = store.listTransactions();
    let verifiedValue = 0;
    let delivered = 0;
    let paid = 0;

    for (const t of txns) {
      const chain = store.loadChain(t.transaction_id);
      if (!chain?.payment) continue;
      paid++;
      if (chain.fulfillment) {
        delivered++;
        verifiedValue += chain.cart?.final_price.value ?? 0;
      }
    }

    const events = demand.all();
    res.json({
      merchants_online: structuring.merchants.length,
      products_listed: catalogItems.length,
      products_agent_ready: catalogItems.filter((i) => !i.needs_merchant_confirmation).length,
      awaiting_merchant: catalogItems.filter((i) => i.needs_merchant_confirmation).length,
      buyer_searches: new Set(events.map((e) => e.at)).size,
      transactions_paid: paid,
      transactions_delivered: delivered,
      verified_gmv: verifiedValue,
      catalog_source: structuring.provider,
      gateway: gateway.kind,
    });
  });

  /**
   * A merchant's trust profile, assembled from what actually happened rather
   * than scored by opinion. Each line names its own basis, because a number a
   * buyer cannot interrogate is not a reason to trust anybody.
   */
  app.get("/merchants/:id/trust", async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const merchant = merchants.get(id);
    if (!merchant) {
      res.status(404).json({ error: `no such merchant: ${id}` });
      return;
    }

    const ids = store.listTransactionIdsForMerchant(id);
    let paid = 0;
    let delivered = 0;
    let intact = 0;
    let broken = 0;

    for (const tid of ids) {
      const chain = store.loadChain(tid);
      if (!chain?.payment) continue;
      paid++;
      if (chain.fulfillment) delivered++;
      const report = await verifyChain(chain, keyring);
      if (report.ok) intact++;
      else broken++;
    }

    const mine = catalogItems.filter((i) => i.merchant_id === id);
    const readiness = readinessFor(id);

    res.json({
      merchant_id: id,
      name: merchant.name,
      upi_vpa: merchant.upi_vpa,
      on_upi_since: merchant.since,
      claims: [
        {
          label: "Catalog is agent-readable",
          ok: mine.some((i) => !i.needs_merchant_confirmation),
          basis: `${mine.filter((i) => !i.needs_merchant_confirmation).length} of ${mine.length} products carry a confirmed price and stock count`,
        },
        {
          label: "Verified transactions",
          ok: intact > 0,
          basis: intact === 0 ? "no completed sales yet" : `${intact} chains re-verified just now, signature by signature`,
        },
        {
          label: "No broken mandate chains",
          ok: broken === 0,
          basis: broken === 0 ? "every stored chain verifies" : `${broken} chain(s) failed verification`,
        },
        {
          label: "Fulfillment confirmed",
          ok: paid > 0 && delivered === paid,
          basis: paid === 0 ? "no paid sales yet" : `${delivered} of ${paid} paid sales confirmed handed over`,
        },
      ],
      readiness,
      totals: { paid, delivered, chains_verified: intact, chains_broken: broken },
    });
  });

  /** Every chain this merchant is party to, loaded once for the money views. */
  function chainsFor(merchantId: string) {
    return store
      .listTransactionIdsForMerchant(merchantId)
      .map((id) => store.loadChain(id))
      .filter((c): c is NonNullable<typeof c> => Boolean(c));
  }

  /** §9 — money that did not arrive, and what can still be done about it. */
  app.get("/merchants/:id/recovery", (req: Request, res: Response) => {
    const id = String(req.params.id);
    if (!merchants.has(id)) {
      res.status(404).json({ error: `no such merchant: ${id}` });
      return;
    }
    const { cases, totals } = buildRecoveryCases(
      id,
      demand.forMerchant(id),
      chainsFor(id),
      catalogItems,
      policies,
      recoveryLog.forMerchant(id),
    );
    res.json({ merchant_id: id, policy: RECOVERY_POLICY, totals, cases });
  });

  /**
   * Approving a recovery is an attempt, never an outcome. It applies the change
   * and records that it was tried; the case only reads "recovered" once a real
   * sale closes afterwards.
   */
  app.post("/merchants/:id/recovery/:caseId/act", (req: Request, res: Response) => {
    const id = String(req.params.id);
    const caseId = String(req.params.caseId);
    if (!merchants.has(id)) {
      res.status(404).json({ error: `no such merchant: ${id}` });
      return;
    }

    const { cases } = buildRecoveryCases(
      id, demand.forMerchant(id), chainsFor(id), catalogItems, policies, recoveryLog.forMerchant(id),
    );
    const found = cases.find((c) => c.id === caseId);
    if (!found) {
      res.status(404).json({ error: `no such case: ${caseId}` });
      return;
    }
    if (found.attempts >= RECOVERY_POLICY.max_attempts) {
      res.status(409).json({ error: `already tried ${found.attempts} times — the rule stops at ${RECOVERY_POLICY.max_attempts}` });
      return;
    }
    if (!found.change) {
      res.status(409).json({ error: "this one needs you, not a setting — there is nothing to apply" });
      return;
    }

    const policy = policies.get(found.change.item_id);
    if (!policy) {
      res.status(409).json({ error: `no negotiation policy for ${found.change.item_id}` });
      return;
    }

    const updated: NegotiationPolicy = { ...policy, floor_price: found.change.to, set_at: new Date().toISOString() };
    policies.set(policy.item_id, updated);
    const row = onboarding.listItems().find((r) => r.item.item_id === policy.item_id);
    if (row) onboarding.saveItem({ ...row, policy: updated });

    recoveryLog.record({
      id: caseId,
      merchant_id: id,
      item_id: found.item_id,
      kind: found.kind,
      amount: found.amount,
      taken_at: new Date().toISOString(),
      change_from: found.change.from,
      change_to: found.change.to,
    });

    const item = catalogItems.find((i) => i.item_id === policy.item_id);
    bus.emit({
      type: "clarification.resolved",
      merchant_id: id,
      item_id: policy.item_id,
      message: `Recovery action: floor on ${item?.name ?? policy.item_id} set to ₹${updated.floor_price}`,
      data: { recovery: caseId },
    });

    res.json({
      case_id: caseId,
      applied: { item_id: policy.item_id, floor_price: { from: found.change.from, to: updated.floor_price } },
      window_hours: RECOVERY_POLICY.window_hours,
      note: "Attempt recorded. This counts as recovered only when a sale actually closes.",
    });
  });

  /** §21 — do the stages agree about the money? */
  app.get("/reconciliation", async (req: Request, res: Response) => {
    const merchantId = typeof req.query.merchant_id === "string" ? req.query.merchant_id : undefined;
    const chains = merchantId
      ? chainsFor(merchantId)
      : store
          .listTransactions()
          .map((t) => store.loadChain(t.transaction_id))
          .filter((c): c is NonNullable<typeof c> => Boolean(c));
    res.json(await reconcile(chains, keyring));
  });

  /** §22 — only what this system actually measures. */
  app.get("/performance", async (_req, res) => {
    const audits = Object.values(structuring.audits);
    const heldByGate = catalogItems.filter((i) => i.needs_merchant_confirmation).length;
    const clarifications = store.listClarifications();
    const events = demand.all();

    const chains = store
      .listTransactions()
      .map((t) => store.loadChain(t.transaction_id))
      .filter((c): c is NonNullable<typeof c> => Boolean(c));
    const recon = await reconcile(chains, keyring);

    const negotiations = events.filter((e) => e.item_id !== null);
    const deals = negotiations.filter((e) => e.outcome === "sold").length;

    res.json({
      structuring: {
        products: catalogItems.length,
        auto_approved: catalogItems.length - heldByGate,
        clarifications_raised: clarifications.length,
        clarifications_resolved: clarifications.filter((c) => c.status === "resolved").length,
        auto_rate: catalogItems.length === 0 ? 0 : Math.round(((catalogItems.length - heldByGate) / catalogItems.length) * 1000) / 10,
        sanity_failures: Object.values(structuring.sanity).filter((s) => s.check === "fail").length,
        source: structuring.provider,
      },
      negotiation: {
        attempts: negotiations.length,
        deals,
        no_deals: negotiations.length - deals,
        deal_rate: negotiations.length === 0 ? 0 : Math.round((deals / negotiations.length) * 1000) / 10,
      },
      reconciliation: {
        transactions: recon.transactions,
        matched: recon.matched,
        exceptions: recon.exceptions,
        match_rate: recon.match_rate,
      },
      note: "Counted from stored state. Nothing here is projected, sampled or estimated.",
    });
  });

  /**
   * §7 — the merchant talks to their own shop settings.
   *
   * Two endpoints on purpose. The first reads the sentence and says what it
   * would do; the second does it. A model that could go straight from "don't go
   * below 1000" to a live price floor would be deciding what the shop sells for,
   * and that is not language work.
   */
  app.post("/merchants/:id/policy-request", async (req: Request, res: Response) => {
    const id = String(req.params.id);
    if (!merchants.has(id)) {
      res.status(404).json({ error: `no such merchant: ${id}` });
      return;
    }
    const text = String(req.body?.text ?? "").trim();
    if (!text) {
      res.status(400).json({ error: "say what you want to change" });
      return;
    }

    const { request, by } = await readPolicyRequest(text);
    const proposal = proposeChange(request, id, catalogItems, policies);
    res.json({ merchant_id: id, said: text, read_by: by, request, proposal });
  });

  app.post("/merchants/:id/policy-apply", (req: Request, res: Response) => {
    const id = String(req.params.id);
    if (!merchants.has(id)) {
      res.status(404).json({ error: `no such merchant: ${id}` });
      return;
    }
    const { item_id, field, to } = req.body ?? {};
    if (!item_id || !["floor_price", "list_price", "max_rounds"].includes(field) || typeof to !== "number") {
      res.status(400).json({ error: "item_id, field and a numeric `to` are required" });
      return;
    }

    const policy = policies.get(String(item_id));
    const item = catalogItems.find((i) => i.item_id === item_id && i.merchant_id === id);
    if (!policy || !item) {
      res.status(404).json({ error: `no policy for ${item_id} at this shop` });
      return;
    }

    // The proposal was checked when it was made; check again, because this
    // endpoint can be called directly and its caller's word is not evidence.
    const proposed = proposeChange(
      { item_hint: item.name, field, value: to, confidence: 1 },
      id, catalogItems, policies,
    );
    if (proposed.blocked) {
      res.status(409).json({ error: proposed.blocked });
      return;
    }

    const updated: NegotiationPolicy = { ...policy, [field]: to, set_at: new Date().toISOString() };
    policies.set(policy.item_id, updated);
    const row = onboarding.listItems().find((r) => r.item.item_id === policy.item_id);
    if (row) onboarding.saveItem({ ...row, policy: updated });

    bus.emit({
      type: "clarification.resolved",
      merchant_id: id,
      item_id: policy.item_id,
      message: `${item.name}: ${field.replace("_", " ")} set to ${to}`,
      data: { field, from: policy[field as "floor_price"], to },
    });

    res.json({ item_id: policy.item_id, field, from: policy[field as "floor_price"], to, policy: updated });
  });

  /** The whole commerce twin in one read: what it sells and on what terms. */
  app.get("/merchants/:id/twin", (req: Request, res: Response) => {
    const id = String(req.params.id);
    const merchant = merchants.get(id);
    if (!merchant) {
      res.status(404).json({ error: `no such merchant: ${id}` });
      return;
    }
    const mine = catalogItems.filter((i) => i.merchant_id === id);
    res.json({
      merchant_id: id,
      products: mine.map((i) => {
        const p = policies.get(i.item_id);
        return {
          item_id: i.item_id,
          name: i.name,
          category: i.category,
          attributes: i.attributes,
          asking: i.price.value,
          lowest: p?.floor_price ?? null,
          rounds: p?.max_rounds ?? null,
          in_stock: i.stock.quantity,
          sellable: !i.needs_merchant_confirmation,
        };
      }),
      availability: { delivers_within_days: merchant.delivers_within_days },
      payment: { upi_vpa: merchant.upi_vpa },
    });
  });

  /**
   * What this shop owes someone. Paid orders waiting on a handover, and recent
   * completed ones for context.
   *
   * This exists because the agent deliberately stops at "paid, not delivered" —
   * and until now there was nowhere for a shopkeeper to say the goods went
   * across the counter, so every purchase in the demo sat there forever.
   */
  /**
   * The buyer's side of the same orders the merchant sees.
   *
   * Both views read one chain, so they cannot disagree: "delivered" here is
   * literally the presence of the fulfillment mandate the shopkeeper signed,
   * not a copy of a status that some other table also keeps. That is the whole
   * reason a buyer can be shown a delivery state at all — nothing marks itself
   * handed over, so the buyer's screen changes only when the merchant acts.
   */
  /**
   * The buyer agent's front desk.
   *
   * Multi-turn, so a shopper can arrive with half a thought and be asked the
   * one thing that is missing rather than made to compose a full sentence.
   *
   * It decides only whether there is enough to shop. When there is, the caller
   * runs the agent over `goal` — which is the shopper's own words, joined, and
   * nothing else. The chat cannot add a requirement, because the text handed to
   * the intent parser is text the shopper typed. That is the whole reason this
   * is a separate, deliberately small surface.
   */
  /**
   * Run one of the buyer agent's tools.
   *
   * Every read goes through this server's own endpoints rather than reaching
   * into state directly, so the assistant cannot answer with something the site
   * would not show. `start_purchase` runs nothing — it returns the sentence the
   * shopper has to agree to before an agent is sent.
   */
  /** A card as the storefront draws it. One shape for every product surface. */
  function productCard(i: CatalogItem, reasons: string[] = []) {
    return {
      item_id: i.item_id,
      name: i.name,
      shop: merchants.get(i.merchant_id)?.name ?? i.merchant_id,
      merchant_id: i.merchant_id,
      price: i.price.value,
      in_stock: i.stock.quantity,
      attributes: i.attributes ?? {},
      photo_url: photoUrlFor.get(i.item_id) ?? `/generic/${i.item_id}.jpg`,
      why: reasons,
    };
  }

  const cartTotal = (st: ShoppingState) => st.cart.reduce((n, l) => n + l.price * l.qty, 0);

  function cartView(st: ShoppingState) {
    return {
      lines: st.cart.map((l) => {
        const i = catalogItems.find((x) => x.item_id === l.item_id);
        return { ...l, name: i?.name ?? l.item_id, shop: merchants.get(i?.merchant_id ?? "")?.name ?? "" };
      }),
      total: cartTotal(st),
      count: st.cart.reduce((n, l) => n + l.qty, 0),
    };
  }

  async function runBuyerTool(
    call: BuyerToolCall,
    lastSearch: string[],
    st: ShoppingState,
  ): Promise<BuyerToolResult> {
    const { tool, args } = call;

    /** Everything below resolves what the shopper meant the same way. */
    const pick = (key = "product") =>
      resolveProduct(String((args as Record<string, unknown>)[key] ?? ""), st, catalogItems);

    /**
     * Say why the reference did not land, not just that it did not.
     *
     * "I could not tell which product that is" is true and useless: the model
     * gets no idea what to try instead, and a live run answered it by giving up
     * on the lookup and inventing a button. The common failure is a bare number
     * that is not a position in the list — a model that has just been shown
     * three rows will hand back "80" because that was the *price* — and naming
     * the range it may actually refer to is enough for it to recover on its own.
     */
    function unresolved(key = "product"): BuyerToolResult {
      const said = String((args as Record<string, unknown>)[key] ?? "").trim();
      const shown = st.shown.length;

      if (/^\d+$/.test(said) && (Number(said) < 1 || Number(said) > shown)) {
        return {
          tool,
          summary: `There is no #${said} in what I showed you.`,
          error:
            shown > 0
              ? `${said} is not a row number — the list has ${shown} (1 to ${shown}). ` +
                `If ${said} was a price, pass the product's name or its row number instead.`
              : `Nothing has been listed yet, so ${said} refers to nothing. Call search_shelf first.`,
        };
      }
      return {
        tool,
        summary: said ? `I could not tell which product "${said}" is.` : "I could not tell which product that is.",
        error:
          `"${said}" did not match any product. Pass the row number from search_shelf, ` +
          `or the product's exact name. Never a price and never an invented id.`,
      };
    }
    try {
      if (tool === "search_shelf") {
        const want = String(args.want ?? "").trim();
        const max = Number(args.max_price ?? 0);
        const found = discover(catalogItems, { want, ...(max > 0 ? { max_price: max } : {}) });
        const rows = found.matches.slice(0, 6).map((m, n) => ({
          /**
           * A number the model can actually carry.
           *
           * It was asked to pass an item_id back and kept inventing
           * plausible-looking ones — sri-balaji-choc-500, new_nature1005,
           * sri_balaji_42 — none of which existed. Opaque identifiers are
           * something models copy unreliably, so the conversation stalled on
           * a guard doing its job. A one-digit reference is small enough to
           * carry correctly, and the server resolves it against the very rows
           * it just returned.
           */
          ref: n + 1,
          item_id: m.item.item_id,
          name: m.item.name,
          shop: merchants.get(m.item.merchant_id)?.name ?? m.item.merchant_id,
          merchant_id: m.item.merchant_id,
          price: m.item.price.value,
          // The floor is deliberately not here.
          //
          // It is the merchant's private limit — the least they will accept —
          // and the buyer's assistant has no business holding it. Two things
          // went wrong while it did. It quoted one product's floor as another
          // product's price ("the Chocolate Cake 500g is ₹580", when ₹580 was
          // Red Velvet's floor and the cake is ₹450), and the grounding guard
          // could not catch it because the number really was in the tool data,
          // just attached to something else. And a shopper's agent that knows
          // exactly how far a shop will drop is not negotiating with it.
          //
          // Negotiation still happens against the floor — in the rules layer,
          // server-side, which is where the floor belongs.
          in_stock: m.item.stock.quantity,
        }));
        // What the numbers in this turn's answer refer to — for this turn, and
        // for the next one, when the shopper says "the second one".
        lastSearch.length = 0;
        lastSearch.push(...rows.map((r) => r.item_id));
        st.shown = rows.map((r) => r.item_id);
        if (max > 0) st.budget = max;

        return {
          tool,
          summary: rows.length > 0
            ? `${rows.length} on the shelf for "${want}"${max > 0 ? ` under ₹${max}` : ""}: ` +
              rows.map((r) => `${r.ref}) ${r.name} ₹${r.price} at ${r.shop}`).join("; ")
            : `Nothing on the shelf matches "${want}".`,
          data: { results: rows, withheld: found.withheld.length },
        };
      }

      if (tool === "get_orders") {
        const body = await fetchLocal("/orders");
        const rows = (body.orders ?? []).slice(0, 8);
        return {
          tool,
          summary: `${rows.length} order(s): ${body.awaiting_handover} awaiting handover, ${body.delivered} delivered.`,
          data: { orders: rows },
        };
      }

      if (tool === "get_order") {
        const id = String(args.transaction_id ?? "");
        const body = await fetchLocal(`/orders/${encodeURIComponent(id)}`);
        if (body?.error) return { tool, summary: `No order ${id}.`, error: String(body.error) };
        return { tool, summary: `${body.item_name}: ${body.status.replace(/_/g, " ")}.`, data: body };
      }

      if (tool === "check_shop") {
        const id = String(args.merchant_id ?? "");
        const body = await fetchLocal(`/merchants/${encodeURIComponent(id)}/commerce-history`);
        if (body?.error) return { tool, summary: `No shop ${id}.`, error: String(body.error) };
        return {
          tool,
          summary: `${body.delivered_sales ?? 0} delivered sale(s), ₹${body.verified_value ?? 0} verified.`,
          data: body,
        };
      }

      if (tool === "get_product") {
        const item = pick();
        if (!item) return unresolved();
        st.selected = item.item_id;
        const sizes = variantsOf(item, catalogItems);
        const goes = complementsOf(item, catalogItems).slice(0, 3);
        return {
          tool,
          render: "product",
          summary: `${item.name}: ₹${item.price.value}, ${item.stock.quantity} in stock at ${merchants.get(item.merchant_id)?.name}.`,
          data: {
            product: productCard(item),
            other_sizes: sizes.map((v) => productCard(v)),
            goes_with: goes.map((v) => productCard(v)),
          },
        };
      }

      if (tool === "compare_products") {
        const raw = Array.isArray((args as Record<string, unknown>).products)
          ? ((args as Record<string, unknown>).products as unknown[])
          : [];
        const picked = raw
          .map((r) => resolveProduct(String(r), st, catalogItems))
          .filter((x): x is CatalogItem => Boolean(x));
        if (picked.length < 2) {
          return { tool, summary: "I need two products to compare.", error: "fewer than two resolved" };
        }
        st.comparing = picked.map((i) => i.item_id);
        // Only the fields all of them actually have — a comparison row that is
        // blank for one side tells the shopper nothing and looks like a fault.
        const keys = [...new Set(picked.flatMap((i) => Object.keys(i.attributes ?? {})))]
          .filter((k) => picked.every((i) => (i.attributes ?? {})[k]));
        const cheapest = picked.reduce((a, b) => (b.price.value < a.price.value ? b : a));
        return {
          tool,
          render: "comparison",
          summary: `Compared ${picked.map((i) => i.name).join(" vs ")}. Cheapest is ${cheapest.name} at ₹${cheapest.price.value}.`,
          data: {
            products: picked.map((i) => productCard(i)),
            rows: [
              { label: "Price", values: picked.map((i) => `₹${i.price.value.toLocaleString("en-IN")}`) },
              { label: "In stock", values: picked.map((i) => String(i.stock.quantity)) },
              { label: "Shop", values: picked.map((i) => merchants.get(i.merchant_id)?.name ?? "") },
              ...keys.map((k) => ({ label: k, values: picked.map((i) => (i.attributes ?? {})[k] ?? "—") })),
            ],
            cheapest: cheapest.item_id,
          },
        };
      }

      if (tool === "find_alternatives") {
        const item = pick();
        if (!item) return unresolved();
        const cap = Number((args as Record<string, unknown>).max_price ?? 0) || null;
        const alts = alternativesTo(item, catalogItems)
          .filter((a) => cap === null || a.price.value <= cap)
          .slice(0, 4);
        st.shown = alts.map((a) => a.item_id);
        return {
          tool,
          render: "products",
          summary: alts.length
            ? `${alts.length} alternative(s) to ${item.name}${cap ? ` under ₹${cap}` : ""}.`
            : `Nothing else like ${item.name}${cap ? ` under ₹${cap}` : ""}.`,
          data: {
            results: alts.map((a, n) =>
              productCard(a, [
                a.price.value < item.price.value
                  ? `₹${item.price.value - a.price.value} cheaper than ${item.name}`
                  : `same kind of thing as ${item.name}`,
              ]),
            ).map((c, n) => ({ ref: n + 1, ...c })),
          },
        };
      }

      if (tool === "find_complements") {
        const item = pick();
        if (!item) return unresolved();
        st.selected = item.item_id;
        // Never suggest something they already have.
        const inCart = new Set(st.cart.map((l) => l.item_id));
        const goes = complementsOf(item, catalogItems).filter((c) => !inCart.has(c.item_id)).slice(0, 3);
        st.shown = goes.map((g) => g.item_id);
        return {
          tool,
          render: "products",
          summary: goes.length ? `${goes.length} thing(s) that go with ${item.name}.` : `Nothing listed as going with ${item.name}.`,
          data: {
            anchor: productCard(item),
            results: goes.map((g, n) => ({ ref: n + 1, ...productCard(g, [`goes with ${item.name}`]) })),
          },
        };
      }

      if (tool === "view_cart") {
        const v = cartView(st);
        return {
          tool,
          render: "cart",
          summary: v.count === 0 ? "The cart is empty." : `${v.count} item(s), ₹${v.total.toLocaleString("en-IN")}.`,
          data: v,
        };
      }

      if (tool === "add_to_cart") {
        const item = pick();
        if (!item) return unresolved();
        // Stock is checked before the cart changes, not after — a cart that
        // holds more than the shop has is a promise nobody can keep.
        const want = Math.max(1, Math.round(Number((args as Record<string, unknown>).qty ?? 1)));
        const line = st.cart.find((l) => l.item_id === item.item_id);
        const already = line?.qty ?? 0;
        const room = item.stock.quantity - already;
        if (room <= 0) {
          return {
            tool,
            summary: `${item.name}: only ${item.stock.quantity} in stock and they are all in the cart.`,
            error: "no stock left",
          };
        }
        const added = Math.min(want, room);
        if (line) line.qty += added;
        else st.cart.push({ item_id: item.item_id, qty: added, price: item.price.value });
        st.selected = item.item_id;
        st.updated_at = new Date().toISOString();
        const v = cartView(st);
        return {
          tool,
          render: "cart",
          summary:
            `Added ${added} × ${item.name} (₹${item.price.value}). Cart is ₹${v.total.toLocaleString("en-IN")}.` +
            (added < want ? ` Only ${added} could be added — that is all the stock there is.` : ""),
          data: v,
        };
      }

      if (tool === "remove_from_cart") {
        const item = pick();
        if (!item) return unresolved();
        const before = st.cart.length;
        st.cart = st.cart.filter((l) => l.item_id !== item.item_id);
        st.updated_at = new Date().toISOString();
        const v = cartView(st);
        return {
          tool,
          render: "cart",
          summary: before === st.cart.length ? `${item.name} was not in the cart.` : `Removed ${item.name}. Cart is ₹${v.total.toLocaleString("en-IN")}.`,
          data: v,
        };
      }

      if (tool === "start_purchase") {
        const said = String(args.product ?? args.item_id ?? "").trim();
        const max = Number(args.max_price ?? 0);

        /**
         * Resolve what the model said to something that exists.
         *
         * Three ways, in order of how reliable each is: the reference number
         * from the search it just ran, a real item_id if it happened to copy
         * one correctly, or an exact product name. Everything else is a guess
         * and is refused — the point is not to be lenient, it is to stop
         * asking the model for the one thing it cannot reliably carry.
         */
        const byRef = /^\d+$/.test(said) ? lastSearch[Number(said) - 1] : undefined;
        const byId = catalogItems.find((i) => i.item_id === said);
        const byName = catalogItems.find(
          (i) => i.name.toLowerCase() === said.toLowerCase() && !i.needs_merchant_confirmation,
        );
        const itemId = byRef ?? byId?.item_id ?? byName?.item_id ?? "";

        // A purchase with no ceiling is the one thing this must never prepare:
        // the ceiling is what the authorization check gates on, and without it
        // "confirm" would mean "spend whatever it takes".
        if (!Number.isFinite(max) || max <= 0) {
          return { tool, summary: "Cannot prepare that without a budget.", error: "need a rupee ceiling" };
        }

        // The model names a product by id, and the id has to resolve to
        // something really on the shelf.
        //
        // This used to take the product as free text, which meant the model
        // could compose one: a run went out for "Classic Handloom Cotton Saree,
        // 6 feet, Rag & Reuse" — a product that has never existed in any shop
        // here — and the pipeline dutifully searched nine merchants for it. The
        // model may choose among real things. It may not mint them.
        const item = catalogItems.find((i) => i.item_id === itemId);
        if (!item) {
          return {
            tool,
            summary: `"${said || "(nothing)"}" does not point at a product.`,
            error:
              `"${said}" is not one of the numbered results. Call search_shelf, then pass the NUMBER of the row you want — ` +
              (lastSearch.length > 0 ? `this search returned 1 to ${lastSearch.length}.` : "there is no search to refer to yet."),
          };
        }
        if (item.needs_merchant_confirmation || item.stock.quantity < 1) {
          return {
            tool,
            summary: `${item.name} cannot be bought right now.`,
            error: item.stock.quantity < 1 ? "out of stock" : "the shopkeeper has not confirmed this item yet",
          };
        }

        const shop = merchants.get(item.merchant_id)?.name ?? item.merchant_id;
        return {
          tool,
          summary: `Ready to buy ${item.name} from ${shop}, up to ₹${max.toLocaleString("en-IN")} — needs your confirmation.`,
          data: { prepared: true, item_id: item.item_id, name: item.name, shop, max_price: max },
          proposal: {
            label: `Buy ${item.name} from ${shop}, up to ₹${max.toLocaleString("en-IN")}`,
            goal: `${item.name} under ₹${max}`,
            item_id: item.item_id,
            max_price: max,
          },
        };
      }

      return { tool, summary: `No such tool: ${tool}`, error: "unknown tool" };
    } catch (err) {
      return { tool, summary: "That lookup failed.", error: describeThrown(err) };
    }
  }

  /**
   * The buyer agent, with tools.
   *
   * /agent/chat decides only whether there is enough to shop. This one can also
   * act: check an order, look up a shop's delivery record, search the shelf —
   * and prepare a purchase, which still takes a person's press to run.
   */
  /**
   * The shopper's cart, server-side.
   *
   * One cart, whether the shopper pressed Add on a card or told the agent to
   * add it. Two carts — one in the browser, one the agent could see — would
   * mean the agent confidently describing a basket the shopper was not looking
   * at, which is the same class of error as inventing a price.
   */
  function sessionOf(req: Request): string {
    const id = String(req.body?.session_id ?? req.query.session_id ?? "").trim();
    return id || `anon_${req.ip ?? "x"}`;
  }

  app.get("/cart", (req: Request, res: Response) => {
    res.json(cartView(stateFor(sessionOf(req))));
  });

  app.post("/cart/add", (req: Request, res: Response) => {
    const st = stateFor(sessionOf(req));
    const item = catalogItems.find((i) => i.item_id === String(req.body?.item_id ?? ""));
    if (!item) {
      res.status(404).json({ error: "no such product" });
      return;
    }
    const want = Math.max(1, Math.round(Number(req.body?.qty ?? 1)));
    const line = st.cart.find((l) => l.item_id === item.item_id);
    const room = item.stock.quantity - (line?.qty ?? 0);
    if (room <= 0) {
      res.status(409).json({ error: `only ${item.stock.quantity} in stock, and they are all in your cart`, ...cartView(st) });
      return;
    }
    const added = Math.min(want, room);
    if (line) line.qty += added;
    else st.cart.push({ item_id: item.item_id, qty: added, price: item.price.value });
    st.selected = item.item_id;
    res.status(201).json({ added, ...cartView(st) });
  });

  app.post("/cart/remove", (req: Request, res: Response) => {
    const st = stateFor(sessionOf(req));
    const id = String(req.body?.item_id ?? "");
    st.cart = st.cart.filter((l) => l.item_id !== id);
    res.json(cartView(st));
  });

  app.post("/cart/qty", (req: Request, res: Response) => {
    const st = stateFor(sessionOf(req));
    const id = String(req.body?.item_id ?? "");
    const item = catalogItems.find((i) => i.item_id === id);
    const line = st.cart.find((l) => l.item_id === id);
    if (!item || !line) {
      res.status(404).json({ error: "not in the cart" });
      return;
    }
    const q = Math.round(Number(req.body?.qty ?? 1));
    if (q <= 0) st.cart = st.cart.filter((l) => l.item_id !== id);
    else line.qty = Math.min(q, item.stock.quantity);
    res.json(cartView(st));
  });

  /**
   * Openers drawn from what this marketplace actually sells.
   *
   * Written from the catalog rather than hardcoded, so a shop that onboards
   * tonight gets openers about its own goods instead of somebody else's cakes.
   */
  app.get("/agent/openers", (_req: Request, res: Response) => {
    const live = catalogItems.filter((i) => !i.needs_merchant_confirmation && i.stock.quantity > 0 && i.price.value > 0);
    const byCat = new Map<string, CatalogItem[]>();
    for (const i of live) {
      const k = i.category.split(".")[0]!;
      byCat.set(k, [...(byCat.get(k) ?? []), i]);
    }
    const out: string[] = [];
    for (const [, group] of [...byCat.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 3)) {
      const cheapest = group.reduce((a, b) => (b.price.value < a.price.value ? b : a));
      const round = Math.ceil((cheapest.price.value * 1.4) / 50) * 50;
      const word = cheapest.name.split(" ").slice(0, 2).join(" ").toLowerCase();
      out.push(`${word} under ₹${round}`);
    }
    const anchor = live.find((i) => ((i as CatalogItem & { complements?: string[] }).complements ?? []).length > 0);
    if (anchor) out.push(`what goes with a ${anchor.name.split(" ").slice(0, 2).join(" ").toLowerCase()}?`);
    res.json({ openers: out.slice(0, 4) });
  });

  app.post("/agent/assist", async (req: Request, res: Response) => {
    const raw = Array.isArray(req.body?.messages) ? req.body.messages : [];
    const turns: Turn[] = raw
      .filter((m: unknown): m is Turn =>
        typeof (m as Turn)?.content === "string" &&
        ((m as Turn).role === "user" || (m as Turn).role === "assistant"))
      /**
       * Six turns, not twelve, and 320 characters each.
       *
       * The transcript used to be the only memory, so it had to be long. It is
       * not any more — what was shown, what is selected, the budget and the
       * cart all live in the session now, and the model reads those from tool
       * results. What the transcript still carries is tone and the shape of
       * the request, and six turns of that is plenty. Halving it takes roughly
       * a fifth off a turn on an 8,000-token minute.
       */
      .slice(-6)
      .map((m: Turn) => ({ role: m.role, content: String(m.content).slice(0, 320) }));

    if (turns.length === 0 || !turns.some((t) => t.role === "user")) {
      res.status(400).json({ error: "send at least one user message" });
      return;
    }

    const started = Date.now();
    /**
     * One shopper's session, carried by the browser.
     *
     * The numbered list, what they are looking at, their budget and their cart
     * all live here between turns. Without it every message started from
     * nothing and the model filled the gap by guessing, which is where the
     * invented product ids came from.
     */
    const sessionId = String(req.body?.session_id ?? "").trim() || `anon_${req.ip ?? "x"}`;
    const st = stateFor(sessionId);
    // Search numbering is per turn; everything else persists.
    const lastSearch: string[] = [];

    const out = await converseWithTools(turns, (call) => runBuyerTool(call, lastSearch, st));
    res.json({
      ...out,
      elapsed_ms: Date.now() - started,
      cart: cartView(st),
      // Development only: what the agent understood and did, never its
      // reasoning. A shopper's screen shows none of this.
      debug: {
        session: sessionId,
        selected: st.selected,
        budget: st.budget,
        shown: st.shown.length,
        comparing: st.comparing,
        tools: out.steps.map((x) => x.tool),
      },
    });
  });

  app.post("/agent/chat", async (req: Request, res: Response) => {
    const raw = Array.isArray(req.body?.messages) ? req.body.messages : [];
    const turns: Turn[] = raw
      .filter((m: unknown): m is Turn =>
        typeof (m as Turn)?.content === "string" &&
        ((m as Turn).role === "user" || (m as Turn).role === "assistant"))
      .slice(-12)
      .map((m: Turn) => ({ role: m.role, content: String(m.content).slice(0, 500) }));

    if (turns.length === 0 || !turns.some((t) => t.role === "user")) {
      res.status(400).json({ error: "send at least one user message" });
      return;
    }

    const out = await converse(turns);
    res.json({ ...out, goal: out.ready ? shopperText(turns) : null });
  });

  /**
   * Milestone: the bank feed, joined to what was actually sold.
   *
   * The merchant this is built for already has exactly one record of their
   * trade — money landing in a UPI account — and it says nothing about what
   * was sold. This endpoint is the join, and its headline number is
   * deliberately the uncomfortable one: what share of the rupees that arrived
   * can be tied to a product, a buyer and a delivery.
   *
   * Before any of this, that share is zero for every merchant in India who
   * sells through a QR code. That is the entire pitch, stated as arithmetic
   * rather than a claim.
   */
  /**
   * What a different price floor would actually have earned.
   *
   * Not a model of demand — a replay of it. Every buyer who bargained here left
   * an opening offer and a ceiling, and each candidate floor is scored by
   * running those buyers back through the same negotiation engine a live
   * purchase uses. The merchant can check any point on the curve against the
   * buyers it came from, which is not true of a learned elasticity.
   */
  /**
   * The Revenue Agent's view for one shop.
   *
   * Everything here is a suggestion with its reasoning attached. Nothing is
   * applied, nothing is added to anyone's basket, and every figure that is
   * modelled rather than observed is marked as an estimate — a merchant told
   * "₹1,050 recoverable" deserves to know whether that is a measurement or a
   * projection.
   */
  app.get("/merchants/:id/revenue-agent", (req: Request, res: Response) => {
    const id = String(req.params.id);
    const merchant = merchants.get(id);
    if (!merchant) {
      res.status(404).json({ error: `no such merchant: ${id}` });
      return;
    }
    const events = demand.forMerchant(id, "1970-01-01");
    const mine = catalogItems.filter((i) => i.merchant_id === id && !i.needs_merchant_confirmation);
    const opportunities: Opportunity[] = [];

    // Cross-sell and upsell are anchored on what buyers actually asked this
    // shop for, so a suggestion always has a real request behind it.
    const wanted = new Map<string, number>();
    for (const e of events) {
      if (e.item_id) wanted.set(e.item_id, (wanted.get(e.item_id) ?? 0) + 1);
    }
    const anchors = mine
      .slice()
      .sort((a, b) => (wanted.get(b.item_id) ?? 0) - (wanted.get(a.item_id) ?? 0))
      .slice(0, 6);

    for (const anchor of anchors) {
      const ceiling = Math.round(anchor.price.value * 1.55);
      const x = crossSell(anchor, catalogItems, merchant, ceiling, events);
      if (x) opportunities.push(x);
      const u = upsell(anchor, catalogItems, merchant, ceiling, events);
      if (u) opportunities.push(u);
    }
    opportunities.push(...deadStock(merchant, catalogItems, policies, events));

    const byKind = { cross_sell: 0, upsell: 0, dead_stock: 0 } as Record<Opportunity["kind"], number>;
    for (const o of opportunities) byKind[o.kind] += o.incremental_revenue;

    const ranked = opportunities.sort((a, b) => b.score - a.score || b.incremental_revenue - a.incremental_revenue);
    res.json({
      merchant_id: id,
      merchant_name: merchant.name,
      policy: merchant.policy ?? null,
      total_estimated: ranked.reduce((s, o) => s + o.incremental_revenue, 0),
      by_kind: byKind,
      count: ranked.length,
      basis: "Deterministic. Relevance is the shop's own declared complements and shared tags; urgency is stock arithmetic; demand is counted searches. No model decides any of it.",
      opportunities: ranked.slice(0, 12),
    });
  });

  /**
   * What the Revenue Agent would suggest alongside a purchase in flight.
   *
   * Called by the storefront once the buyer has chosen something. It returns a
   * suggestion and a total; it cannot add anything. The buyer presses, and the
   * rules layer then re-checks the new total against their ceiling exactly as
   * it would for any other purchase.
   */
  app.post("/revenue-agent/basket", (req: Request, res: Response) => {
    const itemId = String(req.body?.item_id ?? "");
    const ceiling = Number(req.body?.max_price ?? 0) || null;
    const item = catalogItems.find((i) => i.item_id === itemId);
    if (!item) {
      res.status(404).json({ error: `no such product: ${itemId}` });
      return;
    }
    const merchant = merchants.get(item.merchant_id);
    if (!merchant) {
      res.status(404).json({ error: "product has no merchant" });
      return;
    }
    const events = demand.forMerchant(item.merchant_id, "1970-01-01");
    const cross = crossSell(item, catalogItems, merchant, ceiling, events);
    const up = upsell(item, catalogItems, merchant, ceiling, events);

    res.json({
      item_id: itemId,
      buyer_ceiling: ceiling,
      // Never sent to a buyer's screen: cost and margin are the merchant's
      // business, and a shopper who can see them is being shown the seller's
      // hand.
      cross_sell: cross ? publicOpportunity(cross) : null,
      upsell: up ? publicOpportunity(up) : null,
      note: "Suggestions only. Nothing is added until the buyer confirms, and the rules layer checks the new total either way.",
    });
  });

  /** Strip anything the buyer has no business seeing. */
  function publicOpportunity(o: Opportunity) {
    const { merchant_id, merchant_name, headline, suggestions, basket_before, basket_after, buyer_ceiling, factors } = o;
    return {
      merchant_id, merchant_name, headline, suggestions,
      basket_before, basket_after, buyer_ceiling,
      // The buyer sees why it is relevant and that it fits. Not the score, not
      // the margin, not how much the shop stands to gain.
      why: factors.filter((f) => f.ok && f.label !== "Merchant allows cross-sell" && f.label !== "Merchant allows upsell")
        .map((f) => f.label),
    };
  }

  app.get("/merchants/:id/price-curve", (req: Request, res: Response) => {
    const id = String(req.params.id);
    if (!merchants.has(id)) {
      res.status(404).json({ error: `no such merchant: ${id}` });
      return;
    }
    const events = demand.forMerchant(id, "1970-01-01");
    const mine = catalogItems.filter((i) => i.merchant_id === id && !i.needs_merchant_confirmation);

    const curves = mine
      .map((item) => {
        const policy = policies.get(item.item_id);
        return policy ? priceElasticity(item, policy, events) : null;
      })
      .filter((c): c is NonNullable<typeof c> => c !== null)
      // Biggest upside first: this is a to-do list, not a report.
      .sort((a, b) => b.upside - a.upside);

    res.json({
      merchant_id: id,
      basis: "every AI buyer who bargained for this item, replayed through the live negotiation engine",
      items: curves,
      total_upside: curves.reduce((sum, c) => sum + c.upside, 0),
    });
  });

  app.get("/merchants/:id/reconciliation", (req: Request, res: Response) => {
    const id = String(req.params.id);
    if (!merchants.has(id)) {
      res.status(404).json({ error: `no such merchant: ${id}` });
      return;
    }

    const chains = store
      .listTransactionIdsForMerchant(id)
      .map((tid) => store.loadChain(tid))
      .filter((c): c is NonNullable<typeof c> => Boolean(c));

    const credits = buildStatement(id, chains);
    const result = reconcileUpi(credits, chains, (chain) => {
      const item = catalogItems.find((i) => i.item_id === chain.cart?.item_id);
      return item?.name ?? chain.cart?.item_id ?? null;
    });

    res.json({
      merchant_id: id,
      // Said plainly, on the endpoint as well as the screen. A generated feed
      // presented as a bank connection would be the one dishonest thing here.
      statement_source: "simulated UPI settlement feed, generated from this shop's own sales plus counter sales it never recorded",
      ...result,
      before: {
        explained_share: 0,
        note: "A UPI credit on its own carries an amount, a time and a payer handle. Nothing in it says what was sold.",
      },
    });
  });

  /**
   * Our record and Razorpay's, side by side.
   *
   * Everywhere else in this product a payment is something we assert: we hold a
   * signed Payment Mandate and we show it. This endpoint asks the gateway what
   * it currently believes about the same order and reports both, including when
   * they disagree.
   *
   * That disagreement is the point. A demo that only ever shows its own
   * bookkeeping cannot prove the money existed; one that fetches the order back
   * from Razorpay and finds `status: paid, amount_paid: 26000` has evidence
   * nobody has to take on trust. If Razorpay says the order is still `created`
   * while we hold a payment mandate, that is a real finding and it is shown as
   * one rather than smoothed over.
   */
  /**
   * What this Razorpay account can actually do, asked rather than asserted.
   *
   * Cached for ten minutes because it is five HTTP calls and the answer changes
   * roughly never — but it is a real probe, and an unavailable product says
   * which call returned what. On this account QR Codes and Virtual Accounts
   * answer 400: they are not enabled, and the screen says so instead of
   * showing a mock and calling it an integration.
   */
  let capCache: { at: number; caps: Capability[] } | null = null;
  app.get("/razorpay/capabilities", async (_req: Request, res: Response) => {
    const creds = razorpayCredentials(gateway);
    if (!creds) {
      res.json({
        mode: "simulated",
        note: "No Razorpay keys configured, so nothing here was probed. Every id in this session is sim_ prefixed.",
        capabilities: [],
      });
      return;
    }
    if (!capCache || Date.now() - capCache.at > 10 * 60_000) {
      capCache = { at: Date.now(), caps: await probeCapabilities(creds.keyId, creds.keySecret) };
    }
    res.json({
      mode: "razorpay_test",
      key_id: creds.keyId,
      probed_at: new Date(capCache.at).toISOString(),
      capabilities: capCache.caps,
    });
  });

  /**
   * A Payment Link for a cart the rules have already cleared.
   *
   * The order matters and is the whole point: this endpoint refuses anything
   * without an authorized order, so a link can only ever exist for a price that
   * passed the buyer's ceiling, the merchant's floor, stock and category. It is
   * a second way to pay for a decision already made — never a way around
   * making it.
   */
  app.post("/transactions/:id/payment-link", async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const creds = razorpayCredentials(gateway);
    if (!creds) {
      res.status(409).json({ error: "payment links need real Razorpay keys; this session is on the simulated rail" });
      return;
    }
    const chain = store.loadChain(id);
    const order = store.loadOrder(id);
    if (!chain?.cart || !order) {
      res.status(404).json({ error: `no authorized cart for ${id} — the rules layer has not cleared a price` });
      return;
    }
    // The rail this transaction actually ran on, not the one configured now.
    // Without this a run settled on the simulated rail could be handed a real
    // Razorpay resource, which is exactly the mixing of real and simulated
    // identifiers the whole two-mode design exists to prevent.
    if (order.order_id.startsWith("sim_")) {
      res.status(409).json({
        error: "this transaction settled on the simulated rail; a real Razorpay resource would mix the two",
      });
      return;
    }

    if (chain.payment) {
      res.status(409).json({ error: "this transaction is already paid" });
      return;
    }

    const item = catalogItems.find((i) => i.item_id === chain.cart!.item_id);
    try {
      const link = await createPaymentLink(creds.keyId, creds.keySecret, {
        amount_paise: order.amount_paise,
        description: `${item?.name ?? chain.cart.item_id} · Vyapar`,
        reference_id: id,
        notes: {
          transaction_id: id,
          item_id: chain.cart.item_id,
          merchant_id: chain.cart.merchant_id,
          agreed_price: String(chain.cart.final_price.value),
        },
        expire_minutes: 30,
      });
      store.savePaymentLink(id, link.id, link.short_url, link.status);
      res.status(201).json({
        transaction_id: id, ...link,
        note: "The link exists. Nothing has been paid until Razorpay says a payment was captured against it.",
      });
    } catch (err) {
      // A refused link is a refused link. It must never read as a payment.
      res.status(502).json({ error: describeThrown(err) });
    }
  });

  /** Razorpay's current word on a link. `created` is not `paid`. */
  app.get("/transactions/:id/payment-link", async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const creds = razorpayCredentials(gateway);
    const saved = store.loadPaymentLink(id);
    if (!creds || !saved) {
      res.status(404).json({ error: `no payment link for ${id}` });
      return;
    }
    try {
      const live = await fetchPaymentLink(creds.keyId, creds.keySecret, saved.link_id);
      res.json({
        transaction_id: id, ...live,
        paid: live.status === "paid" && Boolean(live.payment_id),
        note: live.status === "paid"
          ? "Razorpay reports this link paid. The transaction still needs its payment verified and the shop to confirm handover."
          : `Razorpay reports this link as "${live.status}". No money has moved.`,
      });
    } catch (err) {
      res.status(502).json({ error: describeThrown(err) });
    }
  });

  app.post("/transactions/:id/payment-link/cancel", async (req: Request, res: Response) => {
    const creds = razorpayCredentials(gateway);
    const saved = store.loadPaymentLink(String(req.params.id));
    if (!creds || !saved) {
      res.status(404).json({ error: "no payment link to cancel" });
      return;
    }
    try {
      const status = await cancelPaymentLink(creds.keyId, creds.keySecret, saved.link_id);
      store.savePaymentLink(String(req.params.id), saved.link_id, saved.short_url, status);
      res.json({ link_id: saved.link_id, status });
    } catch (err) {
      res.status(502).json({ error: describeThrown(err) });
    }
  });

  /**
   * An invoice, issued only for a sale that actually finished.
   *
   * Gated on the fulfillment mandate rather than on payment: an invoice for
   * goods that never moved is precisely the paperwork this product exists to
   * stop producing.
   */
  app.post("/transactions/:id/invoice", async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const creds = razorpayCredentials(gateway);
    if (!creds) {
      res.status(409).json({ error: "invoices need real Razorpay keys; this session is on the simulated rail" });
      return;
    }
    const chain = store.loadChain(id);
    if (!chain?.cart || !chain.payment) {
      res.status(409).json({ error: "nothing to invoice: this transaction has no verified payment" });
      return;
    }
    if (!chain.fulfillment) {
      res.status(409).json({
        error: "the shop has not confirmed handover yet — an invoice for goods that have not moved is not a record, it is a fiction",
      });
      return;
    }
    const invOrder = store.loadOrder(id);
    if (!invOrder || invOrder.order_id.startsWith("sim_")) {
      res.status(409).json({
        error: "this sale settled on the simulated rail; invoicing it through Razorpay would present simulated money as real",
      });
      return;
    }
    const item = catalogItems.find((i) => i.item_id === chain.cart!.item_id);
    try {
      const inv = await createInvoice(creds.keyId, creds.keySecret, {
        amount_paise: Math.round(chain.cart.final_price.value * 100),
        description: `${item?.name ?? chain.cart.item_id} — delivered ${chain.fulfillment.confirmed_at}`,
        receipt: id,
        customer_name: "Vyapar buyer agent",
        line_item: item?.name ?? chain.cart.item_id,
        notes: { transaction_id: id, payment_id: chain.payment.razorpay_payment_id },
      });
      store.saveInvoice(id, inv.id, inv.short_url, inv.status);
      res.status(201).json({ transaction_id: id, ...inv });
    } catch (err) {
      res.status(502).json({ error: describeThrown(err) });
    }
  });

  app.get("/transactions/:id/gateway-status", async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const chain = store.loadChain(id);
    const order = store.loadOrder(id);
    if (!chain || !order) {
      res.status(404).json({ error: `no such transaction, or it never reached an order: ${id}` });
      return;
    }

    // Which rail this transaction actually ran on, decided by the id it holds
    // rather than by whatever gateway happens to be configured now.
    const simulated = order.order_id.startsWith("sim_");
    const rail = simulated ? testRail : gateway;

    const ours = {
      order_id: order.order_id,
      amount_paise: order.amount_paise,
      payment_id: chain.payment?.razorpay_payment_id ?? null,
      payment_status: chain.payment?.status ?? null,
      agreed_price: chain.cart?.final_price.value ?? null,
      delivered: Boolean(chain.fulfillment),
    };

    let theirs = null;
    let error: string | null = null;
    try {
      theirs = await rail.fetchStatus(order.order_id);
    } catch (err) {
      // A gateway that cannot be reached is not a payment that did not happen.
      // Say which one this is.
      error = describeThrown(err);
    }

    const agrees =
      theirs !== null &&
      (ours.payment_id === null || theirs.payment_id === null || ours.payment_id === theirs.payment_id) &&
      (theirs.source === "simulated" || theirs.amount_paise === ours.amount_paise);

    res.json({
      transaction_id: id,
      rail: simulated ? "simulated" : "razorpay",
      ours,
      gateway: theirs,
      ...(error ? { gateway_error: error } : {}),
      agrees,
      note: simulated
        ? "This order settled on the simulated rail. Nothing here was fetched from Razorpay."
        : "The gateway block was fetched from Razorpay just now, not read from our database.",
    });
  });

  app.get("/orders", (_req: Request, res: Response) => {
    const rows = store
      .listTransactions()
      .map((t) => store.loadChain(t.transaction_id))
      .filter((c): c is NonNullable<typeof c> => Boolean(c) && Boolean(c?.cart))
      .map((chain) => {
        const cart = chain.cart!;
        const item = catalogItems.find((i) => i.item_id === cart.item_id);
        const merchant = item ? merchants.get(item.merchant_id) : undefined;
        return {
          transaction_id: chain.transaction_id,
          item_id: cart.item_id,
          item_name: item?.name ?? cart.item_id,
          photo_url: item
            ? photoUrlFor.get(item.item_id) ??
              (structuring.photos[item.item_id]?.present && structuring.photos[item.item_id]?.filename
                ? `/media/${structuring.photos[item.item_id]!.filename}`
                : null)
            : null,
          merchant_id: item?.merchant_id ?? null,
          merchant_name: merchant?.name ?? item?.merchant_id ?? "unknown shop",
          amount: cart.final_price.value,
          ordered_at: cart.issued_at,
          paid: Boolean(chain.payment),
          paid_at: chain.payment?.issued_at ?? null,
          payment_id: chain.payment?.razorpay_payment_id ?? null,
          delivered: Boolean(chain.fulfillment),
          delivered_at: chain.fulfillment?.confirmed_at ?? null,
          status: chain.fulfillment ? "delivered" : chain.payment ? "awaiting_handover" : "awaiting_payment",
        };
      })
      .sort((a, b) => ((a.paid_at ?? a.ordered_at) < (b.paid_at ?? b.ordered_at) ? 1 : -1));

    res.json({
      orders: rows,
      awaiting_payment: rows.filter((r) => r.status === "awaiting_payment").length,
      awaiting_handover: rows.filter((r) => r.status === "awaiting_handover").length,
      delivered: rows.filter((r) => r.status === "delivered").length,
    });
  });

  /** One order, for a buyer reconciling a screen against stored state. */
  app.get("/orders/:id", (req: Request, res: Response) => {
    const chain = store.loadChain(String(req.params.id));
    if (!chain?.cart) {
      res.status(404).json({ error: `no such order: ${req.params.id}` });
      return;
    }
    const item = catalogItems.find((i) => i.item_id === chain.cart!.item_id);
    res.json({
      transaction_id: chain.transaction_id,
      item_id: chain.cart.item_id,
      item_name: item?.name ?? chain.cart.item_id,
      merchant_name: item ? merchants.get(item.merchant_id)?.name ?? item.merchant_id : "unknown shop",
      amount: chain.cart.final_price.value,
      paid: Boolean(chain.payment),
      payment_id: chain.payment?.razorpay_payment_id ?? null,
      delivered: Boolean(chain.fulfillment),
      delivered_at: chain.fulfillment?.confirmed_at ?? null,
      status: chain.fulfillment ? "delivered" : chain.payment ? "awaiting_handover" : "awaiting_payment",
    });
  });

  app.get("/merchants/:id/orders", (req: Request, res: Response) => {
    const id = String(req.params.id);
    if (!merchants.has(id)) {
      res.status(404).json({ error: `no such merchant: ${id}` });
      return;
    }

    const rows = store
      .listTransactionIdsForMerchant(id)
      .map((tid) => store.loadChain(tid))
      .filter((c): c is NonNullable<typeof c> => Boolean(c) && Boolean(c!.cart))
      .map((chain) => {
        const item = catalogItems.find((i) => i.item_id === chain.cart!.item_id);
        return {
          transaction_id: chain.transaction_id,
          item_id: chain.cart!.item_id,
          item_name: item?.name ?? chain.cart!.item_id,
          amount: chain.cart!.final_price.value,
          agreed_at: chain.cart!.issued_at,
          paid: Boolean(chain.payment),
          paid_at: chain.payment?.issued_at ?? null,
          payment_id: chain.payment?.razorpay_payment_id ?? null,
          delivered: Boolean(chain.fulfillment),
          delivered_at: chain.fulfillment?.confirmed_at ?? null,
          status: chain.fulfillment ? "delivered" : chain.payment ? "awaiting_handover" : "awaiting_payment",
        };
      })
      .sort((a, b) => (a.paid_at ?? a.agreed_at) < (b.paid_at ?? b.agreed_at) ? 1 : -1);

    res.json({
      merchant_id: id,
      awaiting_handover: rows.filter((r) => r.status === "awaiting_handover").length,
      orders: rows,
    });
  });

  /**
   * Edit a product.
   *
   * A catalog read out of a photograph is a first draft, and the shopkeeper is
   * the authority on their own stock. Anything they set here is theirs: the
   * confidence goes to certain and the price stops being re-litigated by the
   * sanity check, because they have now said it directly rather than been heard
   * saying it.
   */
  /**
   * Replace a product's photo.
   *
   * A picture read out of a shelf photo is frequently the wrong one — the
   * extraction pairs photos to products positionally and says outright that
   * this is a display hint, not a fact. Until now a merchant who spotted the
   * mismatch had no way to correct it, which made the catalog screen the one
   * place in the product where they could see a mistake and not fix it.
   *
   * Seed items live in a file rather than the onboarding table, so this promotes
   * the item into that table on first edit — the same thing the price and stock
   * editor already does.
   */
  app.post(
    "/merchants/:id/items/:itemId/photo",
    upload.single("photo"),
    (req: Request, res: Response) => {
      const id = String(req.params.id);
      const itemId = String(req.params.itemId);
      const file = req.file as Express.Multer.File | undefined;
      if (!file) {
        res.status(400).json({ error: "attach a photo" });
        return;
      }

      const item = catalogItems.find((i) => i.item_id === itemId && i.merchant_id === id);
      if (!item) {
        res.status(404).json({ error: `no such product for this shop: ${itemId}` });
        return;
      }

      const photoUrl = `/uploads/${file.filename}`;
      const existing = onboarding.listItems().find((r) => r.item.item_id === itemId);
      onboarding.saveItem({
        item,
        ...(existing?.policy ?? policies.get(itemId) ? { policy: existing?.policy ?? policies.get(itemId)! } : {}),
        photo_url: photoUrl,
      });
      photoUrlFor.set(itemId, photoUrl);

      res.status(201).json({ item_id: itemId, photo_url: photoUrl });
    },
  );

  app.patch("/merchants/:id/items/:itemId", (req: Request, res: Response) => {
    const id = String(req.params.id);
    const itemId = String(req.params.itemId);
    const index = catalogItems.findIndex((i) => i.item_id === itemId && i.merchant_id === id);
    if (index < 0) {
      res.status(404).json({ error: `no such product at this shop: ${itemId}` });
      return;
    }

    const current = catalogItems[index]!;
    const body = req.body ?? {};
    const next: CatalogItem = { ...current, attributes: { ...current.attributes } };
    const changed: string[] = [];

    if (typeof body.name === "string" && body.name.trim()) {
      next.name = body.name.trim();
      changed.push("name");
    }
    if (typeof body.category === "string" && body.category.trim()) {
      next.category = body.category.trim();
      changed.push("category");
    }
    if (typeof body.price === "number" && body.price > 0) {
      next.price = { ...current.price, value: body.price, confidence: 1 };
      merchantConfirmed.add(itemId);
      changed.push("price");
    }
    if (typeof body.stock === "number" && body.stock >= 0) {
      next.stock = { quantity: body.stock, confidence: 1 };
      changed.push("stock");
    }
    if (body.attributes && typeof body.attributes === "object") {
      next.attributes = Object.fromEntries(
        Object.entries(body.attributes as Record<string, unknown>)
          .filter(([, v]) => typeof v === "string" && String(v).trim())
          .map(([k, v]) => [k, String(v).trim()]),
      );
      changed.push("attributes");
    }

    if (changed.length === 0) {
      res.status(400).json({ error: "nothing to change" });
      return;
    }

    // Re-run the gate on the edited item, exactly as at extraction time.
    const sanity = priceSanity(next, catalogItems.map((i) => (i.item_id === itemId ? next : i)), {
      merchantConfirmed: merchantConfirmed.has(itemId),
    });
    const gate = evaluateGate(next, sanity);
    next.needs_merchant_confirmation = gate.held;
    catalogItems[index] = next;

    // Keep the merchant's negotiation policy coherent with the new price — and
    // create one if the item never had a price to build a policy from.
    //
    // Onboarding only writes a policy for items that arrived priced, so a
    // product extracted from a photo alone had none. Giving it a price here
    // then left it permanently unsellable: discovery found it, negotiation had
    // no floor to work against, and it was reported as "stocks it, but has not
    // set a price floor" forever.
    const policy = policies.get(itemId);
    if (changed.includes("price") && next.price.value > 0) {
      const updated: NegotiationPolicy = policy
        ? {
            ...policy,
            list_price: next.price.value,
            floor_price: Math.min(policy.floor_price > 0 ? policy.floor_price : next.price.value, next.price.value),
            set_at: new Date().toISOString(),
          }
        : {
            item_id: itemId,
            list_price: next.price.value,
            floor_price: Math.max(1, Math.round(next.price.value * 0.85)),
            max_rounds: 3,
            set_by: "merchant",
            set_at: new Date().toISOString(),
          };
      policies.set(itemId, updated);
    }

    const row = onboarding.listItems().find((r) => r.item.item_id === itemId);
    if (row) onboarding.saveItem({ ...row, item: next, ...(policies.get(itemId) ? { policy: policies.get(itemId)! } : {}) });

    bus.emit({
      type: "clarification.resolved",
      merchant_id: id,
      item_id: itemId,
      message: `${next.name} updated by the shopkeeper (${changed.join(", ")})`,
      data: { changed },
    });

    res.json({
      item: next,
      changed,
      transactable: !next.needs_merchant_confirmation,
      still_held_because: gate.reasons,
      policy: policies.get(itemId) ?? null,
    });
  });

  /**
   * Remove a product.
   *
   * Refused while a live transaction names it: an item that has been sold and
   * not yet handed over is part of a signed chain, and deleting it out from
   * under that would leave a mandate pointing at nothing.
   */
  app.delete("/merchants/:id/items/:itemId", (req: Request, res: Response) => {
    const id = String(req.params.id);
    const itemId = String(req.params.itemId);
    const index = catalogItems.findIndex((i) => i.item_id === itemId && i.merchant_id === id);
    if (index < 0) {
      res.status(404).json({ error: `no such product at this shop: ${itemId}` });
      return;
    }

    const openOrder = store
      .listTransactionIdsForMerchant(id)
      .map((tid) => store.loadChain(tid))
      .find((c) => c?.cart?.item_id === itemId && c.payment && !c.fulfillment);

    if (openOrder) {
      res.status(409).json({
        error: `${itemId} is on an order that is paid but not handed over (${openOrder.transaction_id}). Confirm the handover first.`,
      });
      return;
    }

    const [removed] = catalogItems.splice(index, 1);
    policies.delete(itemId);
    merchantConfirmed.delete(itemId);
    onboarding.deleteItem(itemId);
    // Seed products were never in the onboarding table, so removing the row
    // there deletes nothing and the catalog file puts them back on boot.
    onboarding.markDeleted(itemId);
    photoUrlFor.delete(itemId);

    bus.emit({
      type: "extraction.held",
      merchant_id: id,
      item_id: itemId,
      message: `${removed?.name ?? itemId} removed from the catalog`,
    });

    res.json({ removed: itemId, remaining: catalogItems.filter((i) => i.merchant_id === id).length });
  });

  /**
   * What changed for this shop, in numbers it can check.
   *
   * "Before" is not a strawman and not a guess: a UPI VPA really is the whole of
   * these merchants' machine-readable presence, and every "after" figure is
   * counted from stored state. A growth panel that estimated anything would be
   * the one screen here nobody could argue with, which is the opposite of the
   * point.
   */
  app.get("/merchants/:id/growth", async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const merchant = merchants.get(id);
    if (!merchant) {
      res.status(404).json({ error: `no such merchant: ${id}` });
      return;
    }

    const mine = catalogItems.filter((i) => i.merchant_id === id);
    const sellable = mine.filter((i) => !i.needs_merchant_confirmation);
    const withPolicy = sellable.filter((i) => policies.has(i.item_id));
    const events = demand.forMerchant(id);

    const chains = store
      .listTransactionIdsForMerchant(id)
      .map((t) => store.loadChain(t))
      .filter((c): c is NonNullable<typeof c> => Boolean(c));

    const paid = chains.filter((c) => c.payment);
    const delivered = paid.filter((c) => c.fulfillment);
    const verifiedValue = delivered.reduce((sum, c) => sum + (c.cart?.final_price.value ?? 0), 0);

    /**
     * Both money figures, because one alone was being read as the other.
     *
     * This panel showed "96 sales" beside "₹5,672 verified" and left the two
     * next to each other, which reads as ₹59 a sale. It is not: ₹5,672 is the
     * subset the shopkeeper has signed a handover for, and the 96 paid sales
     * took ₹9,581. Both are true and neither answers the other's question, so
     * both are named.
     */
    const led = merchantStats(id, transactionsNow(), catalogItems);

    // A structured record carries roughly eight machine-readable facts: name,
    // category, two attributes, price, stock, availability, and a floor.
    const FIELDS_PER_PRODUCT = 8;

    // Distinct searches that reached this shop, by timestamp.
    const searches = new Set(events.map((e) => e.at)).size;
    const withMatch = new Set(events.filter((e) => e.item_id).map((e) => e.at)).size;
    const reachedPrice = new Set(events.filter((e) => e.outcome === "sold").map((e) => e.at)).size;

    res.json({
      merchant_id: id,
      name: merchant.name,
      before: {
        label: "UPI only",
        machine_readable_fields: 1,
        products_an_agent_can_see: 0,
        products_an_agent_can_buy: 0,
        negotiable_products: 0,
        buyers_reached: 0,
        sales: 0,
        verified_value: 0,
        detail: `One UPI ID (${merchant.upi_vpa}) and nothing else a machine can read.`,
      },
      after: {
        label: "Agent-readable",
        machine_readable_fields: mine.length * FIELDS_PER_PRODUCT,
        products_an_agent_can_see: mine.length,
        products_an_agent_can_buy: sellable.length,
        negotiable_products: withPolicy.length,
        buyers_reached: searches,
        sales: paid.length,
        revenue: led.revenue,
        units_sold: led.unitsSold,
        average_order_value: led.averageOrderValue,
        verified_value: verifiedValue,
        verified_sales: delivered.length,
        detail: `${mine.length} structured products, ${withPolicy.length} of them open to negotiation, on the same UPI ID.`,
      },
      // Every buyer who reached this shop, and where they stopped.
      funnel: [
        { stage: "Buyers who searched", count: searches, note: "AI buyers whose request reached this shop" },
        { stage: "Found a match here", count: withMatch, note: "the shop stocked something that fit" },
        { stage: "Agreed a price", count: reachedPrice, note: "negotiation closed inside both bounds" },
        { stage: "Paid", count: paid.length, note: "captured through Razorpay" },
        { stage: "Confirmed delivered", count: delivered.length, note: "the shopkeeper signed the handover" },
      ],
      lost: {
        on_price: events.filter((e) => e.outcome === "lost_on_price").length,
        held_stock: events.filter((e) => e.outcome === "held").length,
        no_match: events.filter((e) => e.outcome === "no_match").length,
      },
      // Where the suggestions the shop made actually landed. Recorded when the
      // buyer agreed, never inferred afterwards.
      attributed_revenue: led.byAttribution,
      note:
        "Counted from stored state. Nothing here is projected, sampled or estimated. " +
        "`revenue` is every captured payment; `verified_value` is the part the shopkeeper has confirmed delivered.",
    });
  });

  /** The trust assessment for one transaction, computed from stored state. */
  function trustFor(transactionId: string): (Intervention & { transaction_id: string; amount: number }) | null {
    const chain = store.loadChain(transactionId);
    if (!chain?.cart) return null;

    const merchantId = chain.cart.merchant_id;
    const history = store
      .listTransactionIdsForMerchant(merchantId)
      .filter((id) => id !== transactionId)
      .map((id) => store.loadChain(id))
      .filter((c): c is NonNullable<typeof c> => Boolean(c));

    const item = catalogItems.find((i) => i.item_id === chain.cart!.item_id);
    const signals = assessSignals({
      chain,
      item,
      policy: policies.get(chain.cart.item_id),
      history,
      now: new Date(),
    });

    const amount = chain.cart.final_price.value;
    return { ...recommend(signals, amount), transaction_id: transactionId, amount };
  }

  /**
   * The buyer-facing trust check, and the merchant-facing one — the same call.
   *
   * Two screens showing different verdicts about the same payment would be
   * worse than showing none, so there is only one assessment and both read it.
   */
  app.get("/transactions/:id/trust", (req: Request, res: Response) => {
    const id = String(req.params.id);
    const trust = trustFor(id);
    if (!trust) {
      res.status(404).json({ error: `no such transaction, or it has no agreed cart: ${id}` });
      return;
    }
    res.json(trust);
  });

  /**
   * Everything wanting a shopkeeper's attention, in one list, worst first.
   *
   * Deliberately mixes kinds — a payment to review, a product to confirm, an
   * order to hand over — because a merchant does not think in subsystems and
   * should not have to visit three screens to find out whether anything needs
   * them.
   */
  app.get("/merchants/:id/alerts", (req: Request, res: Response) => {
    const id = String(req.params.id);
    if (!merchants.has(id)) {
      res.status(404).json({ error: `no such merchant: ${id}` });
      return;
    }

    const alerts: Array<Record<string, unknown>> = [];

    // Payments that want a decision.
    for (const txnId of store.listTransactionIdsForMerchant(id)) {
      const chain = store.loadChain(txnId);
      if (!chain?.payment || chain.fulfillment) continue;
      const trust = trustFor(txnId);
      if (!trust) continue;

      if (trust.action === "allow" || trust.action === "monitor") {
        alerts.push({
          kind: "handover",
          urgency: "normal",
          transaction_id: txnId,
          title: "Ready to hand over",
          detail: `${catalogItems.find((i) => i.item_id === chain.cart?.item_id)?.name ?? chain.cart?.item_id} — ₹${trust.amount}`,
          action: "Confirm handover",
          action_endpoint: `/transactions/${txnId}/confirm-fulfillment`,
        });
      } else {
        alerts.push({
          kind: "payment_review",
          urgency: trust.action === "block" ? "high" : "attention",
          transaction_id: txnId,
          title: trust.headline,
          detail: trust.rationale,
          next_step: trust.next_step,
          recommended: trust.action,
          signals: trust.signals,
          amount: trust.amount,
        });
      }
    }

    // Products an agent cannot sell.
    for (const item of catalogItems.filter((i) => i.merchant_id === id && i.needs_merchant_confirmation)) {
      const question = store.openClarificationFor(item.item_id);
      alerts.push({
        kind: "confirm_product",
        urgency: "attention",
        item_id: item.item_id,
        title: "Product information needs confirming",
        detail: question?.question ?? `${item.name} cannot be sold until its details are confirmed.`,
        options: question?.options ?? [],
        clarification_id: question?.clarification_id ?? null,
      });
    }

    const rank: Record<string, number> = { high: 0, attention: 1, normal: 2 };
    const urgency = (a: Record<string, unknown>): number => rank[String(a.urgency)] ?? 9;
    alerts.sort((a, b) => urgency(a) - urgency(b));

    // Today's takings, counted from confirmed sales only.
    const since = new Date(); since.setHours(0, 0, 0, 0);
    let collectedToday = 0;
    let paymentsToday = 0;
    for (const txnId of store.listTransactionIdsForMerchant(id)) {
      const chain = store.loadChain(txnId);
      if (!chain?.payment) continue;
      if (Date.parse(chain.payment.issued_at) < since.getTime()) continue;
      paymentsToday++;
      collectedToday += chain.payment.amount;
    }

    res.json({
      merchant_id: id,
      all_clear: alerts.length === 0,
      needs_attention: alerts.filter((a) => a.urgency !== "normal").length,
      today: { collected: collectedToday, payments: paymentsToday },
      alerts,
    });
  });

  /**
   * The agent's hands. Each tool reads the same state every screen reads, so
   * the assistant and the dashboard can never disagree about the shop.
   */
  async function runTool(merchantId: string, call: ToolCall): Promise<ToolResult> {
    const def = TOOLS.find((t) => t.name === call.tool);
    const base: ToolResult = { tool: call.tool, args: call.args, summary: "", data: null };
    if (!def) return { ...base, error: `no such tool: ${call.tool}`, summary: `Unknown tool ${call.tool}` };

    const money = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;
    const mine = () => catalogItems.filter((i) => i.merchant_id === merchantId);

    switch (call.tool) {
      case "get_alerts": {
        const r = await fetchLocal(`/merchants/${merchantId}/alerts`);
        return { ...base, data: r,
          summary: r.all_clear
            ? `Nothing needs attention. ${money(r.today.collected)} collected today across ${r.today.payments} payment(s).`
            : `${r.needs_attention} thing(s) need attention; ${money(r.today.collected)} collected today.` };
      }
      case "list_products": {
        const items = mine().map((i) => ({
          item_id: i.item_id, name: i.name, price: i.price.value, stock: i.stock.quantity,
          sellable: !i.needs_merchant_confirmation,
          held_because: gateReasons(i, sanityFor(i)),
        }));
        const held = items.filter((i) => !i.sellable).length;
        return { ...base, data: items,
          summary: `${items.length} product(s); ${held} cannot be sold until confirmed.` };
      }
      case "get_orders": {
        const r = await fetchLocal(`/merchants/${merchantId}/orders`);
        return { ...base, data: r.orders,
          summary: `${r.orders.length} order(s); ${r.awaiting_handover} waiting to be handed over.` };
      }
      case "explain_payment": {
        const id = String(call.args.transaction_id ?? "");
        const trust = trustFor(id);
        if (!trust) return { ...base, error: `no such transaction: ${id}`, summary: `Could not find ${id}` };
        return { ...base, data: trust,
          summary: `${trust.headline} — recommended: ${trust.action}.` };
      }
      case "explain_readiness": {
        const r = readinessFor(merchantId);
        return { ...base, data: r, summary: `Readiness ${r.score}/100 — ${r.explanation}` };
      }
      case "get_lost_sales": {
        const r = await fetchLocal(`/merchants/${merchantId}/opportunities`);
        return { ...base, data: r,
          summary: `${r.buyers_lost} buyer(s) left without buying, across ${r.searches_seen} search(es).` };
      }
      case "get_commerce_history": {
        const r = await fetchLocal(`/merchants/${merchantId}/commerce-history`);
        return { ...base, data: {
            completed: r.completed_transactions, verified_value: r.total_verified_value,
            fulfillment_rate: r.fulfillment_confirmation_rate, avg_discount: r.negotiation_avg_discount_pct },
          summary: `${r.completed_transactions} delivered sale(s), ${money(r.total_verified_value)} verified.` };
      }

      // ── proposals — these do not act ────────────────────────────────────
      case "propose_confirm_handover": {
        const id = String(call.args.transaction_id ?? "");
        const chain = store.loadChain(id);
        if (!chain?.payment) return { ...base, error: `${id} is not a paid order`, summary: `${id} has not been paid` };
        if (chain.fulfillment) return { ...base, data: { already: true }, summary: `${id} was already handed over.` };
        const item = catalogItems.find((i) => i.item_id === chain.cart?.item_id);
        return { ...base,
          data: { transaction_id: id, item: item?.name, amount: chain.cart?.final_price.value },
          summary: `Ready to confirm handover of ${item?.name ?? id}.`,
          proposal: {
            label: `Confirm handover — ${item?.name ?? id}, ${money(chain.cart?.final_price.value ?? 0)}`,
            endpoint: `/transactions/${id}/confirm-fulfillment`, method: "POST",
            body: { evidence_note: "Handed over in person at the shop" },
          } };
      }
      case "propose_set_price": {
        const itemId = String(call.args.item_id ?? "");
        const item = mine().find((i) => i.item_id === itemId);
        if (!item) return { ...base, error: `no such product: ${itemId}`, summary: `Could not find ${itemId}` };
        const price = Number(call.args.price ?? 0);
        const stock = Number(call.args.stock ?? -1);
        const body: Record<string, unknown> = {};
        if (price > 0) body.price = price;
        if (stock >= 0) body.stock = stock;
        if (Object.keys(body).length === 0) {
          return { ...base, error: "no price or stock given", summary: "Nothing to propose — no price or stock." };
        }
        return { ...base, data: { item_id: itemId, ...body },
          summary: `Ready to set ${item.name}${price > 0 ? ` to ${money(price)}` : ""}${stock >= 0 ? `, ${stock} in stock` : ""}.`,
          proposal: {
            label: `Set ${item.name}${price > 0 ? ` to ${money(price)}` : ""}${stock >= 0 ? `, stock ${stock}` : ""}`,
            endpoint: `/merchants/${merchantId}/items/${itemId}`, method: "PATCH", body,
          } };
      }
      default:
        return { ...base, error: `tool not implemented: ${call.tool}`, summary: "Not implemented" };
    }
  }

  /** Read one of our own endpoints without going over the network. */
  async function fetchLocal(
    path: string,
    opts: { method?: "GET" | "POST" | "PATCH" | "DELETE"; body?: unknown } = {},
  ): Promise<any> {
    const method = opts.method ?? "GET";
    const res = await fetch(`http://127.0.0.1:${localPort}${path}`, {
      method,
      ...(method === "GET"
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(opts.body ?? {}) }),
    });
    const body = await res.json().catch(() => ({}));
    // A write that failed must not read as one that worked. The assistant's
    // whole value is that its confirmations are true, so the status travels
    // with the body rather than being dropped here.
    if (!res.ok) {
      throw new Error(
        (body as { error?: string })?.error ?? `${method} ${path} failed with ${res.status}`,
      );
    }
    return body;
  }


  /* ══ the merchant's assistant ═══════════════════════════════════════════ */

  /**
   * One turn of a shopkeeper's conversation, kept server-side.
   *
   * The follow-up is the whole reason this exists. "How much did I sell
   * yesterday" then "why was it lower" — the second question is unanswerable
   * without the first, and a merchant should never have to repeat themselves to
   * their own assistant. Held here rather than in the browser because the
   * answers are about money and the browser is not where the money is.
   */
  interface MerchantTurn {
    role: "merchant" | "assistant";
    text: string;
    at: string;
  }
  interface MerchantConversation {
    merchant_id: string;
    turns: MerchantTurn[];
    /** What the last answer was about, so "it" and "that" have a referent. */
    focus: { tool: string; label: string; data: unknown } | null;
    updated_at: string;
  }
  const MAX_CONVERSATIONS = 100;
  const conversations = new Map<string, MerchantConversation>();

  function conversationFor(id: string, merchantId: string): MerchantConversation {
    let c = conversations.get(id);
    if (!c || c.merchant_id !== merchantId) {
      c = { merchant_id: merchantId, turns: [], focus: null, updated_at: new Date().toISOString() };
      conversations.set(id, c);
      if (conversations.size > MAX_CONVERSATIONS) {
        const oldest = conversations.keys().next().value;
        if (oldest) conversations.delete(oldest);
      }
    }
    return c;
  }

  /** What a tool hands back: a sentence, the rows behind it, and what to draw. */
  interface MerchantToolOutput {
    summary: string;
    data: unknown;
    /** The interface renders this rather than parsing the sentence. */
    card?: Record<string, unknown>;
    /** Set when the tool prepared something a person has to approve. */
    action?: ReturnType<typeof proposeAction>;
    error?: string;
  }

  const rupees = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;

  /** Sales for a window, from the ledger — never a counter. */
  function salesFor(merchantId: string, period: string) {
    const txns = transactionsNow().filter((t) => t.merchantId === merchantId);
    const paid = txns.filter((t) => t.status === "paid" || t.status === "delivered");
    const day = (iso: string) => iso.slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const since = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

    const pick = (rows: typeof paid) => ({
      revenue: rows.reduce((s, t) => s + t.amount, 0),
      orders: rows.length,
      units: rows.reduce((s, t) => s + t.items.reduce((n, l) => n + l.quantity, 0), 0),
    });

    const on = (d: string) => paid.filter((t) => day(t.paidAt ?? t.createdAt) === d);
    const after = (d: string) => paid.filter((t) => day(t.paidAt ?? t.createdAt) >= d);

    switch (period) {
      case "today": return { label: "today", now: pick(on(today)), before: pick(on(yesterday)), beforeLabel: "yesterday" };
      case "yesterday": return { label: "yesterday", now: pick(on(yesterday)), before: pick(on(since(2))), beforeLabel: "the day before" };
      case "week": return { label: "the last 7 days", now: pick(after(since(7))), before: pick(after(since(14)).filter((t) => day(t.paidAt ?? t.createdAt) < since(7))), beforeLabel: "the 7 days before" };
      case "month": return { label: "the last 30 days", now: pick(after(since(30))), before: pick(after(since(60)).filter((t) => day(t.paidAt ?? t.createdAt) < since(30))), beforeLabel: "the 30 days before" };
      default: return { label: "all time", now: pick(paid), before: null, beforeLabel: "" };
    }
  }

  function proposeAction(row: {
    merchant_id: string; conversation_id: string; tool: string;
    args: Record<string, unknown>; summary: string; confirm: boolean;
  }) {
    return merchantActions.propose(row);
  }

  /**
   * Run one merchant tool.
   *
   * Reads go through the endpoints that already serve the dashboard, so the
   * assistant and the screens cannot disagree about a number — they are reading
   * one source. Writes never happen here: they return a proposal carrying an
   * action id, and only the merchant pressing turns that into work.
   */
  async function runMerchantTool(
    merchantId: string,
    conversationId: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<MerchantToolOutput> {
    const def = merchantToolByName(name);
    if (!def) return { summary: `I do not have a way to do that.`, data: null, error: `no such tool: ${name}` };

    const mine = () => catalogItems.filter((i) => i.merchant_id === merchantId);
    const shop = merchants.get(merchantId);

    switch (name) {
      case "get_today": {
        const s = salesFor(merchantId, "today");
        const alerts = await fetchLocal(`/merchants/${merchantId}/alerts`);
        const orders = await fetchLocal(`/merchants/${merchantId}/orders`);
        // `paid` and `delivered` are booleans on this row. The status *string*
        // says "awaiting_handover" for an order that has been paid for, so
        // filtering on status === "paid" found none of them and counted every
        // one as unpaid — money already in the bank, reported as owed.
        const pending = (orders.orders ?? []).filter((o: { paid?: boolean; delivered?: boolean }) => o.paid && !o.delivered);
        const waiting = pending.length;
        const worth = pending.reduce((sum: number, o: { amount: number }) => sum + o.amount, 0);

        /**
         * Offer the thing it just told them about.
         *
         * Saying "48 waiting to be handed over" and then making the shopkeeper
         * start a fresh request to do anything about it is the interface being
         * a report rather than an assistant. The proposal is minted here so the
         * answer arrives with a button on it — and it still does nothing until
         * that button is pressed.
         */
        const offer = waiting === 0 ? undefined : proposeAction({
          merchant_id: merchantId, conversation_id: conversationId,
          tool: "propose_bulk_handover", args: {}, confirm: true,
          summary: `Mark all ${waiting} paid order(s) — ${rupees(worth)} — as handed to their buyers`,
        });

        return {
          summary: s.now.orders === 0
            ? `Nothing has sold yet today.${waiting > 0 ? ` ${waiting} paid order(s) are still waiting to be handed over.` : ""}`
            : `${rupees(s.now.revenue)} today across ${s.now.orders} order(s).${
                waiting > 0 ? ` ${waiting} waiting to be handed over — say "hand these over" and I will do all of them.` : ""}`,
          data: { ...s, waiting_handover: waiting, needs_attention: alerts.needs_attention ?? 0 },
          card: {
            kind: "stat", title: "Today", value: rupees(s.now.revenue),
            sub: `${s.now.orders} order(s)`,
            delta: deltaOf(s.now.revenue, s.before?.revenue ?? null, s.beforeLabel),
            rows: waiting > 0 ? [{ label: "Waiting to hand over", value: String(waiting) }] : [],
          },
          ...(offer ? { action: offer } : {}),
        };
      }

      case "get_sales": {
        const period = String(args.period ?? "today");
        const s = salesFor(merchantId, period);
        return {
          summary: s.now.orders === 0
            ? `Nothing sold ${s.label}.`
            : `${rupees(s.now.revenue)} ${s.label}, across ${s.now.orders} order(s).`,
          data: s,
          card: {
            kind: "stat", title: `Sales — ${s.label}`, value: rupees(s.now.revenue),
            sub: `${s.now.orders} order(s) · ${s.now.units} item(s)`,
            delta: deltaOf(s.now.revenue, s.before?.revenue ?? null, s.beforeLabel),
          },
        };
      }

      case "get_product_performance": {
        const r = await fetchLocal(`/merchants/${merchantId}/products/analytics`);
        const rows = (r.products ?? []) as Array<{ name: string; unitsSold: number; revenue: number; currentStock: number; averageSellingPrice: number; listPrice: number | null }>;
        const sold = rows.filter((p) => p.unitsSold > 0);
        const idle = rows.filter((p) => p.unitsSold === 0);
        return {
          // The four that have never sold are more actionable than the one
          // that sells best, and counting them without naming them leaves the
          // merchant to go and find out which — so they are named while the
          // list is short enough to read.
          summary: sold.length === 0
            ? `Nothing has sold yet, so there is no ranking to give you.`
            : `${sold[0]!.name} earns the most — ${rupees(sold[0]!.revenue)} from ${sold[0]!.unitsSold} sold.` +
              (idle.length === 0
                ? ""
                : idle.length <= 4
                  ? ` These have never sold: ${idle.map((p) => p.name).join(", ")}.`
                  : ` ${idle.length} products have never sold.`),
          data: rows,
          card: {
            kind: "table", title: "What each product earned",
            columns: ["Product", "Sold", "Earned", "Left"],
            rows: rows.slice(0, 8).map((p) => [p.name, String(p.unitsSold), rupees(p.revenue), String(p.currentStock)]),
            footer: idle.length > 0 ? `${idle.length} product(s) have not sold at all.` : "",
          },
        };
      }

      case "diagnose_sales": {
        // The measured comparison comes first: whether sales are actually down
        // is a fact to establish, not an assumption to explain. A shop that is
        // up must not be handed reasons for a decline that did not happen.
        const trend = await fetchLocal(`/merchants/${merchantId}/trend?period=week`);
        const [lost, opps, r] = await Promise.all([
          fetchLocal(`/merchants/${merchantId}/recovery`),
          fetchLocal(`/merchants/${merchantId}/revenue-agent`),
          fetchLocal(`/merchants/${merchantId}/products/analytics`),
        ]);
        const held = mine().filter((i) => i.needs_merchant_confirmation);
        const out = mine().filter((i) => !i.needs_merchant_confirmation && i.stock.quantity === 0);
        const idle = ((r.products ?? []) as Array<{ name: string; unitsSold: number; currentStock: number }>)
          .filter((p) => p.unitsSold === 0 && p.currentStock > 0);

        const causes: string[] = [];
        if (out.length > 0) causes.push(`${out.length} product(s) are out of stock — an agent cannot buy what is not there`);
        if (held.length > 0) causes.push(`${held.length} product(s) are still waiting for you to confirm a price or a count, so they are in no offers`);
        if ((lost.cases ?? []).length > 0) causes.push(`${lost.cases.length} buyer(s) walked away, mostly on price`);
        if (idle.length > 0) causes.push(`${idle.length} product(s) have never sold`);

        const headline =
          trend.change_pct === null
            ? `There is not enough history to compare ${trend.period} with the period before.`
            : trend.direction === "down"
              ? `Takings are down ${Math.abs(trend.change_pct)}% over ${trend.period} — ${rupees(trend.now.revenue)} against ${rupees(trend.before.revenue)}.`
              : trend.direction === "up"
                ? `Takings are actually up ${trend.change_pct}% over ${trend.period} — ${rupees(trend.now.revenue)} against ${rupees(trend.before.revenue)}.`
                : `Takings are level over ${trend.period} — ${rupees(trend.now.revenue)} against ${rupees(trend.before.revenue)}.`;

        const moved = (trend.contributors ?? []) as Array<{ what: string; detail: string; change: number }>;
        const measured = moved.slice(0, 3).map((c) => `${c.what} (${c.detail})`);

        return {
          summary:
            headline +
            (measured.length > 0 ? ` The biggest changes: ${measured.join("; ")}.` : "") +
            (causes.length > 0 ? ` Also worth knowing: ${causes.join("; ")}.` : ""),
          data: { trend, out_of_stock: out.map((i) => i.name), held: held.map((i) => i.name), lost: lost.cases ?? [], idle },
          card: {
            kind: "reasons", title: "What changed",
            rows: [
              ...moved.slice(0, 4).map((c) => ({
                label: `${c.what}: ${c.detail}`,
                tone: c.change < 0 ? "bad" : "ok",
              })),
              ...out.map((i) => ({ label: `${i.name} is out of stock`, tone: "bad" })),
              ...held.map((i) => ({ label: `${i.name} is waiting on you`, tone: "warn" })),
              ...idle.slice(0, 3).map((p) => ({ label: `${p.name} has never sold`, tone: "warn" })),
              ...(causes.length === 0 ? [{ label: "Nothing obvious is wrong", tone: "ok" }] : []),
            ],
          },
        };
      }

      case "get_pending_payments": {
        const r = await fetchLocal(`/merchants/${merchantId}/orders`);
        const due = ((r.orders ?? []) as Array<{ transaction_id: string; item_name: string; amount: number; paid: boolean }>)
          .filter((o) => !o.paid);
        const total = due.reduce((s, o) => s + o.amount, 0);
        return {
          summary: due.length === 0
            ? `Everything agreed has been paid for.`
            : `${due.length} order(s) were agreed but never paid — ${rupees(total)} in total. These are AI buyers who dropped out at checkout, so there is nobody to chase; you can send a payment link instead.`,
          data: due,
          card: due.length === 0 ? { kind: "stat", title: "Unpaid", value: "None", sub: "everything agreed has been paid" } : {
            kind: "table", title: `Agreed but not paid — ${rupees(total)}`,
            columns: ["Order", "Item", "Amount"],
            rows: due.slice(0, 8).map((o) => [o.transaction_id.slice(0, 14), o.item_name, rupees(o.amount)]),
            footer: "A payment link can be sent for any of these — ask me for one.",
          },
        };
      }

      case "get_payment_status": {
        const txn = String(args.transaction_id ?? "");
        const chain = store.loadChain(txn);
        if (!chain) return { summary: `I could not find order ${txn}.`, data: null, error: "no such order" };
        const paid = Boolean(chain.payment);
        return {
          summary: !chain.cart ? `Order ${txn} never reached an agreed price.`
            : paid
              ? `${rupees(chain.cart.final_price.value)} was paid${chain.fulfillment ? " and you have confirmed handover" : ", and it is waiting for you to hand it over"}.`
              : `${rupees(chain.cart.final_price.value)} was agreed but never paid.`,
          data: { transaction_id: txn, paid, delivered: Boolean(chain.fulfillment), amount: chain.cart?.final_price.value ?? 0 },
        };
      }

      case "get_reconciliation": {
        const r = await fetchLocal(`/merchants/${merchantId}/reconciliation`);
        const rows = (r.rows ?? []) as Array<{ kind: string; because: string; amount_banked?: number }>;
        const odd = rows.filter((x) => x.kind !== "matched");
        return {
          summary: rows.length === 0
            ? `No money has come in yet, so there is nothing to match.`
            : `${Math.round((r.explained_share ?? 0) * 100)}% of the ${rupees(r.banked ?? 0)} that reached your account is tied to a specific sale.${odd.length > 0 ? ` ${odd.length} credit(s) do not match anything.` : ""}`,
          data: r,
          card: {
            kind: "stat", title: "Money in, matched to sales",
            value: `${Math.round((r.explained_share ?? 0) * 100)}%`,
            sub: `${rupees(r.explained ?? 0)} of ${rupees(r.banked ?? 0)} explained`,
            rows: odd.slice(0, 4).map((x) => ({ label: x.because.slice(0, 68), value: rupees(x.amount_banked ?? 0) })),
          },
        };
      }

      case "list_products": {
        const items = mine();
        const held = items.filter((i) => i.needs_merchant_confirmation);
        const out = items.filter((i) => !i.needs_merchant_confirmation && i.stock.quantity === 0);
        return {
          summary: `${items.length} product(s).${held.length > 0 ? ` ${held.length} cannot be sold until you confirm a price or a count.` : ""}${out.length > 0 ? ` ${out.length} out of stock.` : ""}`,
          data: items.map((i) => ({
            item_id: i.item_id, name: i.name, price: i.price.value, stock: i.stock.quantity,
            sellable: !i.needs_merchant_confirmation, held_because: gateReasons(i, sanityFor(i)),
          })),
          card: {
            kind: "table", title: "Your catalog",
            columns: ["Product", "Price", "Stock", "Status"],
            rows: items.slice(0, 10).map((i) => [
              i.name, rupees(i.price.value), String(i.stock.quantity),
              i.needs_merchant_confirmation ? "Waiting on you" : i.stock.quantity === 0 ? "Out of stock" : "On sale",
            ]),
          },
        };
      }

      case "get_orders": {
        const r = await fetchLocal(`/merchants/${merchantId}/orders`);
        const rows = (r.orders ?? []) as Array<{ transaction_id: string; item_name: string; amount: number; paid: boolean; delivered: boolean }>;
        const waiting = rows.filter((o) => o.paid && !o.delivered);
        return {
          summary: rows.length === 0 ? `No orders yet.`
            : `${rows.length} order(s).${waiting.length > 0 ? ` ${waiting.length} paid and waiting for you to hand over.` : " All handed over."}`,
          data: rows,
          card: {
            kind: "table", title: "Recent orders",
            columns: ["Item", "Amount", "State"],
            rows: rows.slice(0, 8).map((o) => [o.item_name, rupees(o.amount),
              o.delivered ? "Handed over" : o.paid ? "Waiting on you" : "Not paid"]),
          },
        };
      }

      case "get_opportunities": {
        const r = await fetchLocal(`/merchants/${merchantId}/revenue-agent`);
        const opps = (r.opportunities ?? []) as Array<{ id: string; headline: string; kind: string; incremental_revenue?: number; score: number }>;
        return {
          summary: opps.length === 0
            ? `No suggestions right now — that needs some buyer activity to work from.`
            : `${opps.length} suggestion(s). The strongest: ${opps[0]!.headline}.`,
          data: opps,
          card: {
            kind: "opportunities", title: "Ways to earn more",
            rows: opps.slice(0, 4).map((o) => ({
              id: o.id, headline: o.headline, kind: o.kind.replace("_", " "),
              worth: o.incremental_revenue ? rupees(o.incremental_revenue) : "", score: o.score,
            })),
          },
        };
      }

      case "get_lost_sales": {
        const r = await fetchLocal(`/merchants/${merchantId}/recovery`);
        const cases = (r.cases ?? []) as Array<{ headline?: string; at_risk?: number }>;
        return {
          summary: cases.length === 0 ? `No buyers walked away recently.`
            : `${cases.length} buyer(s) wanted something and did not buy it.`,
          data: cases,
        };
      }

      case "get_customers": {
        const r = await fetchLocal(`/merchants/${merchantId}/customers`);
        const cs = (r.customers ?? []) as Array<{ name: string; revenue: number; orders: number; contribution: number; daysSinceLast: number }>;
        const t = r.totals ?? {};
        if (cs.length === 0) return { summary: `Nobody has bought from you yet.`, data: [] };
        return {
          summary:
            `${cs[0]!.name} spends the most — ${rupees(cs[0]!.revenue)} over ${cs[0]!.orders} order(s). ` +
            `Your top five are ${Math.round((t.top5_share ?? 0) * 100)}% of everything you take, and ` +
            `${Math.round((t.repeat_share ?? 0) * 100)}% of your ${t.buyers ?? cs.length} buyers have come back more than once.`,
          data: cs,
          card: {
            kind: "table", title: "Your buyers, by what they spent",
            columns: ["Buyer", "Spent", "Orders", "Share", "Last seen"],
            rows: cs.slice(0, 8).map((c) => [
              c.name, rupees(c.revenue), String(c.orders),
              `${Math.round(c.contribution * 100)}%`,
              c.daysSinceLast === 0 ? "today" : `${c.daysSinceLast}d ago`,
            ]),
            footer: "Buyers are AI shopping agents acting for people — demo identities.",
          },
        };
      }

      case "get_lapsed_customers": {
        const quiet = Number(args.quiet_days ?? 30) || 30;
        const r = await fetchLocal(`/merchants/${merchantId}/customers?quiet_days=${quiet}`);
        const gone = (r.lapsed ?? []) as Array<{ name: string; revenue: number; orders: number; daysSinceLast: number }>;
        if (gone.length === 0) {
          return { summary: `Nobody who used to buy regularly has gone quiet — everyone is still coming.`, data: [] };
        }
        const worth = gone.reduce((sum, c) => sum + c.revenue, 0);
        return {
          summary:
            `${gone.length} buyer(s) who used to come regularly have not bought in ${quiet}+ days. ` +
            `Between them they had spent ${rupees(worth)}. The biggest is ${gone[0]!.name}, quiet for ${gone[0]!.daysSinceLast} days.`,
          data: gone,
          card: {
            kind: "table", title: `Stopped coming — ${rupees(worth)} of past trade`,
            columns: ["Buyer", "Used to spend", "Orders", "Quiet for"],
            rows: gone.slice(0, 8).map((c) => [c.name, rupees(c.revenue), String(c.orders), `${c.daysSinceLast} days`]),
            footer: "These are the ones worth winning back — they bought more than once before stopping.",
          },
        };
      }

      case "get_patterns": {
        const r = await fetchLocal(`/merchants/${merchantId}/patterns`);
        const hours = (r.by_hour ?? []) as Array<{ hour: number; revenue: number }>;
        const days = (r.by_weekday ?? []) as Array<{ day: string; revenue: number }>;
        const traded = hours.filter((h) => h.revenue > 0);
        if (traded.length === 0) return { summary: `Not enough sales yet to see a pattern.`, data: null };
        const hh = (n: number) => `${((n + 11) % 12) + 1}${n < 12 ? "am" : "pm"}`;
        const best = r.busiest_hour as number;
        return {
          summary: `Your busiest hour is around ${hh(best)}, and your strongest day is ${r.busiest_day}.`,
          data: r,
          card: {
            kind: "table", title: "When you actually trade",
            columns: ["Day", "Taken"],
            rows: days.map((d) => [d.day, rupees(d.revenue)]),
            footer: `Busiest hour: ${hh(best)}.`,
          },
        };
      }

      case "get_payment_setup": {
        return {
          summary: shop
            ? `Customers pay you on ${shop.upi_vpa}. ${shop.qr_note ?? ""}`.trim()
            : `I could not find your shop's payment details.`,
          data: { upi_vpa: shop?.upi_vpa ?? null, name: shop?.name ?? null },
          card: {
            kind: "stat", title: "How customers pay you",
            value: shop?.upi_vpa ?? "not set",
            sub: shop?.name ?? "",
            rows: [{ label: "Change it", value: "upload your QR" }],
          },
        };
      }

      /* ── the ones that need a press ─────────────────────────────────────── */

      case "propose_confirm_handover": {
        const txn = String(args.transaction_id ?? "");
        const chain = store.loadChain(txn);
        if (!chain?.payment) return { summary: `Order ${txn} has not been paid for, so there is nothing to hand over.`, data: null, error: "not paid" };
        if (chain.fulfillment) return { summary: `You already confirmed that one.`, data: null };
        const item = catalogItems.find((i) => i.item_id === chain.cart?.item_id);
        return {
          summary: `Ready to mark ${item?.name ?? "that order"} as handed over.`,
          data: null,
          action: proposeAction({
            merchant_id: merchantId, conversation_id: conversationId, tool: name,
            args: { transaction_id: txn }, confirm: true,
            summary: `Mark ${item?.name ?? txn} (${rupees(chain.cart?.final_price.value ?? 0)}) as handed to the buyer`,
          }),
        };
      }

      case "propose_bulk_handover": {
        const r = await fetchLocal(`/merchants/${merchantId}/orders`);
        const waiting = ((r.orders ?? []) as Array<{ transaction_id: string; item_name: string; amount: number; paid: boolean; delivered: boolean }>)
          .filter((o) => o.paid && !o.delivered);
        if (waiting.length === 0) {
          return { summary: `Nothing is waiting — everything paid for has been handed over.`, data: [] };
        }
        const worth = waiting.reduce((sum, o) => sum + o.amount, 0);
        return {
          summary:
            `${waiting.length} paid order(s) worth ${rupees(worth)} are waiting. ` +
            `Confirming marks every one of them as handed to its buyer — each gets its own signed record.`,
          data: waiting,
          card: {
            kind: "table", title: `Waiting to go out — ${rupees(worth)}`,
            columns: ["Item", "Amount"],
            rows: waiting.slice(0, 6).map((o) => [o.item_name, rupees(o.amount)]),
            footer: waiting.length > 6 ? `…and ${waiting.length - 6} more.` : "",
          },
          action: proposeAction({
            merchant_id: merchantId, conversation_id: conversationId,
            tool: name, args: {}, confirm: true,
            summary: `Mark all ${waiting.length} paid order(s) — ${rupees(worth)} — as handed to their buyers`,
          }),
        };
      }

      case "propose_set_price": {
        const itemId = String(args.item_id ?? "");
        const item = catalogItems.find((i) => i.item_id === itemId && i.merchant_id === merchantId);
        if (!item) return { summary: `I could not find that product.`, data: null, error: "no such product" };
        const price = Number(args.price ?? 0);
        const stock = Number(args.stock ?? -1);
        const bits = [price > 0 ? `price ${rupees(price)}` : "", stock >= 0 ? `${stock} in stock` : ""].filter(Boolean);
        if (bits.length === 0) return { summary: `Tell me the price or the stock count you want.`, data: null, error: "nothing to set" };
        return {
          summary: `Ready to set ${item.name} to ${bits.join(" and ")}.`,
          data: null,
          action: proposeAction({
            merchant_id: merchantId, conversation_id: conversationId, tool: name,
            args: { item_id: itemId, price, stock }, confirm: true,
            summary: `Set ${item.name} — ${bits.join(", ")}`,
          }),
        };
      }

      case "propose_invoice": {
        const txn = String(args.transaction_id ?? "");
        const chain = store.loadChain(txn);
        if (!chain?.payment) return { summary: `An invoice needs a paid order, and that one has not been paid.`, data: null, error: "not paid" };
        return {
          summary: `Ready to raise a Razorpay invoice for ${rupees(chain.cart?.final_price.value ?? 0)}.`,
          data: null,
          action: proposeAction({
            merchant_id: merchantId, conversation_id: conversationId, tool: name,
            args: { transaction_id: txn }, confirm: true,
            summary: `Raise a Razorpay invoice for ${rupees(chain.cart?.final_price.value ?? 0)}`,
          }),
        };
      }

      case "propose_payment_link": {
        const txn = String(args.transaction_id ?? "");
        const chain = store.loadChain(txn);
        if (!chain?.cart) return { summary: `I could not find that order.`, data: null, error: "no such order" };
        if (chain.payment) return { summary: `That one is already paid — no link needed.`, data: null };
        return {
          summary: `Ready to create a payment link for ${rupees(chain.cart.final_price.value)}.`,
          data: null,
          action: proposeAction({
            merchant_id: merchantId, conversation_id: conversationId, tool: name,
            args: { transaction_id: txn }, confirm: true,
            summary: `Create a Razorpay payment link for ${rupees(chain.cart.final_price.value)}`,
          }),
        };
      }

      case "propose_promotion": {
        const oppId = String(args.opportunity_id ?? "");
        const r = await fetchLocal(`/merchants/${merchantId}/revenue-agent`);
        const opp = ((r.opportunities ?? []) as Array<{ id: string; headline: string }>).find((o) => o.id === oppId);
        if (!opp) return { summary: `I could not find that suggestion.`, data: null, error: "no such opportunity" };
        return {
          summary: `Ready to put that live: ${opp.headline}.`,
          data: null,
          action: proposeAction({
            merchant_id: merchantId, conversation_id: conversationId, tool: name,
            args: { opportunity_id: oppId }, confirm: true, summary: opp.headline,
          }),
        };
      }

      case "propose_upi": {
        const upi = String(args.upi_id ?? "").trim();
        const who = String(args.merchant_name ?? "").trim();
        if (!upi) return { summary: `I did not get a UPI id to save.`, data: null, error: "no upi id" };
        return {
          summary: `Ready to save ${upi} as how customers pay you.`,
          data: { upi_id: upi, merchant_name: who },
          action: proposeAction({
            merchant_id: merchantId, conversation_id: conversationId, tool: name,
            args: { upi_id: upi, merchant_name: who }, confirm: true,
            summary: `Save ${upi}${who ? ` (${who})` : ""} as your payment address`,
          }),
        };
      }

      default:
        return { summary: `I do not have a way to do that yet.`, data: null, error: `unimplemented: ${name}` };
    }
  }

  /** "↑ 12% vs yesterday", or nothing when there is no honest comparison. */
  function deltaOf(now: number, before: number | null, label: string): string {
    if (before === null || before === 0 || !label) return "";
    const pct = Math.round(((now - before) / before) * 100);
    if (pct === 0) return `same as ${label}`;
    return `${pct > 0 ? "↑" : "↓"} ${Math.abs(pct)}% vs ${label}`;
  }

  /**
   * Actually do what the merchant approved.
   *
   * Reached only from the confirm endpoint, and only through the idempotent
   * executor — so this function never runs twice for one press, and never runs
   * because a model decided it should.
   */
  async function performAction(a: merchantActions.MerchantAction): Promise<unknown> {
    switch (a.tool) {
      case "propose_confirm_handover":
        return fetchLocal(`/transactions/${a.args.transaction_id}/confirm-fulfillment`, { method: "POST", body: {} });

      /**
       * Every waiting order, one at a time, through the same endpoint.
       *
       * Not a bulk database write: each handover is a *signed fulfilment
       * mandate* appended to its own chain, and doing forty-eight of them means
       * doing it forty-eight times. The list is re-read here rather than
       * carried on the proposal, so an order handed over by hand between the
       * offer and the press is simply no longer in it.
       *
       * A failure part-way through does not undo what already succeeded — those
       * signatures are real. So the result says exactly how many went through,
       * and the first thing that stopped, rather than reporting a clean total.
       */
      case "propose_bulk_handover": {
        const r = await fetchLocal(`/merchants/${a.merchant_id}/orders`);
        const waiting = ((r.orders ?? []) as Array<{ transaction_id: string; paid: boolean; delivered: boolean }>)
          .filter((o) => o.paid && !o.delivered);

        let done = 0;
        const failed: Array<{ transaction_id: string; why: string }> = [];
        for (const o of waiting) {
          try {
            await fetchLocal(`/transactions/${o.transaction_id}/confirm-fulfillment`, { method: "POST", body: {} });
            done++;
          } catch (err) {
            failed.push({ transaction_id: o.transaction_id, why: describeThrown(err) });
          }
        }
        if (done === 0 && failed.length > 0) {
          throw new Error(`none of the ${failed.length} went through — ${failed[0]!.why}`);
        }
        return {
          handed_over: done,
          attempted: waiting.length,
          ...(failed.length > 0 ? { failed: failed.length, first_problem: failed[0]!.why } : {}),
        };
      }
      case "propose_set_price": {
        const body: Record<string, number> = {};
        if (Number(a.args.price) > 0) body.price = Number(a.args.price);
        if (Number(a.args.stock) >= 0) body.stock = Number(a.args.stock);
        return fetchLocal(`/merchants/${a.merchant_id}/items/${a.args.item_id}`, { method: "PATCH", body });
      }
      case "propose_invoice":
        return fetchLocal(`/transactions/${a.args.transaction_id}/invoice`, { method: "POST", body: {} });
      case "propose_payment_link":
        return fetchLocal(`/transactions/${a.args.transaction_id}/payment-link`, { method: "POST", body: {} });
      case "propose_promotion":
        return fetchLocal(`/merchants/${a.merchant_id}/opportunities/${a.args.opportunity_id}/approve`, { method: "POST", body: {} });
      case "propose_upi": {
        const shop = merchants.get(a.merchant_id);
        if (!shop) throw new Error("no such shop");
        shop.upi_vpa = String(a.args.upi_id);

        /**
         * A seeded shop has no row to update.
         *
         * The six demo shops come from the catalog fixture, not from the
         * onboarding table, so changing one in memory alone would work
         * perfectly until the next restart put the old UPI id back — the same
         * way editing a seeded product used to be silently temporary. Writing
         * the row instead makes the merchant's own word outrank the fixture,
         * which is what `restoreOnboarded` already assumes on the way out.
         */
        const stored = onboarding.getMerchant(a.merchant_id);
        if (stored) {
          onboarding.updateMerchant({ ...stored, upi_vpa: shop.upi_vpa });
        } else {
          onboarding.createMerchant({
            ...shop,
            onboarded: true,
            store_summary: null,
            created_at: new Date().toISOString(),
          });
        }
        return { upi_vpa: shop.upi_vpa };
      }
      default:
        throw new Error(`no way to perform ${a.tool}`);
    }
  }


  /**
   * One turn with the merchant's assistant.
   *
   * The shape of a turn is: decide what this is asking, run the lookups, then
   * say what was found. Only the last step ever involves a language model, and
   * on most questions not even that — "how much did I make today" is answered
   * by a router, a ledger read and a sentence template, in about ten
   * milliseconds and zero tokens. That matters more than it sounds: the token
   * budget here is 8,000 a minute for the whole organisation, and a merchant
   * asking four questions in a row must not be the thing that exhausts it.
   *
   * The activity list is returned rather than streamed. Each entry is a real
   * lookup that really ran, so the merchant watching "Checking unpaid orders"
   * is watching something true rather than a progress animation.
   */
  app.post("/merchants/:id/agent", async (req: Request, res: Response) => {
    const id = String(req.params.id);
    if (!merchants.has(id)) {
      res.status(404).json({ error: `no such merchant: ${id}` });
      return;
    }
    const message = String(req.body?.message ?? "").trim();
    if (!message) {
      res.status(400).json({ error: "say something" });
      return;
    }
    const conversationId = String(req.body?.conversation_id ?? "").trim() || `conv_${randomUUID().slice(0, 8)}`;
    const convo = conversationFor(conversationId, id);
    convo.turns.push({ role: "merchant", text: message, at: new Date().toISOString() });

    const started = Date.now();
    let plan = routeMerchant(message);

    /**
     * A follow-up that only changes the period.
     *
     * "And the week?" carries no verb and no noun — every word that would tell
     * a router what it is about was in the *previous* question. Routed on its
     * own it fell through to the generic path and cheerfully answered with
     * today's takings, which is the specific failure a shopkeeper would never
     * report as a bug: the number looked plausible and was an answer to a
     * question they had not asked.
     *
     * So a short message that names a stretch of time, when the last thing
     * discussed was takings, re-runs that lookup over the new period.
     */
    const namesPeriod = /\b(today|yesterday|this week|last week|the week|past week|7 days|this month|last month|the month|30 days|all time|overall|so far)\b/i.test(message);
    // Periods only apply to money here, so a short question naming one is
    // about takings whatever the previous turn was about.
    if (namesPeriod && message.split(/\s+/).length <= 6) {
      plan = { kind: "direct", tools: ["get_sales"], domains: ["sales"], why: "Adding up what was actually paid" };
    }

    /**
     * A follow-up that points back at the last answer.
     *
     * "Which of those haven't sold?" names no subject at all — "those" is the
     * list from the previous turn, and every word that would tell a router what
     * this is about was in the question before it. Routed alone it landed on
     * the generic path and answered with today's takings: a real number,
     * confidently given, to a question nobody asked. That is the failure a
     * shopkeeper would never report, because it looks like an answer.
     *
     * Only when the message actually refers back, and only when the generic
     * path was about to run — a follow-up that names its own subject can route
     * on its own merits.
     */
    const refersBack = /\b(those|them|they|that one|these|it)\b/i.test(message);
    if (refersBack && convo.focus && plan.kind === "reason" && plan.seed.length === 1 && plan.seed[0] === "get_today") {
      const back = convo.focus.tool;
      plan = { kind: "direct", tools: [back], domains: [], why: activityFor(back) };
    }
    const activity: Array<{ label: string; domain?: string; ok: boolean }> = [];
    const outputs: Array<{ tool: string; summary: string; card?: unknown }> = [];
    const cards: unknown[] = [];
    const actionsOut: unknown[] = [];

    /**
     * A question the shop has no data for.
     *
     * Answered immediately and honestly, then handed the nearest real thing.
     * "I don't understand" would be false — it understood perfectly — and
     * inventing a customer list would be the one failure this project cannot
     * afford.
     */
    if (plan.kind === "unheld") {
      let answer = plan.say;
      for (const t of plan.then) {
        const out = await runMerchantTool(id, conversationId, t, {});
        activity.push({ label: `Checking what I do have`, ok: !out.error });
        outputs.push({ tool: t, summary: out.summary });
        if (out.card) cards.push(out.card);
        answer += ` What I can tell you: ${out.summary}`;
      }
      convo.turns.push({ role: "assistant", text: answer, at: new Date().toISOString() });
      convo.updated_at = new Date().toISOString();
      res.json({
        conversation_id: conversationId, answer, activity, cards, actions: actionsOut,
        answered_by: "rules", steps: outputs, elapsed_ms: Date.now() - started,
      });
      return;
    }

    /**
     * An instruction: work out what they named, then prepare it.
     *
     * Resolution is deterministic and refuses rather than guesses. If a
     * merchant says "invoice that order" and there are four candidates, picking
     * one would be worse than asking — an invoice raised against the wrong sale
     * is not something they can quietly undo.
     */
    if (plan.kind === "act") {
      const resolved = await resolveActionArgs(id, plan.tool, plan.subject, convo);
      if (resolved.problem) {
        const answer = resolved.problem;
        convo.turns.push({ role: "assistant", text: answer, at: new Date().toISOString() });
        res.json({
          conversation_id: conversationId, answer, activity: [{ label: plan.why, ok: false }],
          cards: [], actions: [], answered_by: "rules", steps: [], elapsed_ms: Date.now() - started,
        });
        return;
      }
      const out = await runMerchantTool(id, conversationId, plan.tool, resolved.args);
      const def = merchantToolByName(plan.tool);
      activity.push({ label: activityFor(plan.tool), domain: def ? DOMAIN_LABEL[def.domain] : undefined, ok: !out.error });
      if (out.card) cards.push(out.card);
      if (out.action) actionsOut.push(out.action);
      convo.turns.push({ role: "assistant", text: out.summary, at: new Date().toISOString() });
      convo.updated_at = new Date().toISOString();
      res.json({
        conversation_id: conversationId, answer: out.summary, activity, cards, actions: actionsOut,
        answered_by: "rules", steps: [{ tool: plan.tool, summary: out.summary }],
        elapsed_ms: Date.now() - started,
      });
      return;
    }

    const toRun = plan.kind === "direct" ? plan.tools : plan.seed;

    // Carry the referent forward. "Why was it lower?" means the thing the last
    // answer was about, and a merchant should never have to say it twice.
    const args: Record<string, Record<string, unknown>> = {};
    if (toRun.includes("get_sales")) {
      args.get_sales = { period: periodFrom(message, convo) };
    }

    for (const tool of toRun) {
      const def = merchantToolByName(tool);
      const out = await runMerchantTool(id, conversationId, tool, args[tool] ?? {});
      activity.push({
        label: activityFor(tool),
        domain: def ? DOMAIN_LABEL[def.domain] : undefined,
        ok: !out.error,
      });
      outputs.push({ tool, summary: out.summary });
      if (out.card) cards.push(out.card);
      if (out.action) actionsOut.push(out.action);
      if (!out.error) convo.focus = { tool, label: out.summary, data: out.data };
    }

    /**
     * Say it.
     *
     * A single lookup speaks for itself — the tool already wrote a sentence a
     * shopkeeper can read, and paying a model to rewrite it would add latency,
     * spend budget and introduce a chance of it saying something the rows do
     * not support. Several lookups genuinely need joining up, and that is what
     * the model is for. If it is unavailable, the sentences are joined plainly
     * and the answer says it came from the rules.
     */
    let answer = outputs.map((o) => o.summary).join(" ");
    let answeredBy: "rules" | "model" = "rules";
    let note: string | undefined;

    if (plan.kind === "reason" && outputs.length > 1) {
      const phrased = await phraseMerchantAnswer(message, outputs, convo);
      if (phrased.text) {
        answer = phrased.text;
        answeredBy = "model";
      } else if (phrased.note) {
        note = phrased.note;
      }
    }

    convo.turns.push({ role: "assistant", text: answer, at: new Date().toISOString() });
    convo.updated_at = new Date().toISOString();
    if (convo.turns.length > 24) convo.turns.splice(0, convo.turns.length - 24);

    console.log(`[merchant ${id}] "${message}" → ${plan.kind}, ${outputs.length} lookup(s), ${answeredBy}, ${Date.now() - started}ms`);
    res.json({
      conversation_id: conversationId, answer, activity, cards, actions: actionsOut,
      answered_by: answeredBy, steps: outputs, ...(note ? { note } : {}),
      elapsed_ms: Date.now() - started,
    });
  });

  /**
   * Turn "invoice that order" into an order id, or say why it cannot.
   *
   * Three ways, strongest first: an id typed out in full, the thing the last
   * answer was about, or — when exactly one candidate exists — that one. Two
   * candidates and no way to choose is a question, not a guess: this is the
   * side of the product that changes money.
   */
  async function resolveActionArgs(
    merchantId: string,
    tool: string,
    said: string,
    convo: { focus: { tool: string; data: unknown } | null },
  ): Promise<{ args: Record<string, unknown>; problem?: string }> {
    const typedId = said.match(/\btxn_[a-z0-9]+/i)?.[0];

    if (tool === "propose_confirm_handover" || tool === "propose_invoice" || tool === "propose_payment_link") {
      if (typedId) return { args: { transaction_id: typedId } };

      const orders = (await fetchLocal(`/merchants/${merchantId}/orders`)).orders as Array<{
        transaction_id: string; item_name: string; paid: boolean; delivered: boolean;
      }>;
      // A payment link is for an order that was never paid; a handover and an
      // invoice both need one that was.
      const want = tool === "propose_payment_link"
        ? orders.filter((o) => !o.paid)
        : orders.filter((o) => o.paid && !o.delivered);

      const named = want.filter((o) => said.toLowerCase().includes(o.item_name.toLowerCase()));
      const pool = named.length > 0 ? named : want;

      if (pool.length === 0) {
        return {
          args: {},
          problem:
            tool === "propose_payment_link"
              ? "Every order has been paid for, so there is nothing to send a link for."
              : tool === "propose_invoice"
                ? "There are no paid orders to invoice — an invoice needs money that has already come in."
                : "There are no paid orders waiting to be handed over.",
        };
      }
      if (pool.length === 1) return { args: { transaction_id: pool[0]!.transaction_id } };

      const focusId = (convo.focus?.data as { transaction_id?: string } | undefined)?.transaction_id;
      if (focusId && pool.some((o) => o.transaction_id === focusId)) return { args: { transaction_id: focusId } };

      return {
        args: {},
        problem:
          `There are ${pool.length} of those — tell me which one and I will get it ready. ` +
          pool.slice(0, 4).map((o) => `${o.item_name} (${o.transaction_id.slice(0, 14)})`).join(", ") + ".",
      };
    }

    if (tool === "propose_set_price") {
      const mine = catalogItems.filter((i) => i.merchant_id === merchantId);
      const lower = said.toLowerCase();
      const named = mine.filter((i) => lower.includes(i.name.toLowerCase()));
      if (named.length === 0) {
        return { args: {}, problem: "Which product? Name it as it appears in your catalog and I will get the change ready." };
      }
      if (named.length > 1) {
        return { args: {}, problem: `That matches ${named.length} products — ${named.slice(0, 3).map((i) => i.name).join(", ")}. Which one?` };
      }
      // "to 480", "at ₹480", "480 rupees" — the number that is not part of the
      // product's own name, which is why the name is removed before looking.
      const rest = lower.replace(named[0]!.name.toLowerCase(), " ");
      const price = Number(rest.match(/(?:₹|rs\.?|to|at)\s*([\d,]+)/i)?.[1]?.replace(/,/g, "") ?? 0);
      const stock = Number(rest.match(/([\d,]+)\s*(?:in stock|left|units|pieces|pcs)/i)?.[1]?.replace(/,/g, "") ?? -1);
      if (price <= 0 && stock < 0) {
        return { args: {}, problem: `What should ${named[0]!.name} be? Give me a price or a stock count.` };
      }
      return { args: { item_id: named[0]!.item_id, price, stock } };
    }

    if (tool === "propose_promotion") {
      const ra = await fetchLocal(`/merchants/${merchantId}/revenue-agent`);
      const opps = (ra.opportunities ?? []) as Array<{ id: string; headline: string }>;
      if (opps.length === 0) return { args: {}, problem: "There are no suggestions to act on right now." };
      const typed = opps.find((o) => said.includes(o.id));
      if (typed) return { args: { opportunity_id: typed.id } };
      if (opps.length === 1) return { args: { opportunity_id: opps[0]!.id } };
      return {
        args: {},
        problem: `There are ${opps.length} suggestions — which one? ` + opps.slice(0, 3).map((o) => o.headline).join("; ") + ".",
      };
    }

    return { args: {} };
  }

  /**
   * Which stretch of time the merchant meant.
   *
   * Deterministic on purpose: "yesterday" is not a judgement call, and asking a
   * model to classify it costs a round trip to learn something a regular
   * expression already knows. When the question names nothing, the last period
   * discussed carries forward — which is what makes "and the week before?"
   * work.
   */
  function periodFrom(message: string, convo: { focus: { data: unknown } | null }): string {
    const m = message.toLowerCase();
    if (/\byesterday\b/.test(m)) return "yesterday";
    if (/\b(this |last |past )?(week|7 days|seven days)\b/.test(m)) return "week";
    if (/\b(this |last |past )?(month|30 days|thirty days)\b/.test(m)) return "month";
    if (/\b(all time|ever|total|overall|so far)\b/.test(m)) return "all";
    if (/\btoday\b|\bnow\b/.test(m)) return "today";
    const carried = (convo.focus?.data as { label?: string } | undefined)?.label;
    if (carried === "yesterday") return "yesterday";
    if (carried === "the last 7 days") return "week";
    if (carried === "the last 30 days") return "month";
    return "today";
  }

  /**
   * Join several findings into one answer a shopkeeper would actually say.
   *
   * The model is given only the sentences the tools produced, never the raw
   * rows — it has nothing to quote that a lookup did not already establish, so
   * it cannot invent a figure. If it is rate-limited or unreachable, the caller
   * falls back to the plain join, which is less graceful and equally true.
   */
  async function phraseMerchantAnswer(
    question: string,
    outputs: Array<{ tool: string; summary: string }>,
    convo: { turns: Array<{ role: string; text: string }> },
  ): Promise<{ text?: string; note?: string }> {
    if (activeProvider() !== "groq") return { note: "phrased from the lookups; no model configured" };

    const recent = convo.turns.slice(-4).map((t) => `${t.role}: ${t.text}`).join("\n");
    try {
      const groq = new OpenAI({ apiKey: process.env.GROQ_API_KEY, baseURL: GROQ_BASE_URL });
      const text = await sharedGroqGovernor.run(
        700,
        async () => {
          const r = await groq.chat.completions.create({
            model: GROQ_MODEL,
            temperature: 0.2,
            max_tokens: 180,
            messages: [
              {
                role: "system",
                content:
                  "You are a small Indian shopkeeper's assistant. You are given findings that have already been looked up. " +
                  "Join them into two or three short sentences in plain language: the answer first, then what to do about it. " +
                  "Rupees as ₹1,200. No jargon. Use ONLY the figures in the findings — never add, estimate or round a number " +
                  "that is not there. If the findings do not answer the question, say what you did find and stop.",
              },
              ...(recent ? [{ role: "user" as const, content: `Earlier in this conversation:\n${recent}` }] : []),
              { role: "user", content: `They asked: "${question}"\n\nFindings:\n${outputs.map((o) => `- ${o.summary}`).join("\n")}` },
            ],
          });
          return { data: r.choices[0]?.message?.content ?? "", response: { headers: new Headers() } };
        },
        { maxWaitSeconds: INTERACTIVE_MAX_WAIT_SECONDS },
      );
      return text.trim() ? { text: text.trim() } : { note: "the model returned nothing" };
    } catch (err) {
      const why = describeThrown(err);
      return { note: `phrased from the lookups directly — ${why}` };
    }
  }

  /** Everything waiting on this merchant's approval. */
  app.get("/merchants/:id/actions", (req: Request, res: Response) => {
    res.json({ actions: merchantActions.listFor(String(req.params.id)) });
  });

  /**
   * The press that makes something happen.
   *
   * Idempotent by action id: a merchant on a shop's connection who presses
   * twice because the first response never came back gets the same
   * confirmation, not two invoices.
   */
  app.post("/merchants/:id/actions/:actionId/confirm", async (req: Request, res: Response) => {
    const actionId = String(req.params.actionId);
    const existing = merchantActions.get(actionId);
    if (!existing || existing.merchant_id !== String(req.params.id)) {
      res.status(404).json({ error: `no such action: ${actionId}` });
      return;
    }

    const { action, replayed } = await merchantActions.execute(actionId, performAction);
    if (action.status === "failed") {
      // Never a green tick over a failure. The whole value of this assistant is
      // that its confirmations are true.
      res.status(409).json({
        action, replayed, ok: false,
        message: `That did not go through — ${action.error ?? "the operation failed"}.`,
      });
      return;
    }
    /**
     * Say what actually happened, not what was asked for.
     *
     * A bulk handover of forty-eight orders can partly succeed — each one is
     * its own signed mandate and one of them can be refused. Echoing the
     * proposal's own wording back would report forty-eight when it did forty.
     */
    const r = action.result as { handed_over?: number; attempted?: number; failed?: number } | undefined;
    const partial =
      r?.handed_over !== undefined && r.attempted !== undefined && r.handed_over < r.attempted;

    res.json({
      action, replayed, ok: true,
      message: replayed
        ? `Already done.`
        : partial
          ? `Handed over ${r!.handed_over} of ${r!.attempted}. ${r!.failed} could not be confirmed.`
          : r?.handed_over !== undefined
            ? `Done — ${r.handed_over} order(s) marked as handed over.`
            : `Done — ${action.summary.charAt(0).toLowerCase()}${action.summary.slice(1)}.`,
    });
  });

  app.post("/merchants/:id/actions/:actionId/cancel", (req: Request, res: Response) => {
    const a = merchantActions.cancel(String(req.params.actionId));
    if (!a) {
      res.status(404).json({ error: "no such action" });
      return;
    }
    res.json({ action: a, ok: true, message: "Left it as it was." });
  });

  /**
   * A UPI QR the merchant photographed, read into payment details.
   *
   * The image is decoded in the browser — it already has a JPEG decoder and a
   * canvas, and the bytes never need to leave the shop's phone for this. What
   * arrives here is the decoded string, which is still just text somebody could
   * have pointed a camera at, so it is parsed and checked before it is offered
   * back for confirmation. Nothing is saved by this call.
   */
  app.post("/merchants/:id/upi-qr", (req: Request, res: Response) => {
    const id = String(req.params.id);
    if (!merchants.has(id)) {
      res.status(404).json({ error: `no such merchant: ${id}` });
      return;
    }
    const decoded = String(req.body?.decoded ?? "");
    const read = readUpiUri(decoded);
    if (!read.ok || !read.details) {
      res.status(422).json({ ok: false, problem: read.problem });
      return;
    }

    const conversationId = String(req.body?.conversation_id ?? "") || `conv_${randomUUID().slice(0, 8)}`;
    const action = merchantActions.propose({
      merchant_id: id,
      conversation_id: conversationId,
      tool: "propose_upi",
      args: { upi_id: read.details.upi_id, merchant_name: read.details.merchant_name ?? "" },
      confirm: true,
      summary: `Save ${read.details.upi_id}${read.details.merchant_name ? ` (${read.details.merchant_name})` : ""} as your payment address`,
    });

    res.json({
      ok: true,
      details: read.details,
      warning: fixedAmountWarning(decoded),
      action,
      message: read.details.merchant_name
        ? `I found your payment details — ${read.details.merchant_name}, paying to ${read.details.upi_id}. Is that right?`
        : `I found a UPI id in that code: ${read.details.upi_id}. Is that right?`,
    });
  });

  /** Openers built from what is actually true for this shop right now. */
  app.get("/merchants/:id/agent/openers", async (req: Request, res: Response) => {
    const id = String(req.params.id);
    if (!merchants.has(id)) {
      res.status(404).json({ error: `no such merchant: ${id}` });
      return;
    }
    const [orders, ra] = await Promise.all([
      fetchLocal(`/merchants/${id}/orders`),
      fetchLocal(`/merchants/${id}/revenue-agent`),
    ]);
    const rows = (orders.orders ?? []) as Array<{ paid: boolean; delivered: boolean }>;
    const cust = await fetchLocal(`/merchants/${id}/customers`);
    res.json({
      openers: merchantOpeners({
        pendingPayments: rows.filter((o) => !o.paid).length,
        awaitingHandover: rows.filter((o) => o.paid && !o.delivered).length,
        lapsed: (cust.lapsed ?? []).length,
        heldProducts: catalogItems.filter((i) => i.merchant_id === id && i.needs_merchant_confirmation).length,
        opportunities: (ra.opportunities ?? []).length,
      }),
    });
  });

  /**
   * The merchant asks; the agent looks it up and answers from what it found.
   * Every lookup is returned so the answer can be checked against its sources.
   */
  app.post("/merchants/:id/ask", async (req: Request, res: Response) => {
    const id = String(req.params.id);
    if (!merchants.has(id)) {
      res.status(404).json({ error: `no such merchant: ${id}` });
      return;
    }
    const question = String(req.body?.question ?? "").trim();
    if (!question) {
      res.status(400).json({ error: "ask something" });
      return;
    }

    const started = Date.now();
    const result = await askMerchantAgent(question, (call) => {
      console.log(`[ask ${id}] tool ${call.tool} ${JSON.stringify(call.args)}`);
      return runTool(id, call);
    });
    console.log(`[ask ${id}] "${question}" → ${result.steps.length} lookup(s) in ${Date.now() - started}ms`);
    res.json({ ...result, elapsed_ms: Date.now() - started });
  });

  /**
   * The same buyer request, run twice: against the raw input a merchant sent,
   * and against the catalog the pipeline built from it.
   *
   * The "unstructured" side is not a degraded rendering of the structured one.
   * It searches the merchants' actual voice notes and photo filenames as text,
   * which is genuinely all a machine has before Stage 1 runs — so its failures
   * are the real failures: it cannot filter on price because no price has been
   * parsed, cannot check stock, cannot tell a colour from a shop name, and has
   * nothing to negotiate against. Faking that comparison would be the one place
   * in this project where the demo lied about its own premise.
   */
  app.post("/discover/compare-modes", (req: Request, res: Response) => {
    const want = String(req.body?.want ?? "").trim();
    const maxPrice = Number(req.body?.max_price ?? 0) || undefined;
    if (!want) {
      res.status(400).json({ error: "`want` is required" });
      return;
    }

    const terms = want.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2);

    // ── Unstructured: the merchant's own words, unparsed ────────────────────
    const rawHits = catalogItems
      .map((item) => {
        const photo = structuring.photos[item.item_id]?.filename ?? "";
        const blob = `${item.source.raw_text} ${photo}`.toLowerCase();
        const matched = terms.filter((t) => blob.includes(t));
        return { item, photo, matched, blob: item.source.raw_text };
      })
      .filter((h) => h.matched.length > 0);

    const unstructured = {
      mode: "unstructured",
      what_a_machine_has: "the merchant's transcribed voice note and a photo filename",
      searched: catalogItems.length,
      text_matches: rawHits.length,
      // Everything an agent still cannot do with a text match.
      can_filter_by_price: false,
      can_check_stock: false,
      can_verify_attributes: false,
      can_negotiate: false,
      can_buy: false,
      results: rawHits.slice(0, 6).map((h) => ({
        merchant_id: h.item.merchant_id,
        raw: h.blob,
        photo: h.photo || null,
        matched_words: h.matched,
        missing: [
          "no price a machine can compare",
          "no stock count",
          "no attributes to match against the request",
          "no floor to negotiate within",
        ],
      })),
      verdict:
        rawHits.length === 0
          ? `Nothing even mentions "${want}". An agent has no way in.`
          : `${rawHits.length} voice note(s) mention it, and an agent can do nothing with that: there is no price to compare, no stock to check, and nothing to buy against.`,
    };

    // ── Structured: the catalog Stage 1 produced ───────────────────────────
    const found = discover(catalogItems, { want, ...(maxPrice ? { max_price: maxPrice } : {}) });
    const structured = {
      mode: "structured",
      what_a_machine_has: "name, category, attributes, price, stock, and a merchant-set price floor",
      searched: catalogItems.length,
      offerable: found.matches.length,
      withheld: found.withheld.length,
      can_filter_by_price: true,
      can_check_stock: true,
      can_verify_attributes: true,
      can_negotiate: true,
      can_buy: found.matches.some((m) => policies.has(m.item.item_id)),
      results: found.matches.slice(0, 6).map((m) => ({
        item_id: m.item.item_id,
        merchant_id: m.item.merchant_id,
        name: m.item.name,
        category: m.item.category,
        attributes: m.item.attributes,
        price: m.item.price.value,
        stock: m.item.stock.quantity,
        negotiable_to: policies.get(m.item.item_id)?.floor_price ?? null,
        checks: ["product found", "attributes matched", "price known", "stock known"],
      })),
      // Held items are the honest middle: structured enough to find, not
      // confirmed enough to sell.
      held: found.withheld.map((w) => ({ name: w.item.name, reason: w.reason })),
      // Three outcomes, not two. "Found it, but the merchant never confirmed the
      // stock" is the honest middle case and must not be reported as "no match".
      verdict:
        found.matches.length > 0
          ? `${found.matches.length} product(s) an agent can filter, compare, haggle over and buy.`
          : found.withheld.length > 0
            ? `Found it, and deliberately did not offer it: ${found.withheld[0]?.reason ?? "held pending confirmation"}. The shopkeeper is asked before an agent is allowed to sell it.`
            : `Structured, but nothing matches "${want}".`,
    };

    res.json({ want, max_price: maxPrice ?? null, unstructured, structured });
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
      res.status(500).json({ error: describeThrown(err) });
    }
  });

  /**
   * "Why can I trust this purchase?" — the same check that gates the money,
   * rendered for a person. Not a display of green ticks: this calls into the
   * gate itself, so a tick here means the payment would actually be allowed.
   */
  app.get("/transactions/:id/authorization", (req: Request, res: Response) => {
    const id = String(req.params.id);
    const chain = store.loadChain(id);
    if (!chain) {
      res.status(404).json({ error: `no such transaction: ${id}` });
      return;
    }
    const item = catalogItems.find((i) => i.item_id === chain.cart?.item_id);
    if (!item) {
      res.status(409).json({ error: `catalog no longer has ${chain.cart?.item_id}` });
      return;
    }
    const result = authorizationFor(chain, item, merchants.get(item.merchant_id));
    if (!result) {
      res.status(409).json({ error: "this transaction has no intent or cart yet" });
      return;
    }
    res.json({
      transaction_id: id,
      asked_for: chain.intent?.prompt_playback ?? null,
      constraints: chain.intent?.constraints ?? null,
      agreed: chain.cart ? { item_id: chain.cart.item_id, price: chain.cart.final_price.value, merchant_id: chain.cart.merchant_id } : null,
      ...result,
    });
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

  return {
    app, store, keyring, catalog: catalogItems, gateway, structuring, notifier, bus,
    setPort: (p: number) => { localPort = p; },
  };
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
    .then(({ app, gateway, bus, notifier, setPort }) => {
      setPort(port);
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
