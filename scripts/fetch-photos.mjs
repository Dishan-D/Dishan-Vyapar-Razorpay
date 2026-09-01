/**
 * Fetch one generic photo per product that has none.
 *
 * These are real photographs, keyword-matched to the product, pulled from
 * loremflickr (Creative Commons images from Flickr) and saved locally so the
 * demo does not depend on the network at show time.
 *
 * They are illustrative and the data says so. A photo in this catalog normally
 * asserts "this is the thing this shop has"; a stock photo of a cake is not
 * Sri Balaji Bakery's cake. So every row fetched here is flagged
 * `photo_is_illustrative`, the merchant's own catalog screen says "stock photo
 * — replace with your own", and the moment a shopkeeper uploads a real picture
 * it takes precedence. The storefront looks like a shop; the provenance stays
 * honest underneath.
 */
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const DIR = "data/sample_products/generic";
await mkdir(DIR, { recursive: true });

const catalog = JSON.parse(await readFile("data/catalog.json", "utf8"));

/** A search term a photo library will actually have pictures of. */
function keyword(item) {
  const tags = item.tags ?? [];
  // Some obvious words return 500 from the library — "shirt", "candle" and
  // "gift" all do, consistently rather than transiently. Mapped to a term that
  // actually has pictures behind it rather than left to fail.
  const SUBSTITUTE = { shirt: "menswear", candle: "aromatherapy", gift: "giftbox", clothing: "apparel" };
  const byTag = tags.find((t) =>
    ["cake", "coffee", "candle", "shirt", "muffin", "cookie", "pastry", "bread",
     "cupcake", "tote", "belt", "chinos", "trousers", "diffuser", "sweets"].includes(t));
  if (byTag) return SUBSTITUTE[byTag] ?? byTag;
  // Otherwise the product's own words, minus sizes and packaging noise.
  const n = item.name.toLowerCase()
    .replace(/\d+\s*(g|kg|ml|l|pcs|pieces|pack)\b/g, " ")
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/).filter((w) => w.length > 2 && !["set","box","the","and","with"].includes(w));
  const word = n.slice(0, 2).join("") || "product";
  return SUBSTITUTE[word] ?? word;
}

let got = 0, skipped = 0, failed = 0;
for (const item of catalog.items) {
  const dest = `${DIR}/${item.item_id}.jpg`;
  if (existsSync(dest)) { skipped++; continue; }
  const kw = keyword(item);
  // The lock keeps one product on one photo across runs, so a demo looks the
  // same twice and a judge is not shown a different cake on a reload.
  const lock = Math.abs([...item.item_id].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7)) % 900 + 1;
  const url = `https://loremflickr.com/640/480/${encodeURIComponent(kw)}?lock=${lock}`;
  try {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 2000) throw new Error(`suspiciously small (${buf.length}B)`);
    await writeFile(dest, buf);
    got++;
    console.log(`  ✓ ${item.item_id.padEnd(20)} ${kw.padEnd(12)} ${(buf.length / 1024).toFixed(0)}KB  ${item.name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${item.item_id.padEnd(20)} ${kw.padEnd(12)} ${err.message}`);
  }
}
console.log(`\n  ${got} fetched · ${skipped} already had one · ${failed} failed`);
