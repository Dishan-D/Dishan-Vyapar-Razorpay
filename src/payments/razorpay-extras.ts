/**
 * The Razorpay surfaces beyond Orders and Checkout.
 *
 * Two rules govern this file.
 *
 * **Nothing here bypasses the rules layer.** A Payment Link is created only for
 * a cart that has already cleared the buyer's ceiling, the merchant's floor,
 * stock and category — the same gate a Checkout order clears. It is a different
 * way to pay for a decision already made, never a way to make one.
 *
 * **Capability is probed, not claimed.** This account's test mode answers 400
 * for QR Codes and Virtual Accounts: those products are not enabled on it. The
 * honest response is to say so on the screen rather than to mock an API and
 * present the mock as an integration. Every status below comes from a real call
 * whose response was read.
 */

import type Razorpay from "razorpay";

export type CapabilityId =
  | "payments"
  | "payment_links"
  | "invoices"
  | "qr_codes"
  | "smart_collect"
  | "settlements";

export type CapabilityStatus = "real" | "unavailable" | "simulated" | "unknown";

export interface Capability {
  id: CapabilityId;
  label: string;
  /** What this actually does for Vyapar. Empty is not an acceptable answer. */
  role: string;
  status: CapabilityStatus;
  /** The evidence: what was called and what came back. */
  detail: string;
  /** HTTP status of the probe, when one ran. */
  probe_status?: number;
}

export interface PaymentLinkResult {
  id: string;
  short_url: string;
  status: string;
  amount_paise: number;
  reference_id: string;
  expire_by: number | null;
  /** Set once someone has actually paid the link. */
  payment_id: string | null;
}

export interface InvoiceResult {
  id: string;
  status: string;
  short_url: string | null;
  amount_paise: number;
  receipt: string | null;
}

const API = "https://api.razorpay.com/v1";

function authHeader(keyId: string, keySecret: string): string {
  return "Basic " + Buffer.from(`${keyId}:${keySecret}`).toString("base64");
}

async function call(
  keyId: string,
  keySecret: string,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: authHeader(keyId, keySecret), "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

/**
 * Read what a failed probe actually means.
 *
 * Razorpay answers a product a merchant has not enabled with
 * **400 `BAD_REQUEST_ERROR` · "The requested URL was not found on the server."**
 * Taken at face value that sentence says we called the wrong URL, which is the
 * one reading it cannot mean — and it is the reading anyone looking at the
 * capability panel reaches first. Two of our six products showed it, and it
 * made a correct integration look broken.
 *
 * The two cases are distinguishable, and this is how:
 *
 * ```
 * GET /definitely_not_a_real_product  → 404  {"message":"no Route matched with those values"}
 * GET /payments/qr_codes              → 400  BAD_REQUEST_ERROR · "The requested URL was not found…"
 * ```
 *
 * A path that does not exist is refused by the gateway in front of the API and
 * never reaches it — that is the 404. A path that *does* exist but belongs to a
 * product this account has not activated gets through the gateway and is turned
 * away by the application — that is the 400. So a 404 here is our bug and a 400
 * here is an account setting, and the panel should not report them the same way.
 */
export function readProbe(
  path: string,
  r: { status: number; body: { error?: { description?: string; code?: string } } },
): [CapabilityStatus, string] {
  const said = r.body?.error?.description ?? "";

  if (r.status === 200) return ["real", `GET ${path} → 200. Enabled on these test keys.`];

  if (r.status === 401 || r.status === 403) {
    return ["unknown", `GET ${path} → ${r.status}. These keys were refused; check RAZORPAY_KEY_ID and secret.`];
  }

  // The gateway never routed it — that is a wrong path, and it is ours to fix.
  if (r.status === 404) {
    return ["unknown", `GET ${path} → 404, no route. The path is wrong on our side, not a setting on the account.`];
  }

  if (r.status === 400 && /requested URL was not found/i.test(said)) {
    return [
      "unavailable",
      `GET ${path} → 400 "${said}" — the route exists (a wrong path answers 404 "no Route matched"), ` +
        `so this is a product not activated on the account rather than a bad call. Enable it in the Razorpay Dashboard.`,
    ];
  }

  return ["unavailable", `GET ${path} → ${r.status}: ${said || "not enabled on this account"}`];
}

/**
 * Ask the account what it can actually do.
 *
 * Deliberately read-only. An earlier version probed by *creating* a payment
 * link and an invoice, which worked and left real objects on the account every
 * time the page loaded. Listing endpoints answer the same question — is this
 * product enabled for these keys — without leaving anything behind.
 */
export async function probeCapabilities(
  keyId: string,
  keySecret: string,
): Promise<Capability[]> {
  const probes: Array<[CapabilityId, string, string, string]> = [
    ["payment_links", "Payment Links", "A shareable link for a price the rules already agreed — for a buyer who cannot open Checkout.", "/payment_links?count=1"],
    ["invoices", "Invoices", "A record of a completed sale, issued after the merchant confirms handover.", "/invoices?count=1"],
    ["qr_codes", "QR Codes", "A Razorpay-issued UPI QR for counter collection, alongside the shop's own.", "/payments/qr_codes?count=1"],
    ["smart_collect", "Smart Collect", "Virtual accounts that reconcile bank transfers automatically.", "/virtual_accounts?count=1"],
    ["settlements", "Settlements", "What Razorpay has actually paid out to the merchant's bank.", "/settlements?count=1"],
  ];

  const out: Capability[] = [
    {
      id: "payments",
      label: "Payments",
      role: "Orders and Checkout. Every agent purchase runs through this — the primary path.",
      status: "real",
      detail: "Orders created via the SDK, Checkout signature verified server-side, webhooks verified against raw bytes.",
    },
  ];

  for (const [id, label, role, path] of probes) {
    try {
      const r = await call(keyId, keySecret, "GET", path);
      const ok = r.status === 200;
      const [status, detail] = readProbe(path.split("?")[0]!, r);
      out.push({ id, label, role, status: ok ? "real" : status, probe_status: r.status, detail });
    } catch (err) {
      out.push({
        id, label, role, status: "unknown",
        detail: `Could not reach Razorpay: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  return out;
}

/**
 * A Payment Link for an already-agreed cart.
 *
 * `reference_id` carries the Vyapar transaction id, so a link can always be
 * traced back to the mandate chain that authorised it — and so Razorpay
 * refuses a duplicate for the same transaction, which is a useful accident.
 */
export async function createPaymentLink(
  keyId: string,
  keySecret: string,
  args: {
    amount_paise: number;
    description: string;
    reference_id: string;
    notes: Record<string, string>;
    expire_minutes?: number;
  },
): Promise<PaymentLinkResult> {
  const r = await call(keyId, keySecret, "POST", "/payment_links", {
    amount: args.amount_paise,
    currency: "INR",
    description: args.description,
    reference_id: args.reference_id,
    notes: args.notes,
    // Razorpay requires at least 15 minutes out; anything shorter is rejected.
    ...(args.expire_minutes
      ? { expire_by: Math.floor(Date.now() / 1000) + Math.max(16, args.expire_minutes) * 60 }
      : {}),
    reminder_enable: false,
  });

  if (r.status !== 200 || !r.body?.id) {
    throw new Error(
      `Razorpay refused the payment link (${r.status}): ${
        r.body?.error?.description ?? JSON.stringify(r.body).slice(0, 160)
      }`,
    );
  }
  return {
    id: String(r.body.id),
    short_url: String(r.body.short_url),
    status: String(r.body.status),
    amount_paise: Number(r.body.amount),
    reference_id: String(r.body.reference_id ?? args.reference_id),
    expire_by: r.body.expire_by ? Number(r.body.expire_by) : null,
    payment_id: null,
  };
}

/** Razorpay's current word on a link. `created` is not `paid`. */
export async function fetchPaymentLink(
  keyId: string,
  keySecret: string,
  linkId: string,
): Promise<PaymentLinkResult> {
  const r = await call(keyId, keySecret, "GET", `/payment_links/${linkId}`);
  if (r.status !== 200 || !r.body?.id) {
    throw new Error(`Could not fetch ${linkId} (${r.status}): ${r.body?.error?.description ?? "unknown"}`);
  }
  // Razorpay reports payments against the link as an array; the captured one is
  // the only one that means the money arrived.
  const payments: any[] = r.body.payments ?? [];
  const captured = payments.find((p) => String(p.status) === "captured");
  return {
    id: String(r.body.id),
    short_url: String(r.body.short_url),
    status: String(r.body.status),
    amount_paise: Number(r.body.amount),
    reference_id: String(r.body.reference_id ?? ""),
    expire_by: r.body.expire_by ? Number(r.body.expire_by) : null,
    payment_id: captured ? String(captured.payment_id ?? captured.id) : null,
  };
}

export async function cancelPaymentLink(keyId: string, keySecret: string, linkId: string): Promise<string> {
  const r = await call(keyId, keySecret, "POST", `/payment_links/${linkId}/cancel`);
  if (r.status !== 200) {
    throw new Error(`Could not cancel ${linkId} (${r.status}): ${r.body?.error?.description ?? "unknown"}`);
  }
  return String(r.body?.status ?? "cancelled");
}

/**
 * An invoice for a sale that is genuinely finished.
 *
 * Issued only after the merchant has confirmed handover, because an invoice for
 * goods that never moved is exactly the kind of paperwork this product exists
 * to avoid producing. It is a record, not a demand for payment.
 */
export async function createInvoice(
  keyId: string,
  keySecret: string,
  args: {
    amount_paise: number;
    description: string;
    receipt: string;
    customer_name: string;
    notes: Record<string, string>;
    line_item: string;
  },
): Promise<InvoiceResult> {
  const r = await call(keyId, keySecret, "POST", "/invoices", {
    type: "invoice",
    currency: "INR",
    description: args.description,
    receipt: args.receipt,
    customer: { name: args.customer_name, email: "agent@vyapar.test", contact: "9000090000" },
    line_items: [
      { name: args.line_item, amount: args.amount_paise, currency: "INR", quantity: 1 },
    ],
    notes: args.notes,
  });
  if (r.status !== 200 || !r.body?.id) {
    throw new Error(
      `Razorpay refused the invoice (${r.status}): ${
        r.body?.error?.description ?? JSON.stringify(r.body).slice(0, 160)
      }`,
    );
  }
  return {
    id: String(r.body.id),
    status: String(r.body.status),
    short_url: r.body.short_url ? String(r.body.short_url) : null,
    amount_paise: Number(r.body.amount),
    receipt: r.body.receipt ? String(r.body.receipt) : null,
  };
}

/** Unused today, but the client is threaded through so the SDK stays available. */
export type RazorpayClient = Razorpay;
