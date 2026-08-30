import { hashObject } from "./canonical.js";
import type { Keyring } from "./keys.js";
import { mandateHash, signMandate, verifyMandate, type SignatureCheck } from "./sign.js";
import {
  CHAIN_LINK,
  CHAIN_ORDER,
  type CartMandate,
  type FulfillmentMandate,
  type IntentMandate,
  type Mandate,
  type MandateType,
  type PaymentMandate,
  type Sha256Ref,
} from "./schema.js";

/**
 * A transaction's evidence chain. Later stages are absent until they happen —
 * an absent fulfillment mandate is a legitimate state, not a broken chain
 * (PROJECT_CONTEXT.md §3 Stage 6: never auto-mark as fulfilled).
 */
export interface MandateChain {
  transaction_id: string;
  intent?: IntentMandate;
  cart?: CartMandate;
  payment?: PaymentMandate;
  fulfillment?: FulfillmentMandate;
}

export type TransactionStatus =
  | "empty"
  | "intent_declared"
  | "cart_agreed"
  | "payment_confirmed_awaiting_fulfillment"
  | "fulfilled";

const STATUS_BY_DEPTH: TransactionStatus[] = [
  "empty",
  "intent_declared",
  "cart_agreed",
  "payment_confirmed_awaiting_fulfillment",
  "fulfilled",
];

export function chainStatus(chain: MandateChain): TransactionStatus {
  let depth = 0;
  for (const type of CHAIN_ORDER) {
    if (!chain[type]) break;
    depth++;
  }
  return STATUS_BY_DEPTH[depth]!;
}

// ── Builders ─────────────────────────────────────────────────────────────────

const now = (): string => new Date().toISOString();

export async function buildIntentMandate(
  input: Omit<IntentMandate, "mandate_type" | "issued_at" | "buyer_agent_signature"> &
    Partial<Pick<IntentMandate, "issued_at">>,
  keyring: Keyring,
): Promise<IntentMandate> {
  return signMandate<IntentMandate>(
    { mandate_type: "intent", issued_at: input.issued_at ?? now(), ...input },
    keyring,
  );
}

export async function buildCartMandate(
  intent: IntentMandate,
  input: Omit<CartMandate, "mandate_type" | "intent_mandate_hash" | "issued_at" | "merchant_signature" | "buyer_agent_signature"> &
    Partial<Pick<CartMandate, "issued_at">>,
  keyring: Keyring,
): Promise<CartMandate> {
  return signMandate<CartMandate>(
    {
      mandate_type: "cart",
      intent_mandate_hash: mandateHash(intent),
      issued_at: input.issued_at ?? now(),
      ...input,
    },
    keyring,
  );
}

export async function buildPaymentMandate(
  cart: CartMandate,
  input: Omit<PaymentMandate, "mandate_type" | "cart_mandate_hash" | "issued_at" | "platform_signature"> &
    Partial<Pick<PaymentMandate, "issued_at">>,
  keyring: Keyring,
): Promise<PaymentMandate> {
  return signMandate<PaymentMandate>(
    {
      mandate_type: "payment",
      cart_mandate_hash: mandateHash(cart),
      issued_at: input.issued_at ?? now(),
      ...input,
    },
    keyring,
  );
}

export async function buildFulfillmentMandate(
  payment: PaymentMandate,
  input: Omit<FulfillmentMandate, "mandate_type" | "payment_mandate_hash" | "confirmed_at" | "merchant_signature"> &
    Partial<Pick<FulfillmentMandate, "confirmed_at">>,
  keyring: Keyring,
): Promise<FulfillmentMandate> {
  return signMandate<FulfillmentMandate>(
    {
      mandate_type: "fulfillment",
      payment_mandate_hash: mandateHash(payment),
      confirmed_at: input.confirmed_at ?? now(),
      ...input,
    },
    keyring,
  );
}

// ── Verification ─────────────────────────────────────────────────────────────

export interface LinkCheck {
  from: MandateType;
  to: MandateType;
  ok: boolean;
  expected?: Sha256Ref;
  found?: Sha256Ref;
  reason?: string;
}

export interface MandateReport {
  type: MandateType;
  present: boolean;
  hash?: Sha256Ref;
  signatures: SignatureCheck[];
  link?: LinkCheck;
}

export interface ChainReport {
  transaction_id: string;
  status: TransactionStatus;
  ok: boolean;
  mandates: MandateReport[];
  failures: string[];
}

/**
 * Verify every signature and every hash link in a chain.
 *
 * A chain is `ok` when the mandates that *are* present form an unbroken prefix
 * of intent → cart → payment → fulfillment, each one's signatures verify, and
 * each one's back-reference matches the hash of the mandate it claims to follow.
 * Missing later stages are fine; a gap in the middle is not.
 */
export async function verifyChain(chain: MandateChain, keyring: Keyring): Promise<ChainReport> {
  const reports: MandateReport[] = [];
  const failures: string[] = [];
  let seenGap = false;

  for (const type of CHAIN_ORDER) {
    const mandate = chain[type] as Mandate | undefined;

    if (!mandate) {
      seenGap = true;
      reports.push({ type, present: false, signatures: [] });
      continue;
    }

    if (seenGap) {
      failures.push(`${type} mandate is present but an earlier mandate in the chain is missing`);
    }

    const signatures = await verifyMandate(mandate, keyring);
    for (const s of signatures) {
      if (!s.ok) failures.push(`${type}.${s.field}: ${s.reason ?? "invalid signature"}`);
    }

    const report: MandateReport = {
      type,
      present: true,
      hash: mandateHash(mandate),
      signatures,
    };

    const link = CHAIN_LINK[type];
    if (link) {
      const prev = chain[link.prev] as Mandate | undefined;
      const found = (mandate as unknown as Record<string, unknown>)[link.field] as Sha256Ref | undefined;

      if (!prev) {
        report.link = { from: type, to: link.prev, ok: false, found, reason: `${link.prev} mandate is missing` };
        failures.push(`${type} → ${link.prev}: ${link.prev} mandate is missing`);
      } else {
        const expected = mandateHash(prev);
        const ok = found === expected;
        report.link = { from: type, to: link.prev, ok, expected, found };
        if (!ok) {
          failures.push(
            `${type}.${link.field} does not match the ${link.prev} mandate's hash — the chain has been re-pointed or the ${link.prev} mandate was altered`,
          );
        }
      }
    }

    reports.push(report);
  }

  return {
    transaction_id: chain.transaction_id,
    status: chainStatus(chain),
    ok: failures.length === 0,
    mandates: reports,
    failures,
  };
}

/** Stable fingerprint of a whole chain — handy as a single value to show in the audit view. */
export function chainFingerprint(chain: MandateChain): Sha256Ref {
  return hashObject(
    CHAIN_ORDER.map((t) => (chain[t] ? mandateHash(chain[t] as Mandate) : null)),
  );
}
