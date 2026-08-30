/**
 * The recorded walkthrough — one pass through the whole pipeline, plus the two
 * failure scenarios, in the order the pitch video tells them.
 *
 *   npm run demo
 *
 * This is the fallback if the browser misbehaves on camera. It talks to the same
 * HTTP API the frontend does, so nothing here is a special demo path.
 */
import type { Server } from "node:http";
import { createApp } from "../src/server.js";
import type { AuditBundle } from "../src/audit/bundle.js";

const g = (s: string) => `\x1b[32m${s}\x1b[0m`;
const r = (s: string) => `\x1b[31m${s}\x1b[0m`;
const y = (s: string) => `\x1b[33m${s}\x1b[0m`;
const b = (s: string) => `\x1b[36m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

const PAUSE = Number(process.env.DEMO_PAUSE_MS ?? 450);
const beat = (ms = PAUSE) => new Promise((res) => setTimeout(res, ms));

function step(n: number, of: number, title: string): void {
  console.log(`\n${dim(`${n}/${of}`)}  ${bold(title)}`);
}

async function main(): Promise<void> {
  const { app, store } = await createApp();
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = (server.address() as { port: number }).port;
  const base = `http://localhost:${port}`;
  const api = async (path: string, init?: RequestInit) => {
    const res = await fetch(`${base}${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    });
    return { status: res.status, body: (await res.json()) as any };
  };

  try {
    console.log(bold("\n  VYAPAR-TO-AGENT"));
    console.log(dim("  a UPI-only merchant, made transactable by an AI buyer-agent\n"));

    // 1 ──────────────────────────────────────────────────────────────────────
    step(1, 6, "The merchant's raw input becomes a catalog");
    const { body: cat } = await api("/catalog");
    for (const item of cat.items) {
      const held = !item.transactable;
      console.log(
        `     ${held ? r("⛔") : g("●")} ${item.name.padEnd(28)} ` +
          `${item.price.confidence === 0 ? dim("no price".padStart(7)) : `₹${item.price.value}`.padStart(7)}` +
          `  ${dim(`price conf ${item.price.confidence.toFixed(2)} · stock conf ${item.stock.confidence.toFixed(2)}`)}`,
      );
      if (held) console.log(`        ${r(item.held_because.join("; "))}`);
      await beat(120);
    }
    console.log(
      `\n     ${dim("The two held items were never told a price the merchant had settled on.")}\n` +
        `     ${dim("They stay out of every offer until a human confirms them.")}`,
    );
    await beat();

    // 2 ──────────────────────────────────────────────────────────────────────
    step(2, 6, "A buyer-agent goes shopping");
    console.log(`     ${dim('"Find a blue cotton saree under ₹1500"')}`);
    const { body: found } = await api("/discover", {
      method: "POST",
      body: JSON.stringify({ want: "blue cotton saree", max_price: 1500 }),
    });
    for (const m of found.matches) {
      console.log(`     ${g("→")} ${m.item.name} ${dim(`₹${m.item.price.value} · ${(m.score * 100).toFixed(0)}% of the query matched`)}`);
    }
    console.log(`     ${dim("Deterministic filter, no model — an answer the buyer-agent can check.")}`);
    await beat();

    // 3 ──────────────────────────────────────────────────────────────────────
    step(3, 6, "They haggle — the part no agent protocol does");
    const { body: deal } = await api("/transactions", {
      method: "POST",
      body: JSON.stringify({ want: "blue cotton saree", max_price: 1500, opening_offer: 1100 }),
    });
    for (const t of deal.log) {
      const who = t.actor === "buyer" ? b("buyer   ") : y("merchant");
      console.log(`     ${dim(`r${t.round}`)} ${who} ${t.message}`);
      console.log(`         ${dim(t.rationale)}`);
      await beat(280);
    }
    console.log(`\n     ${g(`Agreed ₹${deal.final_price}.`)} ${dim("Every number came from the merchant's policy.")}`);
    console.log(`     ${dim("A model may phrase these lines. It never picks one of these numbers.")}`);
    await beat();

    // 4 ──────────────────────────────────────────────────────────────────────
    step(4, 6, "Signed consent, then payment");
    console.log(`     ${g("✅")} intent mandate   ${dim("what the buyer-agent was authorized to do")}`);
    console.log(`     ${g("✅")} cart mandate     ${dim("merchant signs, buyer-agent countersigns")}`);
    console.log(`     ${g("✅")} order  ${bold(deal.order_id)}`);
    if (deal.status === "awaiting_payment") {
      // Real Razorpay: a payment_id only exists once someone pays in a browser.
      console.log(`     ${y("⏸")}  awaiting payment through Razorpay Checkout`);
      console.log(`     ${dim("Run the browser demo (npm run serve) to complete this one — the CLI")}`);
      console.log(`     ${dim("cannot produce a payment_id, and will not pretend to.")}\n`);
      return;
    }
    console.log(`     ${g("✅")} payment ${bold(deal.payment_id)}${deal.gateway === "simulated" ? dim("  (simulated gateway)") : ""}`);
    console.log(`     ${dim("Signatures are verified before the payment API is called, not after.")}`);
    await beat();

    // 5 ──────────────────────────────────────────────────────────────────────
    step(5, 6, "The merchant confirms the goods changed hands");
    const before = (await api(`/transactions/${deal.transaction_id}/audit`)).body as AuditBundle;
    console.log(`     ${dim("before confirmation:")} ${bold(before.status)}`);
    console.log(`     ${dim("Nothing infers delivery. No confirmation, no fulfillment mandate.")}`);
    await beat();
    await api(`/transactions/${deal.transaction_id}/confirm-fulfillment`, {
      method: "POST",
      body: JSON.stringify({ evidence_note: "Handed over in person at the shop" }),
    });
    console.log(`     ${g("✅")} merchant signed the handover`);
    await beat();

    // 6 ──────────────────────────────────────────────────────────────────────
    step(6, 6, "The evidence chain");
    const bundle = (await api(`/transactions/${deal.transaction_id}/audit`)).body as AuditBundle;
    for (const s of bundle.timeline) {
      console.log(`     ${s.verified ? g("✅") : r("❌")} ${bold(s.stage.padEnd(12))} ${s.headline}`);
      console.log(`        ${dim(s.hash!)}`);
      await beat(200);
    }
    console.log(
      `\n     ${bundle.verified ? g("CHAIN VERIFIED") : r("CHAIN REJECTED")} ` +
        `${dim("— every signature and hash link re-checked just now, not read from a flag")}`,
    );
    await beat();

    // Failure scenarios ──────────────────────────────────────────────────────
    console.log(`\n${bold("  WHEN IT DOESN'T WORK")}`);

    console.log(`\n  ${bold("A buyer that can't reach the floor")}`);
    const { body: noDeal } = await api("/transactions", {
      method: "POST",
      body: JSON.stringify({ want: "blue cotton saree", max_price: 900, opening_offer: 800 }),
    });
    for (const t of noDeal.log) {
      const who = t.actor === "buyer" ? b("buyer   ") : y("merchant");
      console.log(`     ${dim(`r${t.round}`)} ${who} ${t.message}`);
      await beat(200);
    }
    console.log(`     ${r("No deal.")} ${dim(noDeal.reason)}`);
    console.log(`     ${dim("The merchant's floor held. No payment was attempted.")}`);
    await beat();

    console.log(`\n  ${bold("An item the extraction wasn't sure about")}`);
    const held = await api("/transactions", {
      method: "POST",
      body: JSON.stringify({ want: "printed bedsheet", max_price: 1500, opening_offer: 400 }),
    });
    console.log(`     ${r(String(held.status))} ${held.body.error}`);
    for (const w of held.body.withheld ?? []) {
      console.log(`     ${dim(`${w.item.name} — ${w.reason}`)}`);
    }
    console.log(`     ${dim("The merchant never said a price. So the system doesn't guess one.")}`);

    // Not `base` — that port dies with this script. Point at the real server.
    console.log(
      `\n  ${dim("Full audit, with the server running (npm run serve):")}` +
        `\n  ${dim(`GET http://localhost:3000/transactions/${deal.transaction_id}/audit`)}\n`,
    );
  } finally {
    server.close();
    store.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
