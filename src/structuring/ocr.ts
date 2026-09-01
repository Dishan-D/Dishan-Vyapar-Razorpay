import { createWorker, type Worker } from "tesseract.js";

/**
 * Read whatever text is physically printed in a shop photo.
 *
 * This runs on this machine and costs nothing. That matters more than it
 * sounds: the vision model has a daily token ceiling, and a merchant onboarding
 * fifteen photos can exhaust it — at which point the only honest thing the
 * product could previously say was "come back tomorrow".
 *
 * OCR is also simply better at the specific thing it does. A price scrawled on
 * a tag, an MRP printed on a packet, a brand name on a box — a vision model
 * paraphrases those from an impression of the image, and a paraphrased price is
 * a wrong price. Tesseract either reads the characters or returns nothing, and
 * "nothing" is a far safer failure than a confident misreading.
 *
 * It cannot tell you that something is a saree. That is still the model's job.
 * The two are complements, not substitutes.
 */

let worker: Worker | null = null;
let starting: Promise<Worker> | null = null;

/** One worker for the process; spinning one up per photo costs seconds each. */
async function getWorker(): Promise<Worker> {
  if (worker) return worker;
  if (!starting) {
    starting = createWorker("eng").then((w) => {
      worker = w;
      return w;
    });
  }
  return starting;
}

export async function shutdownOcr(): Promise<void> {
  if (worker) {
    await worker.terminate();
    worker = null;
    starting = null;
  }
}

export interface PhotoText {
  path: string;
  /** Cleaned text, or "" when the photo carries no legible writing. */
  text: string;
  /** Tesseract's own mean confidence, 0–100. */
  confidence: number;
  /** Rupee amounts found as digits, most prominent first. */
  amounts: number[];
}

/**
 * Numbers that are plausibly prices, in the order they appear.
 *
 * Deliberately narrow. A photo contains all sorts of digits — dates, phone
 * numbers, GST numbers, weights — and treating any of them as a price is how a
 * catalog ends up offering a saree for ₹2026. Anything that does not look like
 * shop money is dropped here rather than explained away later.
 */
export function amountsIn(text: string): number[] {
  const out: number[] = [];
  const re = /(?:₹|rs\.?|inr|mrp[:\s]*)\s*([0-9][0-9,]{0,7})(?:\s*\/-)?|\b([0-9][0-9,]{1,6})\s*(?:\/-|rs\.?|rupees)\b/gi;
  for (const m of text.matchAll(re)) {
    const n = Number(String(m[1] ?? m[2] ?? "").replace(/,/g, ""));
    // A shop price. Below ₹5 is almost always a stray digit; above ₹5 lakh is
    // not stock in the shops this is built for.
    if (Number.isFinite(n) && n >= 5 && n <= 500_000) out.push(n);
  }
  return [...new Set(out)];
}

/** Collapse OCR's ragged whitespace without joining words that were apart. */
function tidy(raw: string): string {
  return raw
    .replace(/[ \t]+/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 1)
    .join("\n")
    .slice(0, 1200);
}

export async function readPhoto(path: string): Promise<PhotoText> {
  try {
    const w = await getWorker();
    const { data } = await w.recognize(path);
    const text = tidy(data.text ?? "");
    return { path, text, confidence: data.confidence ?? 0, amounts: amountsIn(text) };
  } catch {
    // A failed read is not a failed onboarding. The photo still goes to the
    // model; it just goes without the assist.
    return { path, text: "", confidence: 0, amounts: [] };
  }
}

export async function readPhotos(paths: string[]): Promise<PhotoText[]> {
  const out: PhotoText[] = [];
  for (const p of paths) out.push(await readPhoto(p));
  return out;
}

/**
 * Is this a real reading, or texture mistaken for letters?
 *
 * Tesseract does not decline. Shown a plain photograph of folded cloth it
 * returns something — on the five sample photos here it produced
 * `"2 | | » To a | Tor | J hh"` at confidence 22–36, which passes any test
 * based on length alone. Feeding that to the model is worse than sending
 * nothing: it is noise wearing the costume of evidence, and the model will
 * dutifully try to make a product out of it.
 *
 * So the gate is confidence first. Genuine printed text — a price tag, an MRP
 * on a packet — reads well above 60; hallucinated texture sits in the 20s and
 * 30s. A parsed rupee amount is accepted at a lower bar because the amount
 * pattern is itself narrow, but noise still has to clear the floor.
 */
export const isUseful = (t: PhotoText): boolean => {
  if (t.confidence < 45) return false;
  const letters = t.text.replace(/[^a-z]/gi, "").length;
  const words = t.text.split(/\s+/).filter((w) => /^[a-z]{3,}$/i.test(w)).length;
  if (t.amounts.length > 0 && t.confidence >= 55) return true;
  return t.confidence >= 60 && letters >= 12 && words >= 3;
};
