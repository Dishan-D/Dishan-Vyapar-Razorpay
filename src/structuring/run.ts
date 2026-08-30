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

export interface StructuringResult {
  items: CatalogItem[];
  records: ExtractionRecord[];
  provider: "claude" | "fixture";
  photosUsed: number;
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
  return {
    items,
    records,
    provider: useLive ? "claude" : "fixture",
    photosUsed: raws.filter((r) => r.photo_path).length,
  };
}

export async function writeCatalog(result: StructuringResult): Promise<string> {
  const doc = {
    generated_at: new Date().toISOString(),
    provider: result.provider,
    ...(result.provider === "fixture"
      ? { warning: "Confidence values come from hand-authored fixtures, not a live model call." }
      : {}),
    items: result.items,
  };
  await writeFile(CATALOG_FILE, JSON.stringify(doc, null, 2) + "\n");
  return CATALOG_FILE;
}

export async function readCatalog(): Promise<CatalogItem[]> {
  const doc = JSON.parse(await readFile(CATALOG_FILE, "utf8")) as { items: CatalogItem[] };
  return doc.items;
}
