/**
 * Milestone G — structuring as a five-stage pipeline.
 *
 *   npm run milestone-g
 *
 * Definition of done: Amma's Snacks trips the confidence gate and the sanity
 * gate on two different items, and both resolve through the clarification loop.
 */
import type { Server } from "node:http";
import { createApp } from "../src/server.js";

const g = (s: string) => `\x1b[32m${s}\x1b[0m`;
const r = (s: string) => `\x1b[31m${s}\x1b[0m`;
const y = (s: string) => `\x1b[33m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

function heading(t: string): void {
  console.log(`\n${bold(t)}\n${dim("─".repeat(t.length))}`);
}

async function main(): Promise<void> {
  console.log(bold("\nVyapar-to-Agent · Milestone G — structuring pipeline"));

  const { app, store } = await createApp();
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
    // ── Stages 1–3 ──────────────────────────────────────────────────────────
    heading("Stages 1–3 · draft → sanity → combined gate");
    const { body: cat } = await api("/catalog");
    const amma = cat.items.filter((i: any) => i.merchant_id === "mer_amma");

    for (const item of amma) {
      const s = item.sanity;
      const mark = item.transactable ? g("● live") : r("● held");
      const sm = s.check === "fail" ? r("sanity fail") : s.check === "pass" ? g("sanity pass") : dim("sanity skipped");
      console.log(`  ${mark}  ${bold(item.name.padEnd(26))} ${String(item.price.value || "—").padStart(5)}  ` +
        `${dim(`llm ${item.price.confidence.toFixed(2)}`)}  ${sm}`);
      if (!item.transactable) console.log(`         ${dim(item.held_because.join("; "))}`);
    }

    const bySanity = amma.find((i: any) => i.audit?.gate_triggers?.includes("price_sanity"));
    const byConfidence = amma.find((i: any) => i.audit?.gate_triggers?.includes("price_confidence"));
    const twoGates = Boolean(bySanity && byConfidence && bySanity.item_id !== byConfidence.item_id);
    console.log(
      `\n  ${twoGates ? g("✅") : r("❌")} two different items, two different gates: ` +
        `${bySanity?.name ?? "—"} (sanity) · ${byConfidence?.name ?? "—"} (confidence)`,
    );
    console.log(
      `  ${dim("the sanity catch matters because the model was")} ${bold(`${bySanity?.price.confidence.toFixed(2)} confident`)} ` +
        `${dim("— only her own price history disagreed")}`,
    );

    // ── Stage 4 ─────────────────────────────────────────────────────────────
    heading("Stage 4 · clarification");
    const { body: q } = await api("/clarifications?merchant_id=mer_amma");
    console.log(`  ${dim("channel:")} ${q.channel}`);
    for (const c of q.clarifications) {
      console.log(`\n  ${y("→")} ${c.question}`);
      if (c.options.length) console.log(`     ${dim(`quick replies: ${c.options.join(" / ")}`)}`);
    }

    // ── Stage 5 ─────────────────────────────────────────────────────────────
    heading("Stage 5 · the merchant replies");
    const sanityQ = q.clarifications.find((c: any) => c.trigger === "price_sanity");
    const confQ = q.clarifications.find((c: any) => c.trigger === "price_confidence");

    const replies: Array<[any, string]> = [];
    if (sanityQ) replies.push([sanityQ, "110"]);
    if (confQ) replies.push([confQ, "₹60"]);

    let cleared = 0;
    for (const [c, reply] of replies) {
      const { body } = await api(`/clarifications/${c.clarification_id}/reply`, {
        method: "POST",
        body: JSON.stringify({ reply }),
      });
      console.log(`  ${dim("merchant types")} "${reply}"  →  ${bold(c.item_name)}`);

      let ok = body.transactable === true;
      if (ok) {
        console.log(`     ${g("✅ now sellable")} ${dim(`resolved to ₹${body.resolved_value}`)}`);
      } else if (body.follow_up) {
        // Two things were wrong with this item. Answering one surfaced the other.
        console.log(`     ${y("↩ one down, one to go")} ${dim(`₹${body.resolved_value} accepted`)}`);
        console.log(`     ${y("→")} ${body.follow_up}`);
        const { body: q2 } = await api("/clarifications?merchant_id=mer_amma");
        const next = q2.clarifications.find(
          (x: any) => x.item_id === c.item_id && x.status === "open",
        );
        if (next) {
          const { body: b2 } = await api(`/clarifications/${next.clarification_id}/reply`, {
            method: "POST",
            body: JSON.stringify({ reply: "12" }),
          });
          ok = b2.transactable === true;
          console.log(`  ${dim("merchant types")} "12"  →  ${bold(c.item_name)}`);
          console.log(
            `     ${ok ? g("✅ now sellable") : r("❌ still held")} ` +
              `${dim(ok ? "both fields resolved" : (b2.still_held_because ?? []).join("; "))}`,
          );
        }
      } else {
        console.log(`     ${r("❌ still held")} ${dim((body.still_held_because ?? []).join("; "))}`);
      }
      cleared += ok ? 1 : 0;
    }

    // ── Nothing auto-resolves ───────────────────────────────────────────────
    heading("What was NOT answered stays held");
    const { body: after } = await api("/catalog");
    const stillHeld = after.items.filter((i: any) => !i.transactable);
    for (const i of stillHeld) {
      console.log(`  ${r("● held")}  ${i.name} ${dim(`— ${i.held_because.join("; ")}`)}`);
    }
    console.log(`  ${dim("No reply, no resolution. Nothing here guesses on the merchant's behalf.")}`);

    heading("Milestone G — definition of done");
    const bothCleared = cleared === replies.length && replies.length === 2;
    console.log(`  ${twoGates ? g("✅") : r("❌")} both gates fire, on different items`);
    console.log(`  ${q.clarifications.length > 0 ? g("✅") : r("❌")} each held item gets a specific, answerable question`);
    console.log(`  ${bothCleared ? g("✅") : r("❌")} both resolve through the clarification loop: ${cleared}/${replies.length}`);
    console.log(`  ${stillHeld.length > 0 ? g("✅") : y("—")} unanswered items stay held: ${stillHeld.length}`);
    console.log();

    if (!twoGates || !bothCleared) process.exitCode = 1;
  } finally {
    server.close();
    store.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
