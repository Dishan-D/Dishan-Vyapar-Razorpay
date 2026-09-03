/**
 * Put the shelves back the way the demo expects them.
 *
 * Stock is real now — a paid sale takes the unit off the shelf and the change
 * survives a restart — which is correct and makes rehearsing a demo destructive.
 * Buy the same cake five times and the sixth attempt honestly answers "out of
 * stock", usually about ninety seconds before you present.
 *
 * This restocks through the merchant's own edit endpoint rather than writing to
 * the database, so it does exactly what a shopkeeper receiving a delivery does,
 * and nothing here can put the catalog into a state the product could not reach
 * on its own. Past transactions are left alone: the revenue and the ledger stay
 * true, only the shelf is refilled.
 *
 *   node scripts/demo-reset.mjs            # restock anything below its target
 *   node scripts/demo-reset.mjs --status   # say what is low, change nothing
 */

const BASE = process.env.BASE ?? "http://localhost:3000";
const statusOnly = process.argv.includes("--status");

/**
 * The floor each demo product should start from.
 *
 * Only the items the scripted flow actually touches, and only a floor — a shelf
 * with more than this is left alone, because a number that was deliberately set
 * to something is not ours to overwrite.
 */
const TARGETS = {
  itm_hazel_001: 5,   // Chocolate Cake 500g   — the headline comparison
  itm_hazel_002: 4,   // Chocolate Cake 1kg    — the upsell
  itm_hazel_003: 9,   // Red Velvet Cake 1kg   — the upsell that wins
  itm_hazel_008: 12,  // Cupcake Box           — cross-sell
  itm_hazel_009: 40,  // Birthday Candle Set   — cross-sell
  itm_atelier_001: 8, // Chocolate Truffle Cake — the mid-priced rival
  itm_oven_001: 3,    // Premium Chocolate Cake — the shop whose floor is too high
};

const rupee = (n) => `₹${Number(n).toLocaleString("en-IN")}`;

async function main() {
  const res = await fetch(`${BASE}/catalog`);
  if (!res.ok) throw new Error(`GET /catalog → ${res.status}`);
  const { items } = await res.json();

  const rows = items.filter((i) => i.item_id in TARGETS);
  const low = rows.filter((i) => i.stock.quantity < TARGETS[i.item_id]);

  if (rows.length === 0) {
    console.log("\nNone of the demo products are in this catalog. Seed it first.\n");
    return;
  }

  console.log();
  for (const i of rows) {
    const want = TARGETS[i.item_id];
    const short = i.stock.quantity < want;
    console.log(
      `  ${short ? "↑" : "·"} ${i.name.padEnd(28)} ${String(i.stock.quantity).padStart(3)} on the shelf` +
        (short ? `  → restocking to ${want}` : `  (target ${want}, fine)`),
    );
  }

  if (statusOnly || low.length === 0) {
    console.log(low.length === 0 ? "\nEvery demo product is stocked.\n" : "\nNothing changed (--status).\n");
    return;
  }

  for (const i of low) {
    const r = await fetch(`${BASE}/merchants/${i.merchant_id}/items/${i.item_id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stock: TARGETS[i.item_id] }),
    });
    if (!r.ok) console.log(`  ✗ ${i.name}: ${r.status} ${(await r.text()).slice(0, 90)}`);
  }

  // Say what the shelf looks like now, from the server rather than from what we
  // just sent it.
  const after = (await (await fetch(`${BASE}/catalog`)).json()).items;
  const value = after
    .filter((i) => i.item_id in TARGETS)
    .reduce((s, i) => s + i.stock.quantity * i.price.value, 0);
  console.log(`\n  ${low.length} restocked · demo shelf now holds ${rupee(value)} of goods\n`);
}

main().catch((err) => {
  console.error(`\nCould not reset: ${err.message}`);
  console.error(`Is the server up at ${BASE}?  npm run serve\n`);
  process.exit(1);
});
