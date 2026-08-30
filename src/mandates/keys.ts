import { generateKeyPair, exportJWK, importJWK, type JWK, type CryptoKey } from "jose";
import type { Role } from "./schema.js";

export const ROLES: readonly Role[] = ["buyer_agent", "merchant", "platform"];

export interface RoleKeys {
  kid: string;
  role: Role;
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  publicJwk: JWK;
}

/**
 * The three signing identities in the system. For the hackathon a single backend
 * plays all three roles (PROJECT_CONTEXT.md §8 permits this), but they are held
 * as genuinely separate ES256 keypairs — the audit chain is only meaningful if
 * "the merchant signed this" and "the buyer-agent signed this" are distinguishable
 * facts, not two labels on one key.
 */
export class Keyring {
  private readonly keys = new Map<Role, RoleKeys>();

  private constructor(entries: RoleKeys[]) {
    for (const e of entries) this.keys.set(e.role, e);
  }

  /** Ephemeral keys, regenerated per process. Fine for Milestone A and tests. */
  static async generate(roles: readonly Role[] = ROLES): Promise<Keyring> {
    const entries = await Promise.all(
      roles.map(async (role): Promise<RoleKeys> => {
        const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
        return {
          role,
          kid: `${role}_key_1`,
          privateKey,
          publicKey,
          publicJwk: await exportJWK(publicKey),
        };
      }),
    );
    return new Keyring(entries);
  }

  /** Load from persisted private JWKs, e.g. `MERCHANT_JWK` in .env (Milestone D+). */
  static async fromJwks(jwks: Partial<Record<Role, JWK>>): Promise<Keyring> {
    const entries = await Promise.all(
      (Object.entries(jwks) as [Role, JWK][]).map(async ([role, jwk]): Promise<RoleKeys> => {
        const privateKey = (await importJWK(jwk, "ES256")) as CryptoKey;
        const { d, ...pub } = jwk;
        const publicKey = (await importJWK(pub, "ES256")) as CryptoKey;
        return { role, kid: jwk.kid ?? `${role}_key_1`, privateKey, publicKey, publicJwk: pub };
      }),
    );
    return new Keyring(entries);
  }

  get(role: Role): RoleKeys {
    const k = this.keys.get(role);
    if (!k) throw new Error(`No key loaded for role "${role}"`);
    return k;
  }

  /** Public half only — this is what a verifier (or a judge) actually needs. */
  publicKeyring(): Record<Role, { kid: string; jwk: JWK }> {
    const out = {} as Record<Role, { kid: string; jwk: JWK }>;
    for (const [role, k] of this.keys) out[role] = { kid: k.kid, jwk: k.publicJwk };
    return out;
  }
}
