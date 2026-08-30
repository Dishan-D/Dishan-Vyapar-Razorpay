import { readFile } from "node:fs/promises";
import path from "node:path";
import type { NegotiationPolicy } from "../mandates/schema.js";

const POLICIES_FILE = path.resolve("data", "negotiation_policies.json");

export async function loadPolicies(): Promise<Map<string, NegotiationPolicy>> {
  const doc = JSON.parse(await readFile(POLICIES_FILE, "utf8")) as { policies: NegotiationPolicy[] };
  return new Map(doc.policies.map((p) => [p.item_id, p]));
}

/** An item with no policy is not negotiable — that is a merchant decision, not an error. */
export function policyFor(
  policies: Map<string, NegotiationPolicy>,
  itemId: string,
): NegotiationPolicy | undefined {
  return policies.get(itemId);
}
