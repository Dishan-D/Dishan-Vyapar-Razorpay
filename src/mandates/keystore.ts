import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { exportJWK, type JWK } from "jose";
import { Keyring, ROLES, type RoleKeys } from "./keys.js";
import type { Role } from "./schema.js";

const KEYS_FILE = path.resolve("data", "keys.local.json");

const exists = (p: string): Promise<boolean> => access(p).then(() => true, () => false);

function jwkFromEnv(role: Role): JWK | undefined {
  const raw = process.env[`${role.toUpperCase()}_JWK`];
  return raw ? (JSON.parse(raw) as JWK) : undefined;
}

/**
 * A keyring that survives a restart.
 *
 * Ephemeral keys are fine for a one-shot script, but an audit chain written on
 * Monday and verified on Tuesday needs the same keys both days — regenerating
 * them would turn every stored mandate into an unverifiable one, which looks
 * identical to tampering. Env JWKs win; otherwise keys are created once and
 * kept in data/keys.local.json (gitignored — these are private keys).
 */
export async function loadOrCreateKeyring(): Promise<Keyring> {
  const fromEnv = Object.fromEntries(
    ROLES.map((role) => [role, jwkFromEnv(role)]).filter(([, jwk]) => jwk),
  ) as Partial<Record<Role, JWK>>;

  if (Object.keys(fromEnv).length === ROLES.length) {
    return Keyring.fromJwks(fromEnv);
  }

  if (await exists(KEYS_FILE)) {
    const stored = JSON.parse(await readFile(KEYS_FILE, "utf8")) as Record<Role, JWK>;
    return Keyring.fromJwks(stored);
  }

  const keyring = await Keyring.generate();
  const out: Record<string, JWK> = {};
  for (const role of ROLES) {
    const k: RoleKeys = keyring.get(role);
    out[role] = { ...(await exportJWK(k.privateKey)), kid: k.kid, alg: "ES256" };
  }
  await mkdir(path.dirname(KEYS_FILE), { recursive: true });
  await writeFile(KEYS_FILE, JSON.stringify(out, null, 2) + "\n", { mode: 0o600 });
  return keyring;
}
