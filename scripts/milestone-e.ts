/**
 * Milestone E — fulfillment loop and audit view, driven over HTTP.
 *
 *   npm run milestone-e
 *
 * Definition of done: hitting confirm-fulfillment appends a valid 4th mandate,
 * and the audit endpoint renders the full verified 4-stage timeline.
 */
import type { Server } from "node:http";
import { createApp } from "../src/server.js";
import { SimulatedGateway } from "../src/payments/gateway.js";
import type { AuditBundle } from "../src/audit/bundle.js";

const g = (s: string) => `\x1b[32m${s}\x1b[0m`;
const r = (s: string) => `\x1b[31m${s}\x1b[0m`;
const y = (s: string) => `\x1b[33m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

function heading(text: string): void {
  console.log(`\n${bold(text)}\n${dim("─".repeat(text.length))}`);
}

async function main(): Promise<void> {
  console.log(bold("\nVyapar-to-Agent · Milestone E — fulfillment and audit"));

  // Simulated on purpose: this milestone proves the fulfillment and audit
  // stages, and a real gateway would stop the flow at Checkout for reasons
  // that have nothing to do with what is being tested here.
  const { app, store, gateway } = await createApp({ gateway: new SimulatedGateway() });
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = (server.address() as { port: number }).port;
  const base = `http://localhost:${port}`;
  const call = async (path: string, init?: RequestInit) => {
    const res = await fetch(`${base}${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  try {
    console.log(`  ${dim(`server on ${base}, gateway: ${gateway.kind}`)}`);

    // ── Stages 2–5 ──────────────────────────────────────────────────────────
    heading("POST /transactions");
    const created = await call("/transactions", {
      method: "POST",
      body: JSON.stringify({ want: "blue cotton saree", max_price: 1500, opening_offer: 800 }),
    });
    if (created.status !== 201) {
      console.log(`  ${r(`unexpected ${created.status}`)} ${JSON.stringify(created.body)}`);
      process.exitCode = 1;
      return;
    }
    const txnId = String(created.body.transaction_id);
    console.log(`  ${g("201")} ${bold(txnId)} — ₹${created.body.final_price} · order ${created.body.order_id}`);

    // ── The honest intermediate state ───────────────────────────────────────
    heading("Audit before fulfillment");
    const before = (await call(`/transactions/${txnId}/audit`)).body as unknown as AuditBundle;
    console.log(`  ${dim("status:")} ${bold(before.status)}`);
    const awaiting = before.status === "payment_confirmed_awaiting_fulfillment";
    console.log(
      awaiting
        ? `  ${g("✅")} not marked delivered on its own — the 4th stage reads "${before.timeline[3]!.headline}"`
        : `  ${r("❌")} transaction claimed a fulfillment nobody confirmed`,
    );

    // ── Stage 6 ─────────────────────────────────────────────────────────────
    heading("POST /transactions/:id/confirm-fulfillment");
    const confirmed = await call(`/transactions/${txnId}/confirm-fulfillment`, {
      method: "POST",
      body: JSON.stringify({ evidence_note: "Handed over in person at the shop, 30 Aug" }),
    });
    console.log(
      confirmed.status === 201
        ? `  ${g("201")} fulfillment mandate appended`
        : `  ${r(String(confirmed.status))} ${JSON.stringify(confirmed.body)}`,
    );

    const twice = await call(`/transactions/${txnId}/confirm-fulfillment`, {
      method: "POST",
      body: JSON.stringify({ evidence_note: "again" }),
    });
    const rejectedDouble = twice.status === 409;
    console.log(
      rejectedDouble
        ? `  ${g("✅")} a second confirmation is refused ${dim("— evidence is appended once, never rewritten")}`
        : `  ${r("❌")} double confirmation accepted (${twice.status})`,
    );

    // ── Stage 7 ─────────────────────────────────────────────────────────────
    heading("GET /transactions/:id/audit");
    const bundle = (await call(`/transactions/${txnId}/audit`)).body as unknown as AuditBundle;

    for (const entry of bundle.timeline) {
      if (!entry.present) {
        console.log(`  ${dim("○")} ${entry.stage.padEnd(12)} ${dim(entry.headline)}`);
        continue;
      }
      const mark = entry.verified ? g("✅") : r("❌");
      console.log(`  ${mark} ${bold(entry.stage.padEnd(12))} ${entry.headline}`);
      for (const d of entry.detail) console.log(`       ${dim(d)}`);
      console.log(
        `       ${dim(entry.hash!.slice(0, 20) + "…")}  ${dim("signed by")} ` +
          entry.signatures.map((s) => `${s.verified ? g(s.role) : r(s.role)}`).join(", "),
      );
    }

    console.log(`\n  ${dim("status:")} ${bold(bundle.status)}`);
    console.log(`  ${dim("fingerprint:")} ${bundle.fingerprint.slice(0, 24)}…`);
    console.log(
      bundle.verified
        ? `  ${g("CHAIN VERIFIED")} — 4 mandates, every signature and hash link re-checked at read time`
        : `  ${r("CHAIN REJECTED")} — ${bundle.failures.join("; ")}`,
    );

    // ── Persistence: the chain must survive a restart ───────────────────────
    heading("Reload from SQLite");
    const reloaded = store.loadChain(txnId);
    const stages = store.stagesRecorded(txnId);
    const persisted = Boolean(reloaded?.fulfillment) && stages.length === 4;
    console.log(
      persisted
        ? `  ${g("✅")} all four mandates read back from disk: ${stages.join(" → ")}`
        : `  ${r("❌")} only ${stages.length} mandate(s) persisted`,
    );

    heading("Milestone E — definition of done");
    const fourth = confirmed.status === 201;
    console.log(`  ${awaiting ? g("✅") : r("❌")} stays awaiting fulfillment until the merchant confirms`);
    console.log(`  ${fourth ? g("✅") : r("❌")} confirm-fulfillment appends a valid 4th mandate`);
    console.log(`  ${bundle.verified ? g("✅") : r("❌")} audit endpoint renders the full verified timeline`);
    console.log(`  ${rejectedDouble ? g("✅") : r("❌")} fulfillment cannot be confirmed twice`);
    console.log(`  ${persisted ? g("✅") : r("❌")} chain survives a round trip through SQLite`);
    if (gateway.kind === "simulated") {
      console.log(`  ${y("⚠")}  payment ids are simulated — set Razorpay test keys for real ones`);
    }
    console.log();

    if (!awaiting || !fourth || !bundle.verified || !rejectedDouble || !persisted) {
      process.exitCode = 1;
    }
  } finally {
    server.close();
    store.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
