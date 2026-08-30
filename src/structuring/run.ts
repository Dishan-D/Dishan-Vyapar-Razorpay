import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import type { CatalogItem } from "../mandates/schema.js";
import {
  extractFromFixture,
  extractWithClaude,
  hasCredentials,
} from "./extract.js";
import {
  toCatalogItem,
  type Extraction,
  type ExtractionRecord,
  type RawProduct,
} from "./extraction.js";

export const DATA_DIR = path.resolve("data");
const PRODUCTS_FILE = path.join(DATA_DIR, "sample_products", "products.json");
const FIXTURES_FILE = path.join(DATA_DIR, "fixtures", "extractions.json");
export const CATALOG_FILE = path.join(DATA_DIR, "catalog.json");

const exists = async (p: string): Promise<boolean> =>
  access(p).then(() => true, () => false);

/** Load the merchant's raw input, attaching a photo path only where a file is actually present. */
export async function loadRawProducts(): Promise<RawProduct[]> {
  const raw = JSON.parse(await readFile(PRODUCTS_FILE, "utf8")) as {
    merchant_id: string;
    products: Array<Omit<RawProduct, "merchant_id">>;
  };

  return Promise.all(
    raw.products.map(async (p) => {
      const photoPath = p.photo_filename
        ? path.join(DATA_DIR, "sample_products", p.photo_filename)
        : undefined;
      const havePhoto = photoPath ? await exists(photoPath) : false;
      return {
        ...p,
        merchant_id: raw.merchant_id,
        ...(havePhoto && photoPath ? { photo_path: photoPath } : {}),
      };
    }),
  );
}

async function loadFixtures(): Promise<Record<string, Extraction>> {
  const parsed = JSON.parse(await readFile(FIXTURES_FILE, "utf8")) as {
    extractions: Record<string, Extraction>;
  };
  return parsed.extractions;
}

export interface PhotoRef {
  /** The filename the merchant's phone gave it — a loose hint, and a real one. */
  filename?: string;
  /** Whether that file is actually on disk. Without it, Stage 1 runs text-only. */
  present: boolean;
}

export interface StructuringResult {
  items: CatalogItem[];
  records: ExtractionRecord[];
  provider: "claude" | "fixture";
  photosUsed: number;
  /** item_id → the photo it came from, for display. */
  photos: Record<string, PhotoRef>;
}

/**
 * Run Stage 1 over every sample product.
 *
 * `live` calls the model; without it (or without credentials) the hand-authored
 * fixtures stand in. The two paths converge on the same projection and the same
 * gate, so what the gate does is identical either way — only the confidence
 * numbers differ in where they came from.
 */
export async function runStructuring(live: boolean): Promise<StructuringResult> {
  const raws = await loadRawProducts();
  const useLive = live && hasCredentials();

  let records: ExtractionRecord[];
  if (useLive) {
    const client = new Anthropic();
    records = [];
    for (const raw of raws) {
      records.push(await extractWithClaude(raw, client));
    }
  } else {
    const fixtures = await loadFixtures();
    records = await Promise.all(raws.map((raw) => extractFromFixture(raw, fixtures)));
  }

  const items = raws.map((raw, i) => toCatalogItem(raw, records[i]!, i));

  const photos: Record<string, PhotoRef> = {};
  for (const [i, raw] of raws.entries()) {
    photos[items[i]!.item_id] = {
      ...(raw.photo_filename ? { filename: raw.photo_filename } : {}),
      present: Boolean(raw.photo_path),
    };
  }

  return {
    items,
    records,
    provider: useLive ? "claude" : "fixture",
    photosUsed: raws.filter((r) => r.photo_path).length,
    photos,
  };
}

export async function writeCatalog(result: StructuringResult): Promise<string> {
  const doc = {
    generated_at: new Date().toISOString(),
    provider: result.provider,
    ...(result.provider === "fixture"
      ? { warning: "Confidence values come from hand-authored fixtures, not a live model call." }
      : {}),
    photos: result.photos,
    items: result.items,
  };
  await writeFile(CATALOG_FILE, JSON.stringify(doc, null, 2) + "\n");
  return CATALOG_FILE;
}

interface CatalogDoc {
  provider: "claude" | "fixture";
  photos?: Record<string, PhotoRef>;
  items: CatalogItem[];
}

export async function readCatalog(): Promise<CatalogItem[]> {
  const doc = JSON.parse(await readFile(CATALOG_FILE, "utf8")) as CatalogDoc;
  return doc.items;
}

/**
 * What the server serves.
 *
 * Extraction is a paid model call over five photos; doing it on every boot would
 * be slow and would spend money to produce the same catalog each time. So a
 * catalog written by `milestone-b --live` is reused if present, and fixtures
 * stand in otherwise. That also makes the live path a deliberate act with a
 * durable result, rather than something that silently happens at startup.
 */
export async function loadServingCatalog(): Promise<StructuringResult> {
  if (await exists(CATALOG_FILE)) {
    const doc = JSON.parse(await readFile(CATALOG_FILE, "utf8")) as CatalogDoc;
    if (doc.items?.length) {
      return {
        items: doc.items,
        records: [],
        provider: doc.provider ?? "fixture",
        photosUsed: Object.values(doc.photos ?? {}).filter((p) => p.present).length,
        photos: doc.photos ?? {},
      };
    }
  }
  return runStructuring(false);
}
