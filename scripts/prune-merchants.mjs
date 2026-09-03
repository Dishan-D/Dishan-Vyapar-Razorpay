/**
 * Remove shops onboarded during testing, keeping the six the demo ships with.
 *
 * Rehearsing the onboarding flow leaves a real shop behind every time, and
 * after an afternoon of it the merchant picker lists eleven stores — five of
 * them called some variation of "Dishan's Electronic store". That is a demo
 * telling the audience, accurately, that somebody has been practising.
 *
 * Deliberately narrow. It removes a merchant only when that merchant has **no
 * transactions at all**: a shop somebody onboarded and then sold something from
 * has signed mandate chains behind it, and deleting the shop would leave those
 * chains pointing at a merchant that no longer exists — which the integrity
 * check would report as a fault, correctly. Such a shop is listed and skipped
 * rather than removed quietly.
 *
 *   node scripts/prune-merchants.mjs           # report only, change nothing
 *   node scripts/prune-merchants.mjs --apply   # remove them
 */

import Database from "better-sqlite3";
import path from "node:path";

/** The shops the demo ships with. Everything else is a rehearsal artefact. */
const KEEP = new Set([
  "mer_hazel",       // Sri Balaji Bakery
  "mer_atelier",     // New Krishna Sweets
  "mer_ovenroom",    // Anand Bake House
  "mer_northstar",   // Ganesh Tea & Coffee
  "mer_urbanloom",   // Lakshmi Cloth Store
  "mer_studioscent", // Deepa Home Needs
]);

const apply = process.argv.includes("--apply");
const db = new Database(path.resolve("data", "vyapar.db"));

const merchants = db
  .prepare(`SELECT merchant_id, json FROM onboarded_merchants ORDER BY created_at`)
  .all();

const countFor = (table, id) =>
  db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE merchant_id = ?`).get(id).c;

const doomed = [];
const spared = [];

for (const row of merchants) {
  if (KEEP.has(row.merchant_id)) continue;

  const name = JSON.parse(row.json).name ?? row.merchant_id;
  const txns = countFor("transactions", row.merchant_id);
  const target = {
    merchant_id: row.merchant_id,
    name,
    txns,
    items: countFor("onboarded_items", row.merchant_id),
    inputs: countFor("onboarded_inputs", row.merchant_id),
  };

  // A shop with signed chains behind it is not a rehearsal artefact any more.
  (txns > 0 ? spared : doomed).push(target);
}

console.log();
if (doomed.length === 0 && spared.length === 0) {
  console.log("  Only the six demo shops are present. Nothing to prune.\n");
  process.exit(0);
}

for (const t of doomed) {
  console.log(
    `  ${apply ? "removing" : "would remove"}  ${t.merchant_id.padEnd(16)} ${String(t.name).padEnd(26)} ` +
      `${String(t.items).padStart(2)} item(s), ${t.inputs} input(s)`,
  );
}
for (const t of spared) {
  console.log(
    `  KEEPING     ${t.merchant_id.padEnd(16)} ${String(t.name).padEnd(26)} ` +
      `has ${t.txns} transaction(s) — signed chains reference it`,
  );
}

if (!apply) {
  console.log(`\n  Nothing changed. Re-run with --apply to remove ${doomed.length} shop(s).\n`);
  process.exit(0);
}

const remove = db.transaction((targets) => {
  let items = 0;
  let inputs = 0;
  for (const t of targets) {
    // The item rows go, and so do any tombstones for them — a deleted product
    // belonging to a deleted shop is not a fact worth keeping.
    const ids = db
      .prepare(`SELECT item_id FROM onboarded_items WHERE merchant_id = ?`)
      .all(t.merchant_id)
      .map((r) => r.item_id);
    for (const id of ids) db.prepare(`DELETE FROM deleted_items WHERE item_id = ?`).run(id);

    items += db.prepare(`DELETE FROM onboarded_items WHERE merchant_id = ?`).run(t.merchant_id).changes;
    inputs += db.prepare(`DELETE FROM onboarded_inputs WHERE merchant_id = ?`).run(t.merchant_id).changes;
    db.prepare(`DELETE FROM onboarded_merchants WHERE merchant_id = ?`).run(t.merchant_id);
  }
  return { items, inputs };
});

const { items, inputs } = remove(doomed);
console.log(
  `\n  Removed ${doomed.length} shop(s), ${items} product(s), ${inputs} stored input(s).` +
    `\n  Restart the server so the in-memory catalog reloads.\n`,
);
