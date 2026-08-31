/**
 * Milestone H — Verified Commerce History.
 *
 *   npm run milestone-h
 *
 * Definition of done: a correctly aggregated, correctly signed report; tampering
 * with one field and re-verifying fails, same as the mandate tamper tests.
 */
import type { Server } from "node:http";
import { createApp } from "../src/server.js";
import { SimulatedGateway } from "../src/payments/gateway.js";
import { verifyCommerceHistory } from "../src/audit/history.js";
import { seedHistory } from "../src/demo/seed.js";

const g = (s: string) => `\x1b[32m${s}\x1b[0m`;
const r = (s: string) => `\x1b[31m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

function heading(t: string): void {
  console.log(`\n${bold(t)}\n${dim("─".repeat(t.length))}`);
}

async function main(): Promise<void> {
  console.log(bold("\nVyapar-to-Agent · Milestone H — Verified Commerce History"));

  const { app, store, keyring } = await createApp({ gateway: new SimulatedGateway() });
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
    heading("Seeding a month of trade");
    const outcomes = await seedHistory(api);
    for (const m of ["mer_meena", "mer_rafiq", "mer_amma"]) {
      const mine = outcomes.filter((o) => o.merchant_id === m);
      const f = mine.filter((o) => o.status === "fulfilled").length;
      const p = mine.filter((o) => o.status === "paid").length;
      console.log(`  ${m.padEnd(11)} ${mine.length} sales · ${g(`${f} confirmed`)}${p ? ` · ${r(`${p} unconfirmed`)}` : ""}`);
    }

    heading("GET /merchants/mer_meena/commerce-history");
    const { body: meena } = await api("/merchants/mer_meena/commerce-history");
    const show = (rep: any) => {
      console.log(`  ${bold(rep.merchant_name)} ${dim(`${rep.period.from} → ${rep.period.to}`)}`);
      console.log(`     ${dim("completed (delivered):")} ${rep.completed_transactions}   ${dim("paid:")} ${rep.paid_transactions}`);
      console.log(`     ${dim("verified value:")} ₹${rep.total_verified_value}`);
      console.log(`     ${dim("fulfillment confirmation rate:")} ${(rep.fulfillment_confirmation_rate * 100).toFixed(0)}%`);
      console.log(`     ${dim("avg negotiated discount:")} ${rep.negotiation_avg_discount_pct ?? "—"}%`);
      console.log(`     ${dim("report hash:")} ${rep.signed_report_hash.slice(0, 26)}…`);
    };
    show(meena);

    const { body: rafiq } = await api("/merchants/mer_rafiq/commerce-history");
    console.log();
    show(rafiq);
    console.log(
      `\n  ${dim("Rafiq's rate is lower because two handovers were never confirmed —")}\n` +
        `  ${dim("that is a fact from the chains, not a number typed into a seed file.")}`,
    );

    heading("The report is itself checkable");
    const good = await verifyCommerceHistory(meena, keyring);
    console.log(`  ${good.ok ? g("✅ signature verifies") : r(`❌ ${good.reason}`)} ${dim("signed by platform, ES256")}`);

    const tampered = structuredClone(meena);
    tampered.total_verified_value = 999999;
    const bad = await verifyCommerceHistory(tampered, keyring);
    console.log(
      `  ${!bad.ok ? g("✅ inflating the total breaks it") : r("❌ MISSED — a padded report still verified")}`,
    );
    console.log(`     ${dim(bad.reason ?? "")}`);

    const reordered = { total_verified_value: meena.total_verified_value, ...meena };
    const stillOk = await verifyCommerceHistory(reordered, keyring);
    console.log(
      `  ${stillOk.ok ? g("✅ reordering keys does not") : r("❌ canonicalization broken")} ${dim("— key order is not content")}`,
    );

    heading("What the report refuses to claim");
    for (const c of meena.caveats) console.log(`  ${dim("•")} ${dim(c)}`);

    heading("Milestone H — definition of done");
    // Assert the arithmetic, not the inventory. Which items are sellable depends
    // on what the extraction made of them, and on a live catalog that changes
    // between runs — a test that pins it to four sales is testing the model's
    // mood, not the report.
    const seeded = outcomes.filter((o) => o.status === "fulfilled" || o.status === "paid");
    const meenaFulfilled = outcomes.filter((o) => o.merchant_id === "mer_meena" && o.status === "fulfilled").length;
    const aggregated =
      seeded.length > 0 &&
      meena.completed_transactions === meenaFulfilled &&
      rafiq.fulfillment_confirmation_rate < 1 &&
      rafiq.paid_transactions > rafiq.completed_transactions;
    console.log(
      `  ${aggregated ? g("✅") : r("❌")} aggregates only verified, fulfilled chains ` +
        dim(`(Meena ${meena.completed_transactions} delivered of ${meena.paid_transactions} paid; Rafiq ${rafiq.completed_transactions}/${rafiq.paid_transactions})`),
    );
    console.log(`  ${good.ok ? g("✅") : r("❌")} report is signed and verifies`);
    console.log(`  ${!bad.ok ? g("✅") : r("❌")} tampering with one field breaks verification`);
    console.log(`  ${stillOk.ok ? g("✅") : r("❌")} key reordering does not`);
    console.log();

    if (!aggregated || !good.ok || bad.ok || !stillOk.ok) process.exitCode = 1;
  } finally {
    server.close();
    store.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
