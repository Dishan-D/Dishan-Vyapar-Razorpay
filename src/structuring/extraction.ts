import { z } from "zod";
import type { CatalogItem } from "../mandates/schema.js";
import type { SanityResult, SanityVerdict } from "./sanity.js";

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

/**
 * The shape the model is actually asked for.
 *
 * Identical to Extraction except that `attributes` is a list of key/value pairs
 * rather than a map. Strict structured-output modes require every object to
 * declare `additionalProperties: false`, which an open-ended map cannot — so the
 * map is carried as pairs on the wire and rebuilt on arrival. Both providers use
 * this same schema, so neither gets a different question.
 */
export const ExtractionWireSchema = ExtractionSchema.omit({ attributes: true }).extend({
  attributes: z
    .array(z.object({ key: z.string(), value: z.string() }))
    .describe("Material, colour, size etc. Only attributes actually stated or clearly visible."),
});

export type ExtractionWire = z.infer<typeof ExtractionWireSchema>;

export function fromWire(wire: ExtractionWire): Extraction {
  const attributes: Record<string, string> = {};
  for (const { key, value } of wire.attributes) attributes[key] = value;
  return { ...wire, attributes };
}

/** A merchant's raw, unstructured input for one product. */
export interface RawProduct {
  /** Stable across runs, so negotiation policies can name it. */
  item_id: string;
  sample_id: string;
  merchant_id: string;
  /** Pre-transcribed voice note. Real speech-to-text is out of scope — see README. */
  voice_note: string;
  /** Filename carries a loose hint, exactly as a merchant's phone gallery would. */
  photo_filename?: string;
  photo_path?: string;
  payment_page_description?: string;
}

/** Who produced an extraction. Recorded so a catalog can never misreport itself. */
export type ExtractionSource = "claude" | "groq" | "fixture";

export interface ExtractionRecord {
  sample_id: string;
  extraction: Extraction;
  provider: ExtractionSource;
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
export function toCatalogItem(raw: RawProduct, record: ExtractionRecord): CatalogItem {
  const e = record.extraction;
  const missingPrice = e.price_value === null;
  const missingStock = e.stock_quantity === null;

  // A field the model could not read at all is zero-confidence, whatever it scored.
  const priceConfidence = missingPrice ? 0 : e.price_confidence;
  const stockConfidence = missingStock ? 0 : e.stock_confidence;

  return {
    item_id: raw.item_id,
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

/** What tripped the gate, if anything. */
export type GateTrigger = "price_confidence" | "stock_confidence" | "price_sanity";

export interface GateOutcome {
  held: boolean;
  triggers: GateTrigger[];
  reasons: string[];
}

/**
 * The combined gate (Addendum G.1.3).
 *
 * An item is held if the model was unsure about its price or stock, OR if the
 * merchant's own price history says the number is out of family. Which condition
 * fired is recorded, not just that one did — the clarification question is
 * different for each, and "please review this item" is not a question anyone can
 * answer.
 *
 * The addendum names price-confidence and sanity; stock confidence is kept from
 * the original §3 Stage 1 gate rather than dropped, since an item whose stock
 * count is unknown still cannot be sold.
 */
export function evaluateGate(item: CatalogItem, sanity?: SanityResult): GateOutcome {
  const triggers: GateTrigger[] = [];
  const reasons: string[] = [];

  if (item.price.confidence < CONFIDENCE_FLOOR) {
    triggers.push("price_confidence");
    reasons.push(`price confidence ${item.price.confidence.toFixed(2)} < ${CONFIDENCE_FLOOR}`);
  }
  if (item.stock.confidence < CONFIDENCE_FLOOR) {
    triggers.push("stock_confidence");
    reasons.push(`stock confidence ${item.stock.confidence.toFixed(2)} < ${CONFIDENCE_FLOOR}`);
  }
  if (sanity?.check === "fail") {
    triggers.push("price_sanity");
    reasons.push(`price out of family — ${sanity.reason}`);
  }

  return { held: triggers.length > 0, triggers, reasons };
}

/** Why an item is held back, for display. Empty array means it is transactable. */
export function gateReasons(item: CatalogItem, sanity?: SanityResult): string[] {
  return evaluateGate(item, sanity).reasons;
}

/**
 * Provenance for one field's journey through the gate (Addendum G.2).
 * Kept alongside the CatalogItem, never inside it — the transactable record
 * stays clean and this stays queryable on its own.
 */
export interface ExtractionAudit {
  item_id: string;
  merchant_id: string;
  field: "price";
  llm_confidence: number;
  sanity_check: SanityVerdict;
  sanity_reason: string;
  gate_result: "held" | "passed";
  gate_triggers: GateTrigger[];
  clarification_sent: boolean;
  clarification_channel: "whatsapp" | "dashboard" | null;
  resolved_value: number | null;
  resolved_at: string | null;
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
export function assertTransactable(item: CatalogItem, sanity?: SanityResult): void {
  const reasons = gateReasons(item, sanity);
  if (item.needs_merchant_confirmation || reasons.length > 0) {
    throw new NotTransactableError(item, reasons.length > 0 ? reasons : ["flagged for confirmation"]);
  }
}
