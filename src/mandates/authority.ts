import type { CartMandate, CatalogItem, IntentMandate } from "./schema.js";

export interface AuthorityCheck {
  /** Short label, shown as a row in the trust panel. */
  label: string;
  ok: boolean;
  /** What the shopper asked for. */
  required: string;
  /** What is actually on offer. */
  actual: string;
  /** Why it failed, when it did. */
  reason?: string;
}

export interface AuthorityResult {
  authorized: boolean;
  checks: AuthorityCheck[];
  failures: string[];
}

const day = 24 * 60 * 60 * 1000;

/**
 * Attribute keys, reduced to one spelling.
 *
 * The model writes "colour" as often as "color", and a shopper may say either.
 * Comparing raw keys made a British spelling look like the shop had never
 * stated a colour at all — which blocked a purchase for a reason that was not
 * true. Both sides of every comparison go through this.
 */
const KEY_SYNONYMS: Record<string, string> = {
  colour: "color",
  color: "color",
  material: "material",
  fabric: "material",
  size: "size",
  dimensions: "size",
  shade: "color",
  type: "type",
};

export const normaliseKey = (key: string): string => {
  const k = key.trim().toLowerCase().replace(/[\s_-]+/g, "");
  return KEY_SYNONYMS[k] ?? k;
};

/** Loose value match: "blue" satisfies "royal blue", and vice versa. */
export const valuesAgree = (want: string, have: string): boolean => {
  const a = want.trim().toLowerCase();
  const b = have.trim().toLowerCase();
  return a.includes(b) || b.includes(a);
};

/** An item's attributes, keyed consistently. */
export const normaliseAttributes = (attrs: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(attrs).map(([k, v]) => [normaliseKey(k), v]));

/**
 * Can this agent pay for this, on this shopper's authority?
 *
 * The whole answer to "why should I let an AI spend my money". The agent may
 * search, compare, haggle and choose freely — none of that moves money. This is
 * the only gate that does, and it is a comparison between two things the agent
 * did not author: the constraints the shopper signed, and the cart the merchant
 * signed. The agent's own opinion is not an input.
 *
 * Every check is returned whether it passed or failed, because a trust panel
 * that only lists problems tells you nothing when there are none.
 */
export function checkAuthority(
  intent: IntentMandate,
  cart: CartMandate,
  item: CatalogItem,
  merchant: { delivers_within_days?: number; name?: string } | undefined,
  now: Date = new Date(),
): AuthorityResult {
  const checks: AuthorityCheck[] = [];
  const c = intent.constraints;
  const price = cart.final_price.value;

  const money = (n: number) => `₹${n.toLocaleString("en-IN")}`;

  checks.push({
    label: "Within your budget",
    ok: price <= c.max_price,
    required: `at most ${money(c.max_price)}`,
    actual: money(price),
    ...(price > c.max_price ? { reason: `${money(price - c.max_price)} over your limit` } : {}),
  });

  if (c.category) {
    const ok = item.category.startsWith(c.category);
    checks.push({
      label: "Right kind of thing",
      ok,
      required: c.category,
      actual: item.category,
      ...(ok ? {} : { reason: `${item.name} is not a ${c.category.split(".").pop()}` }),
    });
  }

  const itemAttributes = normaliseAttributes(item.attributes);
  for (const [rawKey, want] of Object.entries(c.attributes ?? {})) {
    const key = normaliseKey(rawKey);
    const have = itemAttributes[key];
    const ok = Boolean(have && valuesAgree(want, have));
    checks.push({
      label: `${key.charAt(0).toUpperCase()}${key.slice(1)} matches`,
      ok,
      required: want,
      actual: have ?? "not stated",
      ...(ok ? {} : { reason: have ? `you asked for ${want}` : `the shop did not state a ${key}` }),
    });
  }

  if (c.deliver_within_days !== undefined) {
    const can = merchant?.delivers_within_days;
    const ok = can !== undefined && can <= c.deliver_within_days;
    const asWords = (d: number) => (d === 0 ? "today" : d === 1 ? "by tomorrow" : `within ${d} days`);
    checks.push({
      label: "Arrives in time",
      ok,
      required: asWords(c.deliver_within_days),
      actual: can === undefined ? "not stated" : asWords(can),
      ...(ok ? {} : { reason: can === undefined ? "this shop has not said how fast it delivers" : `soonest is ${asWords(can)}` }),
    });
  }

  const issued = Date.parse(intent.issued_at);
  const expired = !Number.isFinite(issued) || now.getTime() - issued > c.ttl_seconds * day / day * 1000;
  checks.push({
    label: "Authorization still valid",
    ok: !expired,
    required: `used within ${c.ttl_seconds}s of asking`,
    actual: Number.isFinite(issued) ? `${Math.round((now.getTime() - issued) / 1000)}s ago` : "unreadable",
    ...(expired ? { reason: "the shopper's authorization has expired" } : {}),
  });

  checks.push({
    label: "Merchant agreed this price",
    ok: Boolean(cart.merchant_signature) && Boolean(cart.buyer_agent_signature),
    required: "signed by both sides",
    actual: cart.merchant_signature
      ? cart.buyer_agent_signature
        ? "merchant and buyer-agent signed"
        : "merchant only"
      : "unsigned",
    ...(cart.merchant_signature && cart.buyer_agent_signature ? {} : { reason: "the cart is not a two-party agreement" }),
  });

  const failures = checks.filter((k) => !k.ok).map((k) => `${k.label}: ${k.reason ?? "failed"}`);
  return { authorized: failures.length === 0, checks, failures };
}
