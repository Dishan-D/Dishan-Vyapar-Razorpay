/**
 * Read a shop's own UPI QR.
 *
 * A merchant already has this sticker on their counter. Asking them to type
 * `sribalajibakery@okicici` instead is asking them to transcribe a string they
 * have never read, from a payment system whose vocabulary they have no reason
 * to know — and a typo there sends money to a stranger. The QR is the thing
 * they actually possess, so it is the thing to accept.
 *
 * The image is decoded in the browser, where there is already a JPEG and PNG
 * decoder and a canvas to read pixels from. This parses and checks what came
 * back, because a decoded string is still just a string somebody could have
 * pointed a camera at.
 */

export interface UpiDetails {
  upi_id: string;
  merchant_name: string | null;
  currency: string;
  /** Anything present in the QR we deliberately do not act on. */
  extras: Record<string, string>;
}

export interface UpiReadResult {
  ok: boolean;
  details?: UpiDetails;
  /** Said to the merchant, in their terms, when it did not work. */
  problem?: string;
}

/**
 * A UPI id is `handle@psp`. Deliberately not a strict allowlist of PSPs: new
 * ones appear, and refusing a merchant's genuine id because a bank launched
 * after this was written would be the worst possible failure here.
 */
const VPA = /^[a-zA-Z0-9._-]{2,64}@[a-zA-Z][a-zA-Z0-9.-]{1,64}$/;

export function readUpiUri(raw: string): UpiReadResult {
  const text = String(raw ?? "").trim();
  if (!text) return { ok: false, problem: "That image did not contain a QR code I could read." };

  if (!/^upi:\/\//i.test(text)) {
    // Worth distinguishing: a QR that scanned fine but is not a payment QR is a
    // different problem from a blurry photo, and the merchant fixes them
    // differently.
    return {
      ok: false,
      problem:
        "I read a QR code, but it is not a UPI payment code — it points somewhere else. Try the QR from your payment sticker.",
    };
  }

  let params: URLSearchParams;
  try {
    // upi:// is not a hierarchical URL, so the query is taken by hand rather
    // than through the URL parser, which drops it.
    params = new URLSearchParams(text.slice(text.indexOf("?") + 1));
  } catch {
    return { ok: false, problem: "That QR code is a UPI code but I could not make sense of what is in it." };
  }

  const upi = (params.get("pa") ?? "").trim();
  if (!upi) return { ok: false, problem: "That UPI code does not carry a payment address." };
  if (!VPA.test(upi)) {
    return { ok: false, problem: `"${upi}" does not look like a UPI id. It should read something like yourshop@okicici.` };
  }

  const known = new Set(["pa", "pn", "cu", "am", "tn", "tr", "mc", "mode", "purpose", "orgid", "sign"]);
  const extras: Record<string, string> = {};
  for (const [k, v] of params) if (!known.has(k) && v) extras[k] = v;

  return {
    ok: true,
    details: {
      upi_id: upi,
      merchant_name: (params.get("pn") ?? "").trim() || null,
      currency: (params.get("cu") ?? "INR").trim().toUpperCase() || "INR",
      extras,
    },
  };
}

/**
 * Some QRs carry a fixed amount. A shop's collection QR should not.
 *
 * Saving a one-off payment request as the shop's standing payment address would
 * make every future sale ask for that same amount, so it is worth catching and
 * saying plainly rather than storing and wondering later.
 */
export function fixedAmountWarning(raw: string): string | null {
  const at = raw.indexOf("?");
  if (at === -1) return null;
  const amount = new URLSearchParams(raw.slice(at + 1)).get("am");
  if (!amount || Number(amount) <= 0) return null;
  return `This QR asks for a fixed ₹${amount}. That is a one-off request rather than your shop's standing code — I will save the UPI id and ignore the amount.`;
}
