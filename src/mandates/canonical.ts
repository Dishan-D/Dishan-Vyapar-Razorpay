import { createHash } from "node:crypto";

/**
 * Deterministic JSON serialization (RFC 8785 / JCS subset).
 *
 * Why this exists: a mandate's hash is what the next mandate in the chain points
 * at. If two logically-identical payloads can serialize to different byte strings
 * — different key order, incidental whitespace — the hash link breaks for reasons
 * that have nothing to do with tampering. So every hash and every signature in
 * this codebase is taken over canonical bytes, never over `JSON.stringify(obj)`
 * with default key order.
 *
 * Rules: object keys sorted by UTF-16 code unit, no insignificant whitespace,
 * arrays keep their order, `undefined` object members are dropped.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return "null";

  const t = typeof value;

  if (t === "number") {
    if (!Number.isFinite(value as number)) {
      throw new TypeError(`Cannot canonicalize non-finite number: ${String(value)}`);
    }
    return JSON.stringify(value);
  }

  if (t === "string" || t === "boolean") return JSON.stringify(value);

  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalize(v === undefined ? null : v)).join(",")}]`;
  }

  if (t === "object") {
    const obj = value as Record<string, unknown>;
    const members = Object.keys(obj)
      .sort()
      .filter((k) => obj[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`);
    return `{${members.join(",")}}`;
  }

  throw new TypeError(`Cannot canonicalize value of type ${t}`);
}

/** SHA-256 over the canonical form, formatted as `sha256:<hex>`. */
export function hashObject(value: unknown): string {
  const digest = createHash("sha256").update(canonicalize(value), "utf8").digest("hex");
  return `sha256:${digest}`;
}

/** Structured clone minus the named keys — used to reconstruct what a signature covered. */
export function omit<T extends Record<string, unknown>>(obj: T, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!keys.includes(k)) out[k] = v;
  }
  return out;
}
