import {
  chainFingerprint,
  chainStatus,
  verifyChain,
  type ChainReport,
  type MandateChain,
  type TransactionStatus,
} from "../mandates/chain.js";
import type { Keyring } from "../mandates/keys.js";
import { CHAIN_ORDER, type Mandate, type MandateType } from "../mandates/schema.js";
import { mandateHash } from "../mandates/sign.js";

export interface TimelineEntry {
  stage: MandateType;
  present: boolean;
  at?: string;
  headline: string;
  detail: string[];
  hash?: string;
  links_to?: string;
  signatures: Array<{ role: string; verified: boolean; reason?: string }>;
  verified: boolean;
}

export interface AuditBundle {
  transaction_id: string;
  status: TransactionStatus;
  verified: boolean;
  failures: string[];
  fingerprint: string;
  /** Public keys a third party needs to check this chain themselves. */
  keyring: Record<string, { kid: string; jwk: unknown }>;
  timeline: TimelineEntry[];
}

function issuedAt(mandate: Mandate): string {
  return mandate.mandate_type === "fulfillment" ? mandate.confirmed_at : mandate.issued_at;
}

function describe(mandate: Mandate): { headline: string; detail: string[] } {
  switch (mandate.mandate_type) {
    case "intent":
      return {
        headline: `Buyer-agent ${mandate.buyer_agent_id} was authorized to spend up to ₹${mandate.constraints.max_price}`,
        detail: [
          `asked for: "${mandate.prompt_playback}"`,
          `limited to ${mandate.constraints.category ? `category ${mandate.constraints.category}` : "any category"}, valid ${mandate.constraints.ttl_seconds}s`,
        ],
      };
    case "cart":
      return {
        headline: `Merchant ${mandate.merchant_id} and the buyer-agent agreed ₹${mandate.final_price.value} for ${mandate.item_id}`,
        detail: ["signed by the merchant first, then countersigned by the buyer-agent"],
      };
    case "payment":
      return {
        headline: `₹${mandate.amount} ${mandate.status} via Razorpay`,
        detail: [`order ${mandate.razorpay_order_id}`, `payment ${mandate.razorpay_payment_id}`],
      };
    case "fulfillment":
      return {
        headline: `Merchant confirmed handover`,
        detail: [
          mandate.evidence_note ? `note: "${mandate.evidence_note}"` : "no note given",
          mandate.evidence_photo_ref ? `photo: ${mandate.evidence_photo_ref}` : "no photo attached",
        ],
      };
  }
}

const PENDING: Record<MandateType, string> = {
  intent: "No intent declared yet",
  cart: "No agreed cart yet",
  payment: "Not paid yet",
  fulfillment: "Awaiting merchant confirmation of handover",
};

/**
 * Stage 7 — the whole transaction as one verified record.
 *
 * Every signature is re-checked and every hash link re-derived at read time
 * rather than trusting a stored "verified" flag. The bundle is meant to be
 * checkable by someone who does not trust this service, so it ships the public
 * keys alongside the chain: a reader with the JWKs can redo all of it.
 */
export async function buildAuditBundle(
  chain: MandateChain,
  keyring: Keyring,
): Promise<AuditBundle> {
  const report: ChainReport = await verifyChain(chain, keyring);
  const byType = new Map(report.mandates.map((m) => [m.type, m]));

  const timeline: TimelineEntry[] = CHAIN_ORDER.map((stage) => {
    const mandate = chain[stage] as Mandate | undefined;
    const m = byType.get(stage);

    if (!mandate || !m?.present) {
      return {
        stage,
        present: false,
        headline: PENDING[stage],
        detail: [],
        signatures: [],
        verified: false,
      };
    }

    const { headline, detail } = describe(mandate);
    const entry: TimelineEntry = {
      stage,
      present: true,
      at: issuedAt(mandate),
      headline,
      detail,
      hash: mandateHash(mandate),
      signatures: m.signatures.map((s) => ({
        role: s.role,
        verified: s.ok,
        ...(s.reason ? { reason: s.reason } : {}),
      })),
      verified: m.signatures.every((s) => s.ok) && (m.link ? m.link.ok : true),
    };
    if (m.link?.found) entry.links_to = m.link.found;
    return entry;
  });

  return {
    transaction_id: chain.transaction_id,
    status: chainStatus(chain),
    verified: report.ok,
    failures: report.failures,
    fingerprint: chainFingerprint(chain),
    keyring: keyring.publicKeyring(),
    timeline,
  };
}
