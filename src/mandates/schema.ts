/**
 * Mandate + catalog schemas — the contract between pipeline stages.
 * Shapes follow PROJECT_CONTEXT.md §4 exactly; see NOTES at the bottom for the
 * two places this file adds a field the spec implied but did not list.
 */

export type Currency = "INR";
export type IsoTimestamp = string;
/** `sha256:<64 hex chars>` */
export type Sha256Ref = string;
/** A JWS compact token: `<b64u header>.<b64u payload>.<b64u signature>` */
export type CompactJws = string;

/** Which of the three roles a key belongs to. */
export type Role = "buyer_agent" | "merchant" | "platform";

// ── §4.1 Catalog Item ────────────────────────────────────────────────────────

export interface ConfidenceValue<T> {
  value: T;
  confidence: number;
}

export interface CatalogItem {
  item_id: string;
  merchant_id: string;
  name: string;
  category: string;
  attributes: Record<string, string>;
  price: { value: number; currency: Currency; confidence: number };
  stock: { quantity: number; confidence: number };
  source: { type: "photo" | "voice_note" | "payment_page"; raw_text: string };
  needs_merchant_confirmation: boolean;
  extracted_at: IsoTimestamp;
}

// ── §4.2 Negotiation Policy ──────────────────────────────────────────────────

export interface NegotiationPolicy {
  item_id: string;
  list_price: number;
  floor_price: number;
  max_rounds: number;
  set_by: "merchant";
  set_at: IsoTimestamp;
}

// ── §4.3–4.6 Mandates ────────────────────────────────────────────────────────

export type MandateType = "intent" | "cart" | "payment" | "fulfillment";

/**
 * What the shopper allowed their agent to do.
 *
 * Everything here is a limit, never an instruction: the agent may act inside
 * this envelope and nowhere else. Attributes and delivery joined price and
 * category because "under ₹1,100" is not the whole of what someone means when
 * they say "a blue cotton saree, delivered tomorrow" — and an authorization
 * that only checks the number would happily buy a red one.
 */
export interface IntentConstraints {
  max_price: number;
  category: string;
  ttl_seconds: number;
  /** Attribute values the item must match, e.g. { color: "blue", material: "cotton" }. */
  attributes?: Record<string, string>;
  /** Latest acceptable handover, in days from now. 0 = today, 1 = tomorrow. */
  deliver_within_days?: number;
}

export interface IntentMandate {
  mandate_type: "intent";
  issuer: string;
  buyer_agent_id: string;
  constraints: IntentConstraints;
  prompt_playback: string;
  issued_at: IsoTimestamp;
  buyer_agent_signature?: CompactJws;
}

export interface CartMandate {
  mandate_type: "cart";
  intent_mandate_hash: Sha256Ref;
  item_id: string;
  final_price: { value: number; currency: Currency };
  merchant_id: string;
  issued_at: IsoTimestamp;
  merchant_signature?: CompactJws;
  buyer_agent_signature?: CompactJws;
}

export interface PaymentMandate {
  mandate_type: "payment";
  cart_mandate_hash: Sha256Ref;
  razorpay_order_id: string;
  razorpay_payment_id: string;
  amount: number;
  currency: Currency;
  status: "captured" | "failed" | "created";
  issued_at: IsoTimestamp;
  platform_signature?: CompactJws;
}

export interface FulfillmentMandate {
  mandate_type: "fulfillment";
  payment_mandate_hash: Sha256Ref;
  confirmed_by: "merchant";
  evidence_note: string | null;
  evidence_photo_ref: string | null;
  confirmed_at: IsoTimestamp;
  merchant_signature?: CompactJws;
}

export type Mandate = IntentMandate | CartMandate | PaymentMandate | FulfillmentMandate;

/**
 * Which signature fields each mandate type carries, in the order they are applied.
 * Order matters: each signature covers the payload *including* every signature
 * applied before it, so a later signer is bound to what the earlier one signed.
 */
export const SIGNATURE_ORDER = {
  intent: [{ field: "buyer_agent_signature", role: "buyer_agent" }],
  cart: [
    { field: "merchant_signature", role: "merchant" },
    { field: "buyer_agent_signature", role: "buyer_agent" },
  ],
  payment: [{ field: "platform_signature", role: "platform" }],
  fulfillment: [{ field: "merchant_signature", role: "merchant" }],
} as const satisfies Record<MandateType, ReadonlyArray<{ field: string; role: Role }>>;

/** Every signature field name across all mandate types. */
export const ALL_SIGNATURE_FIELDS = [
  "buyer_agent_signature",
  "merchant_signature",
  "platform_signature",
] as const;

/** Which mandate each type hash-links back to, and via which field. */
export const CHAIN_LINK: Record<MandateType, { prev: MandateType; field: string } | null> = {
  intent: null,
  cart: { prev: "intent", field: "intent_mandate_hash" },
  payment: { prev: "cart", field: "cart_mandate_hash" },
  fulfillment: { prev: "payment", field: "payment_mandate_hash" },
};

/** The canonical order of a complete chain. */
export const CHAIN_ORDER: readonly MandateType[] = ["intent", "cart", "payment", "fulfillment"];

/* NOTES — two additions to the spec's literal JSON, both deliberate:
 *
 * 1. IntentMandate gains `buyer_agent_signature`. §3 Stage 4 says the Intent
 *    Mandate is "signed by the buyer-agent's key" but §4.3 shows the pre-signing
 *    payload, so the field had to be named somewhere.
 *
 * 2. SCOPE DECISION — the cart is single-item, per §9's recommendation. A cart
 *    mandate binds exactly one `item_id` at one `final_price`. Multi-item would
 *    mean a line-items array, a subtotal the negotiation stage has to allocate
 *    across items, and re-cutting §4.4 — so it is locked closed now rather than
 *    left ambiguous, because changing it after Milestone D means re-signing
 *    every mandate shape downstream of it.
 *
 * 3. PaymentMandate gains `platform_signature` rather than reusing
 *    `merchant_signature`. §3 Stage 5 says "sign a Payment Mandate" without
 *    naming a signer. The merchant is not the party that observed the Razorpay
 *    capture — this service is — so attributing that assertion to the merchant's
 *    key would put a claim in the merchant's name they never made. Third key,
 *    honestly labelled.
 */
