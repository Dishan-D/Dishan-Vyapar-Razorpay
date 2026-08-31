import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CatalogItem, NegotiationPolicy } from "../mandates/schema.js";
import { extractFromFixture, extractLive, hasCredentials } from "./extract.js";
import {
  evaluateGate,
  toCatalogItem,
  type Extraction,
  type ExtractionAudit,
  type ExtractionRecord,
  type ExtractionSource,
  type RawProduct,
} from "./extraction.js";
import { priceSanity, type SanityResult } from "./sanity.js";

export const DATA_DIR = path.resolve("data");
const MERCHANTS_FILE = path.join(DATA_DIR, "merchants.json");
const FIXTURES_FILE = path.join(DATA_DIR, "fixtures", "extractions.json");
export const CATALOG_FILE = path.join(DATA_DIR, "catalog.json");

const exists = async (p: string): Promise<boolean> => access(p).then(() => true, () => false);

export interface Merchant {
  merchant_id: string;
  name: string;
  city: string;
  whatsapp: string;
  /** The one piece of digital infrastructure they already had. */
  upi_vpa: string;
  /** Year they started taking UPI. */
  since: string;
  /** Where the QR physically lives in the shop. */
  qr_note: string;
}

interface MerchantSeed extends Merchant {
  products: Array<Omit<RawProduct, "merchant_id">>;
  policies: Array<Omit<NegotiationPolicy, "set_by" | "set_at">>;
}

export interface PhotoRef {
  filename?: string;
  present: boolean;
}

export interface StructuringResult {
  merchants: Merchant[];
  items: CatalogItem[];
  records: ExtractionRecord[];
  /** Per-field provenance through the gate (Addendum G.2), keyed by item_id. */
  audits: Record<string, ExtractionAudit>;
  sanity: Record<string, SanityResult>;
  /** Items whose price the merchant answered for directly. */
  merchantConfirmed: string[];
  policies: NegotiationPolicy[];
  provider: ExtractionSource;
  /** Per-item source counts, so a partial live run cannot misreport itself. */
  sourceCounts: Partial<Record<ExtractionSource, number>>;
  failures: Array<{ sample_id: string; error: string }>;
  photosUsed: number;
  photos: Record<string, PhotoRef>;
}

async function loadSeed(): Promise<MerchantSeed[]> {
  const doc = JSON.parse(await readFile(MERCHANTS_FILE, "utf8")) as { merchants: MerchantSeed[] };
  return doc.merchants;
}

/** Raw input for every merchant, with a photo path only where the file exists. */
export async function loadRawProducts(): Promise<RawProduct[]> {
  const seed = await loadSeed();
  const out: RawProduct[] = [];

  for (const m of seed) {
    for (const p of m.products) {
      const photoPath = p.photo_filename
        ? path.join(DATA_DIR, "sample_products", p.photo_filename)
        : undefined;
      const havePhoto = photoPath ? await exists(photoPath) : false;
      out.push({
        ...p,
        merchant_id: m.merchant_id,
        merchant_name: m.name,
        ...(havePhoto && photoPath ? { photo_path: photoPath } : {}),
      });
    }
  }
  return out;
}

async function loadFixtures(): Promise<Record<string, Extraction>> {
  const parsed = JSON.parse(await readFile(FIXTURES_FILE, "utf8")) as {
    extractions: Record<string, Extraction>;
  };
  return parsed.extractions;
}

/**
 * Stage 1, all five steps (Addendum G.1).
 *
 * draft extraction → deterministic sanity → combined gate → (clarification, which
 * lives in clarify.ts because it is asynchronous and outlives this call) →
 * finalize.
 *
 * The sanity pass runs after every item is drafted, because it needs the
 * merchant's other prices to compare against — a per-item pipeline could not do
 * it. That is the whole reason this stage is a pipeline and not a call.
 */
export async function runStructuring(live: boolean): Promise<StructuringResult> {
  const seed = await loadSeed();
  const raws = await loadRawProducts();
  const useLive = live && hasCredentials();

  const fixtures = await loadFixtures();
  let records: ExtractionRecord[];
  const failures: Array<{ sample_id: string; error: string }> = [];

  if (useLive) {
    // Sequential on purpose: image requests are the expensive part and both
    // providers rate-limit them, so a burst buys nothing but 429s.
    //
    // Per item, not per run: a rate limit on the twelfth product used to throw
    // away the eleven extractions that had already succeeded and cost money.
    // A failed item falls back to its fixture and is reported, so a partial run
    // is still a usable catalog that says which parts are which.
    records = [];
    for (const raw of raws) {
      try {
        records.push(await extractLive(raw));
      } catch (err) {
        failures.push({ sample_id: raw.sample_id, error: err instanceof Error ? err.message : String(err) });
        records.push(await extractFromFixture(raw, fixtures));
      }
    }
  } else {
    records = await Promise.all(raws.map((raw) => extractFromFixture(raw, fixtures)));
  }

  // Step 1 → provisional catalog, gated on model confidence alone.
  const items = raws.map((raw, i) => toCatalogItem(raw, records[i]!));

  // Steps 2–3 → sanity against the merchant's own history, then the combined gate.
  const sanity: Record<string, SanityResult> = {};
  const audits: Record<string, ExtractionAudit> = {};

  for (const item of items) {
    const result = priceSanity(item, items);
    sanity[item.item_id] = result;

    const gate = evaluateGate(item, result);
    item.needs_merchant_confirmation = gate.held;

    audits[item.item_id] = {
      item_id: item.item_id,
      merchant_id: item.merchant_id,
      field: "price",
      llm_confidence: item.price.confidence,
      sanity_check: result.check,
      sanity_reason: result.reason,
      gate_result: gate.held ? "held" : "passed",
      gate_triggers: gate.triggers,
      clarification_sent: false,
      clarification_channel: null,
      resolved_value: null,
      resolved_at: null,
    };
  }

  const photos: Record<string, PhotoRef> = {};
  for (const [i, raw] of raws.entries()) {
    photos[items[i]!.item_id] = {
      ...(raw.photo_filename ? { filename: raw.photo_filename } : {}),
      present: Boolean(raw.photo_path),
    };
  }

  const policies: NegotiationPolicy[] = seed.flatMap((m) =>
    m.policies.map((p) => ({ ...p, set_by: "merchant" as const, set_at: "2026-08-30T10:05:00Z" })),
  );

  return {
    merchants: seed.map(({ merchant_id, name, city, whatsapp, upi_vpa, since, qr_note }) => ({
      merchant_id, name, city, whatsapp, upi_vpa, since, qr_note,
    })),
    items,
    records,
    audits,
    sanity,
    merchantConfirmed: [],
    policies,
    // The run is only "live" if every record came back live. A catalog that is
    // half model output and half stand-ins must not claim to be either.
    provider: records.every((r) => r.provider === "groq")
      ? "groq"
      : records.every((r) => r.provider === "claude")
        ? "claude"
        : records.some((r) => r.provider !== "fixture")
          ? ((records.find((r) => r.provider !== "fixture")!.provider) as ExtractionSource)
          : "fixture",
    sourceCounts: records.reduce(
      (acc, r) => ({ ...acc, [r.provider]: (acc[r.provider] ?? 0) + 1 }),
      {} as Partial<Record<ExtractionSource, number>>,
    ),
    failures,
    photosUsed: raws.filter((r) => r.photo_path).length,
    photos,
  };
}

export async function writeCatalog(result: StructuringResult): Promise<string> {
  const doc = {
    generated_at: new Date().toISOString(),
    provider: result.provider,
    sourceCounts: result.sourceCounts,
    ...(result.provider === "fixture"
      ? { warning: "Confidence values come from hand-authored fixtures, not a live model call." }
      : {}),
    merchants: result.merchants,
    photos: result.photos,
    audits: result.audits,
    sanity: result.sanity,
    merchantConfirmed: result.merchantConfirmed,
    policies: result.policies,
    items: result.items,
  };
  await writeFile(CATALOG_FILE, JSON.stringify(doc, null, 2) + "\n");
  return CATALOG_FILE;
}

interface CatalogDoc {
  provider: ExtractionSource;
  sourceCounts?: Partial<Record<ExtractionSource, number>>;
  merchants?: Merchant[];
  photos?: Record<string, PhotoRef>;
  audits?: Record<string, ExtractionAudit>;
  sanity?: Record<string, SanityResult>;
  merchantConfirmed?: string[];
  policies?: NegotiationPolicy[];
  items: CatalogItem[];
}

export async function readCatalog(): Promise<CatalogItem[]> {
  const doc = JSON.parse(await readFile(CATALOG_FILE, "utf8")) as CatalogDoc;
  return doc.items;
}

/**
 * What the server serves.
 *
 * Extraction is a paid model call over every product; doing it on every boot
 * would be slow and would spend money to produce the same catalog each time. So
 * a catalog written by `milestone-b --live` is reused if present, and fixtures
 * stand in otherwise.
 */
export async function loadServingCatalog(): Promise<StructuringResult> {
  if (await exists(CATALOG_FILE)) {
    const doc = JSON.parse(await readFile(CATALOG_FILE, "utf8")) as CatalogDoc;

    // A cache written before a schema change is worse than no cache: it looks
    // fine and quietly serves fields that no longer exist. Any merchant missing
    // one of the current fields invalidates the whole file.
    const currentShape = doc.merchants?.every((m) => m.upi_vpa && m.whatsapp && m.city) ?? false;

    if (doc.items?.length && doc.merchants?.length && currentShape) {
      return {
        merchants: doc.merchants,
        items: doc.items,
        records: [],
        audits: doc.audits ?? {},
        sanity: doc.sanity ?? {},
        merchantConfirmed: doc.merchantConfirmed ?? [],
        policies: doc.policies ?? [],
        provider: doc.provider ?? "fixture",
        sourceCounts: doc.sourceCounts ?? {},
        failures: [],
        photosUsed: Object.values(doc.photos ?? {}).filter((p) => p.present).length,
        photos: doc.photos ?? {},
      };
    }
  }
  return runStructuring(false);
}
