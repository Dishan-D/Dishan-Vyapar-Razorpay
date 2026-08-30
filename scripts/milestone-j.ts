/**
 * Milestone J — readiness score and marketplace comparison.
 *
 *   npm run milestone-j
 *
 * Definition of done: one buyer intent against all three personas produces
 * independent negotiation logs plus one justified selection.
 */
import type { Server } from "node:http";
import { createApp } from "../src/server.js";
import { SimulatedGateway } from "../src/payments/gateway.js";
import { seedHistory } from "../src/demo/seed.js";

const g = (s: string) => `\x1b[32m${s}\x1b[0m`;
const r = (s: string) => `\x1b[31m${s}\x1b[0m`;
const y = (s: string) => `\x1b[33m${s}\x1b[0m`;
const c = (s: string) => `\x1b[36m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

function heading(t: string): void {
  console.log(`\n${bold(t)}\n${dim("─".repeat(t.length))}`);
}

const bar = (v: number): string => "█".repeat(Math.round(v * 12)).padEnd(12, "·");

async function main(): Promise<void> {
  console.log(bold("\nVyapar-to-Agent · Milestone J — readiness and marketplace"));

  const { app, store } = await createApp({ gateway: new SimulatedGateway() });
  const server: Server = await new Promise((res) => {
    const s = app.listen(0, () => res(s));
  });
  const port = (server.address() as { port: number }).port;
  const api = async (p: string, init?: RequestInit) => {
    const res = await fetch(`http://localhost:${port}${p}`, {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    });
    return { status: res.status, body: (await res.json()) as any };
  };

  try {
    heading("Seeding trading history");
    const outcomes = await seedHistory(api);
    console.log(`  ${outcomes.filter((o) => o.status !== "not_found" && o.status !== "no_deal").length} sales recorded`);

    // ── J.1 ─────────────────────────────────────────────────────────────────
    heading("Agent Readiness Score");
    const { body: ms } = await api("/merchants");
    for (const m of ms.merchants) {
      const rd = m.readiness;
      console.log(`\n  ${bold(m.name.padEnd(26))} ${bold(String(rd.score).padStart(3))}/100  ${dim(m.city)}`);
      console.log(`     ${dim("catalog confidence  ")} ${bar(rd.components.catalog_confidence)} ${dim(`${Math.round(rd.components.catalog_confidence * 100)}%`)}`);
      console.log(`     ${dim("policy coverage     ")} ${bar(rd.components.policy_coverage)} ${dim(`${Math.round(rd.components.policy_coverage * 100)}%`)}`);
      console.log(`     ${dim("fulfillment record  ")} ${bar(rd.components.fulfillment_reliability)} ${dim(`${Math.round(rd.components.fulfillment_reliability * 100)}%  (${rd.basis.sales_confirmed}/${rd.basis.sales_paid} confirmed)`)}`);
      console.log(`     ${dim(rd.explanation)}`);
    }
    console.log(`\n  ${dim("Equal weighting, stated rather than hidden — there is no evidence here")}`);
    console.log(`  ${dim("about which of the three matters most, and inventing weights would")}`);
    console.log(`  ${dim("dress a guess up as precision.")}`);

    // ── J.2 ─────────────────────────────────────────────────────────────────
    heading("One intent, every merchant");
    const want = "silicone phone case";
    console.log(`  ${dim("buyer-agent wants:")} "${want}" ${dim("· ceiling ₹320 · opens at ₹220")}`);

    const { body: cmp } = await api("/marketplace/compare", {
      method: "POST",
      body: JSON.stringify({ want, max_price: 320, opening_offer: 220 }),
    });

    for (const o of cmp.offers) {
      const sel = cmp.selected?.merchant_id === o.merchant_id;
      console.log(`\n  ${sel ? g("▸ SELECTED") : dim("  considered")}  ${bold(o.merchant_name)} ${dim(`readiness ${o.readiness.score}`)}`);
      console.log(`     ${dim(o.item_name)} ${dim(`list ₹${o.list_price}`)}`);
      for (const t of o.outcome.log) {
        const who = t.actor === "buyer" ? c("buyer   ") : y("merchant");
        console.log(`     ${dim(`r${t.round}`)} ${who} ${dim(t.rationale)} ${t.amount ? bold(`₹${t.amount}`) : ""}`);
      }
      console.log(
        `     ${o.eligible ? g(`₹${o.final_price}`) : r("no deal")}` +
          (o.eligible ? `  ${dim(`→ ₹${o.effective_price} once adjusted for a ${o.readiness.score}/100 record`)}` : `  ${dim(o.note)}`),
      );
    }

    heading("Why that one");
    for (const line of cmp.reasoning) console.log(`  ${dim("·")} ${line}`);

    const independent = cmp.offers.filter((o: any) => o.outcome.log.length > 0).length;
    heading("Milestone J — definition of done");
    console.log(`  ${ms.merchants.every((m: any) => m.readiness.score > 0) ? g("✅") : r("❌")} every merchant scored from data already held`);
    console.log(`  ${independent >= 2 ? g("✅") : r("❌")} independent negotiation logs per merchant: ${independent}`);
    console.log(`  ${cmp.selected ? g("✅") : r("❌")} one selection, with the losing offers kept for inspection`);
    console.log(`  ${cmp.reasoning.length > 1 ? g("✅") : r("❌")} the choice is justified in the response, not just made`);
    console.log();

    if (independent < 2 || !cmp.selected) process.exitCode = 1;
  } finally {
    server.close();
    store.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
