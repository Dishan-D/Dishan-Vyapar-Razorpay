import { CompactSign, compactVerify } from "jose";
import { canonicalize, hashObject, omit } from "./canonical.js";
import type { Keyring } from "./keys.js";
import {
  ALL_SIGNATURE_FIELDS,
  SIGNATURE_ORDER,
  type CompactJws,
  type Mandate,
  type MandateType,
  type Role,
  type Sha256Ref,
} from "./schema.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * The exact bytes a given signature covers.
 *
 * A mandate is signed in stages (see SIGNATURE_ORDER). The signature at index `i`
 * covers the canonical payload carrying signatures 0..i-1 and *not* i..n — so the
 * merchant signs the bare cart, and the buyer-agent then signs the cart-plus-
 * merchant-signature. That ordering is what makes the two-signature cart a binding
 * between two parties rather than two unrelated assertions about the same object.
 */
export function signingTarget(mandate: Mandate, signatureIndex: number): Record<string, unknown> {
  const order = SIGNATURE_ORDER[mandate.mandate_type] as ReadonlyArray<{ field: string; role: Role }>;
  const step = order[signatureIndex];
  if (!step) {
    throw new Error(`${mandate.mandate_type} mandate has no signature at index ${signatureIndex}`);
  }
  // Drop this signature and every later one; keep earlier ones.
  const laterFields = order.slice(signatureIndex).map((s) => s.field);
  const unrelated = ALL_SIGNATURE_FIELDS.filter((f) => !order.some((s) => s.field === f));
  return omit(mandate as unknown as Record<string, unknown>, [...laterFields, ...unrelated]);
}

/** Apply every signature a mandate type requires, in order, returning a new object. */
export async function signMandate<M extends Mandate>(mandate: M, keyring: Keyring): Promise<M> {
  const order = SIGNATURE_ORDER[mandate.mandate_type] as ReadonlyArray<{ field: string; role: Role }>;
  let signed = { ...mandate } as M;

  for (let i = 0; i < order.length; i++) {
    const step = order[i]!;
    const { privateKey, kid } = keyring.get(step.role);
    const target = signingTarget(signed, i);
    const jws = await new CompactSign(enc.encode(canonicalize(target)))
      .setProtectedHeader({ alg: "ES256", kid, typ: "application/mandate+jws" })
      .sign(privateKey);
    signed = { ...signed, [step.field]: jws } as M;
  }

  return signed;
}

export interface SignatureCheck {
  field: string;
  role: Role;
  ok: boolean;
  reason?: string;
}

/**
 * Verify every signature on a mandate.
 *
 * Two things are checked per signature, and both matter:
 *   1. the JWS verifies against the public key for the expected role, and
 *   2. the bytes it signed are byte-identical to the canonical form of the
 *      mandate in front of us.
 * Without (2) a valid signature over *some other* payload would sail through —
 * the token would verify while saying nothing about this mandate.
 */
export async function verifyMandate(mandate: Mandate, keyring: Keyring): Promise<SignatureCheck[]> {
  const order = SIGNATURE_ORDER[mandate.mandate_type] as ReadonlyArray<{ field: string; role: Role }>;
  const checks: SignatureCheck[] = [];

  for (let i = 0; i < order.length; i++) {
    const step = order[i]!;
    const jws = (mandate as unknown as Record<string, unknown>)[step.field] as CompactJws | undefined;

    if (!jws) {
      checks.push({ field: step.field, role: step.role, ok: false, reason: "signature missing" });
      continue;
    }

    const { publicKey, kid } = keyring.get(step.role);

    try {
      const { payload, protectedHeader } = await compactVerify(jws, publicKey);

      if (protectedHeader.kid !== kid) {
        checks.push({
          field: step.field,
          role: step.role,
          ok: false,
          reason: `signed by kid "${protectedHeader.kid}", expected "${kid}"`,
        });
        continue;
      }

      const expected = canonicalize(signingTarget(mandate, i));
      if (dec.decode(payload) !== expected) {
        checks.push({
          field: step.field,
          role: step.role,
          ok: false,
          reason: "signature is valid but covers different content — mandate was altered after signing",
        });
        continue;
      }

      checks.push({ field: step.field, role: step.role, ok: true });
    } catch (err) {
      checks.push({
        field: step.field,
        role: step.role,
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return checks;
}

/**
 * The hash the *next* mandate in the chain points at: SHA-256 over the fully
 * signed mandate, signatures included. Hashing the signed form (not the bare
 * payload) means a link commits to who signed as well as to what they signed.
 */
export function mandateHash(mandate: Mandate): Sha256Ref {
  return hashObject(mandate);
}

export function signatureFieldsFor(type: MandateType): readonly string[] {
  return (SIGNATURE_ORDER[type] as ReadonlyArray<{ field: string }>).map((s) => s.field);
}


// ── Signed documents that are not mandates ───────────────────────────────────

/**
 * Sign an arbitrary document with one role's key.
 *
 * The Verified Commerce History (Addendum H) is not a mandate — it makes no
 * claim about consent — but it is handed to third parties, so it needs the same
 * property: checkable by someone who does not trust whoever handed it over.
 * Same canonical bytes, same ES256, same verification rule that the signature
 * must cover exactly the document in front of you.
 */
export async function signDocument<T extends Record<string, unknown>>(
  document: T,
  keyring: Keyring,
  role: Role,
  signatureField = "signature",
): Promise<T & Record<string, string>> {
  const { privateKey, kid } = keyring.get(role);
  const jws = await new CompactSign(enc.encode(canonicalize(document)))
    .setProtectedHeader({ alg: "ES256", kid, typ: "application/report+jws" })
    .sign(privateKey);
  return { ...document, [signatureField]: jws } as T & Record<string, string>;
}

export async function verifyDocument(
  document: Record<string, unknown>,
  keyring: Keyring,
  role: Role,
  signatureField = "signature",
): Promise<SignatureCheck> {
  const jws = document[signatureField] as CompactJws | undefined;
  if (!jws) return { field: signatureField, role, ok: false, reason: "signature missing" };

  const { publicKey, kid } = keyring.get(role);
  try {
    const { payload, protectedHeader } = await compactVerify(jws, publicKey);
    if (protectedHeader.kid !== kid) {
      return { field: signatureField, role, ok: false, reason: `signed by kid "${protectedHeader.kid}"` };
    }
    const expected = canonicalize(omit(document, [signatureField]));
    if (dec.decode(payload) !== expected) {
      return {
        field: signatureField,
        role,
        ok: false,
        reason: "signature is valid but covers different content — the report was altered after signing",
      };
    }
    return { field: signatureField, role, ok: true };
  } catch (err) {
    return {
      field: signatureField,
      role,
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}
