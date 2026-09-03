/**
 * Six months of trading history for the demo shops.
 *
 * Run once against a fresh database, or again to replace what it wrote:
 *
 *   npx tsx scripts/seed-history.ts            # generate
 *   npx tsx scripts/seed-history.ts --dry      # report what it would do
 *   npx tsx scripts/seed-history.ts --clear    # remove what it wrote, keep the rest
 *   npx tsx scripts/seed-history.ts --fresh    # also remove rehearsal transactions
 *
 * What comes out is **signed**. Every order runs through the production
 * negotiation engine and becomes four ES256 mandates with backdated timestamps,
 * so the merchant screens read it exactly as they read a sale from ten minutes
 * ago — there is no second path into the analytics and no synthetic table
 * beside the real one.
 *
 * Deterministic: the same database every time, because a demo whose numbers
 * move between the rehearsal and the room is worse than no demo.
 */

import Database from "better-sqlite3";
import { Store, DB_FILE } from "../src/db/store.js";
import { loadOrCreateKeyring } from "../src/mandates/keystore.js";
import { loadServingCatalog } from "../src/structuring/run.js";
import { indexPolicies } from "../src/negotiation/policies.js";
import { generateHistory, persistOrder } from "../src/demo/history.js";
import { STORIES } from "../src/demo/stories.js";
import { OnboardingStore } from "../src/onboarding/store.js";

const dry = process.argv.includes("--dry");
const fresh = process.argv.includes("--fresh");
const clear = process.argv.includes("--clear") || fresh;

/** Everything this script wrote carries the marker, so it can be undone. */
const MARK = "txn_h";

const money = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;
const bar = (n: number, max: number, width = 22) =>
  "█".repeat(Math.max(0, Math.round((n / Math.max(1, max)) * width)));

async function main(): Promise<void> {
  const store = new Store();
  const raw = new Database(DB_FILE);

  if (clear) {
    const t = raw.prepare(`DELETE FROM mandates WHERE transaction_id LIKE ?`).run(`${MARK}%`);
    const x = raw.prepare(`DELETE FROM attributions WHERE transaction_id LIKE ?`).run(`${MARK}%`);
    const y = raw.prepare(`DELETE FROM transactions WHERE transaction_id LIKE ?`).run(`${MARK}%`);
    console.log(`\n  removed ${y.changes} generated order(s), ${t.changes} mandate(s), ${x.changes} attribution(s)`);

    /**
     * `--fresh` also clears what rehearsing left behind.
     *
     * Every practice run of the buyer demo writes a real transaction into a
     * real shop, and after an afternoon of them the demo shop's week reads
     * +109% — true, and the opposite of the story it is supposed to tell. These
     * are genuine signed chains, so removing them is destructive and is behind
     * its own flag rather than folded into `--clear`.
     *
     * Only for the six seeded demo shops. A shop somebody onboarded during a
     * demo has a real history and this must not touch it.
     */
    if (fresh) {
      const shops = STORIES.map((x) => x.merchant_id);
      const holes = shops.map(() => "?").join(",");
      const doomed = raw
        .prepare(`SELECT transaction_id FROM transactions WHERE merchant_id IN (${holes})`)
        .all(...shops) as Array<{ transaction_id: string }>;
      if (doomed.length > 0) {
        const ids = doomed.map((d) => d.transaction_id);
        const q = ids.map(() => "?").join(",");
        raw.prepare(`DELETE FROM mandates WHERE transaction_id IN (${q})`).run(...ids);
        raw.prepare(`DELETE FROM attributions WHERE transaction_id IN (${q})`).run(...ids);
        raw.prepare(`DELETE FROM orders WHERE transaction_id IN (${q})`).run(...ids);
        raw.prepare(`DELETE FROM transactions WHERE transaction_id IN (${q})`).run(...ids);
      }
      console.log(`  --fresh: also removed ${doomed.length} rehearsal order(s) from the demo shops`);
    }
    console.log();
    return;
  }

  const already = raw.prepare(`SELECT COUNT(*) AS n FROM transactions WHERE transaction_id LIKE ?`).get(`${MARK}%`) as { n: number };
  if (already.n > 0 && !dry) {
    console.log(`\n  ${already.n} generated order(s) are already here. Run with --clear first to replace them.\n`);
    return;
  }

  console.log(`\n  Reading the catalog…`);
  // The same loader the server boots from, so the products, prices and floors
  // this history is generated against are exactly the ones it will be read
  // beside. Re-extracting from fixtures would risk a subtly different catalog.
  const structuring = await loadServingCatalog();

  /**
   * The catalog the server actually serves, not the one on disk.
   *
   * A product the shopkeeper deleted leaves a tombstone, and the server drops
   * it on the way out — but `loadServingCatalog` returns the fixture, which
   * still has it. The first run of this generator happily sold `itm_loom_006`
   * two thousand times to a shop that no longer stocks it, and the integrity
   * check found every one. Selling a product that does not exist is exactly
   * the kind of quiet nonsense synthetic data is prone to.
   */
  const onboarding = new OnboardingStore(raw);
  const gone = new Set(onboarding.listDeleted());
  const edited = new Map(onboarding.listItems().map((r) => [r.item.item_id, r.item]));
  const items = structuring.items
    .filter((i) => !gone.has(i.item_id))
    // A merchant's own edit outranks the fixture here for the same reason it
    // does on the server: prices they corrected are the prices to sell at.
    .map((i) => edited.get(i.item_id) ?? i);
  if (gone.size > 0) console.log(`  (skipping ${gone.size} deleted product(s))`);
  const policies = indexPolicies(structuring.policies);
  const keyring = await loadOrCreateKeyring();

  console.log(`  ${items.length} products across ${new Set(items.map((i) => i.merchant_id)).size} shops\n`);

  let totalOrders = 0;
  let totalRevenue = 0;
  const started = Date.now();

  for (const s of STORIES) {
    const result = await generateHistory({
      merchantId: s.merchant_id,
      items,
      policies,
      keyring,
      windowDays: 182,
    });
    if (!result) {
      console.log(`  ⚠ ${s.merchant_id}: nothing sellable, skipped`);
      continue;
    }

    const paid = result.orders.filter((o) => o.paid);
    const revenue = paid.reduce((sum, o) => sum + o.price, 0);
    const unpaid = result.orders.length - paid.length;
    const owed = result.orders.filter((o) => !o.paid).reduce((sum, o) => sum + o.price, 0);
    const people = new Set(result.orders.map((o) => o.buyer_agent_id)).size;

    console.log(`  ${s.merchant_id.padEnd(16)} ${s.kind}`);
    console.log(`    ${result.headline}`);
    console.log(
      `    ${result.orders.length} orders · ${money(revenue)} taken · ${unpaid} unpaid (${money(owed)}) · ` +
        `${people} buyers · ${result.noDeal} walked on price`,
    );

    // The six-month shape, so a glance says whether the story landed.
    const months = new Array(6).fill(0);
    const oldest = Math.min(...result.orders.map((o) => o.at.getTime()));
    for (const o of paid) {
      const idx = Math.min(5, Math.floor(((o.at.getTime() - oldest) / (182 * 86_400_000)) * 6));
      months[idx] += o.price;
    }
    const peak = Math.max(...months);
    console.log(`    ${months.map((m) => money(m).padStart(8)).join(" ")}`);
    console.log(`    ${months.map((m) => bar(m, peak, 8).padEnd(8)).join(" ")}\n`);

    if (dry) continue;

    for (const order of result.orders) {
      const item = items.find((i) => i.item_id === order.item_id);
      if (!item) continue;
      await persistOrder(order, item, keyring, store as never);
    }
    totalOrders += result.orders.length;
    totalRevenue += revenue;
  }

  console.log(
    dry
      ? `  --dry: nothing written.\n`
      : `  ${totalOrders} orders written · ${money(totalRevenue)} of history · ${((Date.now() - started) / 1000).toFixed(1)}s\n`,
  );
}

main().catch((err) => {
  console.error(`\n  Could not seed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
