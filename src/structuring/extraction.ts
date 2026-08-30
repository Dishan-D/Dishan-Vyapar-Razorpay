import { z } from "zod";
import type { CatalogItem } from "../mandates/schema.js";

/**
 * What the structuring agent is asked to return.
 *
 * Richer than the CatalogItem it becomes: the model scores confidence on every
 * field it extracted, not just the two that gate transactability, and says in
 * one line what it based each reading on. CatalogItem (§4.1) stays exactly as
 * specified — this is provenance kept alongside it, not a change to the contract
 * between stages.
 */
export const ExtractionSchema = z.object({
  name: z.string().describe("Product name as a shopper would search for it, in English"),
  name_confidence: z.number().min(0).max(1),
  category: z
    .string()
    .describe("Dotted category path, e.g. apparel.saree, home.bedsheet, apparel.kurta"),
  category_confidence: z.number().min(0).max(1),
  attributes: z
    .record(z.string(), z.string())
    .describe("Material, colour, size etc. Only attributes actually stated or clearly visible."),
  attributes_confidence: z.number().min(0).max(1),
  price_value: z.number().nullable().describe("Numeric price in INR, or null if none was stated"),
  price_confidence: z.number().min(0).max(1),
  stock_quantity: z.number().int().nullable().describe("Units in stock, or null if not stated"),
  stock_confidence: z.number().min(0).max(1),
  notes: z.string().describe("One line: what each uncertain reading was based on"),
});

export type Extraction = z.infer<typeof ExtractionSchema>;

/** A merchant's raw, unstructured input for one product. */
export interface RawProduct {
  sample_id: string;
  merchant_id: string;
  /** Pre-transcribed voice note. Real speech-to-text is out of scope — see README. */
  voice_note: string;
  /** Filename carries a loose hint, exactly as a merchant's phone gallery would. */
  photo_filename?: string;
  photo_path?: string;
  payment_page_description?: string;
}

export interface ExtractionRecord {
  sample_id: string;
  extraction: Extraction;
  provider: "claude" | "fixture";
  model?: string;
  extracted_at: string;
}

/**
 * Confidence below which a field is not trusted enough to transact on.
 * PROJECT_CONTEXT.md §3 Stage 1 sets this at 0.6 for price and stock.
 */
export const CONFIDENCE_FLOOR = 0.6;

/**
 * Project an extraction into the catalog item that Stage 2 searches.
 *
 * The gate is applied here, once, at the point the catalog item is created —
 * not at each call site that might remember to check. An item whose price or
 * stock the model was unsure about is written into the catalog flagged, and
 * `assertTransactable` below is what stops it reaching a mandate.
 */
export function toCatalogItem(raw: RawProduct, record: ExtractionRecord, index: number): CatalogItem {
  const e = record.extraction;
  const missingPrice = e.price_value === null;
  const missingStock = e.stock_quantity === null;

  // A field the model could not read at all is zero-confidence, whatever it scored.
  const priceConfidence = missingPrice ? 0 : e.price_confidence;
  const stockConfidence = missingStock ? 0 : e.stock_confidence;

  return {
    item_id: `itm_${String(index + 1).padStart(3, "0")}`,
    merchant_id: raw.merchant_id,
    name: e.name,
    category: e.category,
    attributes: e.attributes,
    price: { value: e.price_value ?? 0, currency: "INR", confidence: priceConfidence },
    stock: { quantity: e.stock_quantity ?? 0, confidence: stockConfidence },
    source: {
      type: raw.photo_path ? "photo" : "voice_note",
      raw_text: raw.voice_note,
    },
    needs_merchant_confirmation:
      priceConfidence < CONFIDENCE_FLOOR || stockConfidence < CONFIDENCE_FLOOR,
    extracted_at: record.extracted_at,
  };
}

/** Why an item is held back, for display. Empty array means it is transactable. */
export function gateReasons(item: CatalogItem): string[] {
  const reasons: string[] = [];
  if (item.price.confidence < CONFIDENCE_FLOOR) {
    reasons.push(`price confidence ${item.price.confidence.toFixed(2)} < ${CONFIDENCE_FLOOR}`);
  }
  if (item.stock.confidence < CONFIDENCE_FLOOR) {
    reasons.push(`stock confidence ${item.stock.confidence.toFixed(2)} < ${CONFIDENCE_FLOOR}`);
  }
  return reasons;
}

export class NotTransactableError extends Error {
  constructor(readonly item: CatalogItem, readonly reasons: string[]) {
    super(
      `Item ${item.item_id} ("${item.name}") needs merchant confirmation before it can be sold: ${reasons.join("; ")}`,
    );
    this.name = "NotTransactableError";
  }
}

/**
 * The enforcement half of the Stage 1 gate. Every stage that would commit the
 * merchant to something — negotiation, cart mandate, payment — calls this first.
 * A flag nobody checks is decoration; this is what makes it a gate.
 */
export function assertTransactable(item: CatalogItem): void {
  const reasons = gateReasons(item);
  if (item.needs_merchant_confirmation || reasons.length > 0) {
    throw new NotTransactableError(item, reasons.length > 0 ? reasons : ["flagged for confirmation"]);
  }
}
