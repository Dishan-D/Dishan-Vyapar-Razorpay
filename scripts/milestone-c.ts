/**
 * Milestone C — discovery and bounded negotiation.
 *
 *   npm run milestone-c            # deterministic phrasing, no API key needed
 *   npm run milestone-c -- --live  # Claude phrases the turns (numbers stay deterministic)
 *
 * Definition of done: three cases — instant accept above the floor, agreement
 * reached within max_rounds, and a graceful no_deal — all logged, none crashing.
 */
import { discover } from "../src/catalog/discovery.js";
import { negotiate, type BuyerMandate, type NegotiationOutcome } from "../src/negotiation/engine.js";
import { phraseTurns, templateLine } from "../src/negotiation/phrasing.js";
import { indexPolicies } from "../src/negotiation/policies.js";
import { hasCredentials } from "../src/structuring/extract.js";
import { activeProvider, providerLabel } from "../src/llm/provider.js";
import { runStructuring, writeCatalog } from "../src/structuring/run.js";
import type { CatalogItem, NegotiationPolicy } from "../src/mandates/schema.js";

const g = (s: string) => `\x1b[32m${s}\x1b[0m`;
const r = (s: string) => `\x1b[31m${s}\x1b[0m`;
const y = (s: string) => `\x1b[33m${s}\x1b[0m`;
const c = (s: string) => `\x1b[36m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

function heading(text: string): void {
  console.log(`\n${bold(text)}\n${dim("─".repeat(text.length))}`);
}

async function runCase(
  label: string,
  expect: "agreed" | "no_deal",
  item: CatalogItem,
  policy: NegotiationPolicy,
  buyer: BuyerMandate,
  live: boolean,
): Promise<boolean> {
  console.log(`\n  ${bold(label)}`);
  console.log(
    `  ${dim(`item ${item.item_id} · list ₹${policy.list_price} · floor ₹${policy.floor_price} · ` +
      `max ${policy.max_rounds} rounds · buyer opens ₹${buyer.opening_offer}, authorized to ₹${buyer.max_price}`)}`,
  );

  let outcome: NegotiationOutcome;
  try {
    outcome = negotiate(item, policy, buyer);
  } catch (err) {
    console.log(`  ${r("crashed:")} ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }

  const lines = live ? await phraseTurns(item, outcome.log) : outcome.log.map(templateLine);

  for (const [i, turn] of outcome.log.entries()) {
    const who = turn.actor === "buyer" ? c("buyer   ") : y("merchant");
    console.log(`    ${dim(`r${turn.round}`)} ${who} ${lines[i]}`);
    console.log(`         ${dim(turn.rationale)}`);
  }

  const ok = outcome.status === expect;
  if (outcome.status === "agreed") {
    console.log(`  ${ok ? g("✅") : r("❌")} agreed at ${bold(`₹${outcome.final_price}`)} in ${outcome.rounds} round(s)`);
  } else {
    console.log(`  ${ok ? g("✅") : r("❌")} no deal — ${outcome.reason}`);
  }
  if (!ok) console.log(`     ${r(`expected ${expect}, got ${outcome.status}`)}`);
  return ok;
}

async function main(): Promise<void> {
  const live = process.argv.includes("--live");
  console.log(bold("\nVyapar-to-Agent · Milestone C — discovery and negotiation"));

  if (live && hasCredentials()) {
    console.log(`  ${dim("phrasing via")} ${providerLabel(activeProvider())}`);
  }
  const structuring = await runStructuring(live);
  await writeCatalog(structuring);
  const policies = indexPolicies(structuring.policies);
  const catalog = structuring.items;


  if (live && !hasCredentials()) {
    console.log(`\n  ${y("--live requested but no model credentials found")} ${dim("— using deterministic phrasing")}`);
  }

  // ── Stage 2 ───────────────────────────────────────────────────────────────
  heading("Discovery");
  const query = { want: "blue cotton saree", max_price: 1500 };
  console.log(`  ${dim("query:")} ${JSON.stringify(query)}`);
  const found = discover(catalog, query);

  for (const m of found.matches) {
    console.log(
      `  ${g("→")} ${bold(m.item.item_id)} ${m.item.name} ${dim(`₹${m.item.price.value}`)}` +
        ` ${dim(`match ${(m.score * 100).toFixed(0)}% on ${m.matched_terms.join(", ")}`)}`,
    );
  }
  for (const w of found.withheld) {
    console.log(`  ${r("×")} ${w.item.item_id} ${w.item.name} ${dim(`withheld — ${w.reason}`)}`);
  }
  if (found.matches.length === 0) {
    console.log(`  ${r("no offerable matches")}`);
    process.exitCode = 1;
    return;
  }

  // A second query, aimed at an item the gate is holding — the withheld path is
  // the one that has to visibly work, not just the happy path.
  const heldQuery = { want: "silk dupatta", max_price: 1500 };
  console.log(`\n  ${dim("query:")} ${JSON.stringify(heldQuery)}`);
  const heldFound = discover(catalog, heldQuery);
  for (const m of heldFound.matches) {
    console.log(`  ${g("→")} ${bold(m.item.item_id)} ${m.item.name} ${dim(`₹${m.item.price.value}`)}`);
  }
  for (const w of heldFound.withheld) {
    console.log(`  ${r("×")} ${w.item.item_id} ${w.item.name} ${dim(`withheld — ${w.reason}`)}`);
  }

  const item = found.matches[0]!.item;
  const policy = policies.get(item.item_id);
  if (!policy) {
    console.log(`  ${r(`no negotiation policy set for ${item.item_id}`)}`);
    process.exitCode = 1;
    return;
  }

  // ── Stage 3, three cases ──────────────────────────────────────────────────
  heading("Negotiation");
  const agentId = "agent_xyz";
  const byId = new Map(catalog.map((i) => [i.item_id, i]));

  /** Each case picks the merchant whose policy actually exercises it. */
  const cases: Array<{
    label: string;
    expect: "agreed" | "no_deal";
    item_id: string;
    max_price: number;
    opening_offer: number;
  }> = [
    {
      label: "Case 1 — buyer opens above the floor (Meena, tight band)",
      expect: "agreed",
      item_id: "itm_meena_001",
      max_price: 1500,
      opening_offer: 1100,
    },
    {
      // Rafiq's persona is the wide negotiation band — five rounds and a floor
      // well under list. Meena's two-round policy cannot converge from a lowball
      // by design, so running this case against her would be testing the wrong
      // merchant, not finding a bug.
      label: "Case 2 — buyer lowballs, converges within max_rounds (Rafiq, wide band)",
      expect: "agreed",
      item_id: "itm_rafiq_002",
      max_price: 500,
      opening_offer: 200,
    },
    {
      label: "Case 3 — buyer's ceiling is below the floor, rounds run out",
      expect: "no_deal",
      item_id: "itm_meena_001",
      max_price: 900,
      opening_offer: 800,
    },
    {
      label: "Case 4 — buyer already at its ceiling, walks away early",
      expect: "no_deal",
      item_id: "itm_meena_001",
      max_price: 850,
      opening_offer: 850,
    },
  ];

  const results: boolean[] = [];
  for (const c of cases) {
    const target = byId.get(c.item_id);
    const targetPolicy = policies.get(c.item_id);
    if (!target || !targetPolicy) {
      console.log(`  ${r(`missing item or policy for ${c.item_id}`)}`);
      results.push(false);
      continue;
    }
    results.push(
      await runCase(c.label, c.expect, target, targetPolicy, {
        buyer_agent_id: agentId,
        max_price: c.max_price,
        opening_offer: c.opening_offer,
      }, live),
    );
  }

  // ── The Stage 1 gate still holds here ─────────────────────────────────────
  heading("Gate still applies at Stage 3");
  const held = catalog.find((i) => i.needs_merchant_confirmation);
  let gateHeld = false;
  if (held) {
    try {
      negotiate(held, { ...policies.values().next().value!, item_id: held.item_id }, {
        buyer_agent_id: agentId,
        max_price: 5000,
        opening_offer: 5000,
      });
      console.log(`  ${r("❌ negotiated over an unconfirmed item — the gate leaked")}`);
    } catch (err) {
      gateHeld = true;
      console.log(`  ${g("✅ refused")} ${dim(err instanceof Error ? err.message : String(err))}`);
    }
  }

  heading("Milestone C — definition of done");
  const passed = results.filter(Boolean).length;
  console.log(`  ${passed === results.length ? g("✅") : r("❌")} negotiation cases: ${passed}/${results.length}`);
  console.log(`  ${heldFound.withheld.length > 0 ? g("✅") : r("❌")} unconfirmed items withheld from discovery: ${heldFound.withheld.length}`);
  console.log(`  ${gateHeld ? g("✅") : r("❌")} Stage 1 gate refuses negotiation on unconfirmed items`);
  console.log();

  if (passed !== results.length || !gateHeld || heldFound.withheld.length === 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
