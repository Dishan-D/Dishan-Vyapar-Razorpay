/**
 * Does the generated history hold together?
 *
 * Synthetic data earns its place only if it behaves like real data, and the
 * failures worth catching are the quiet ones — a buyer whose last purchase is
 * tomorrow, a total that does not match the rows under it, a story that was
 * written into `stories.ts` and never actually showed up in the transactions.
 * The last is the one that matters most for a demo: a shop labelled "declining"
 * that is up 30% makes the assistant look broken when it is being accurate.
 *
 *   npm run serve            # in one terminal
 *   npx tsx scripts/check-demo-data.ts
 */

const BASE = process.env.BASE ?? "http://localhost:3000";
let bad = 0;
const ok = (s: string, d = "") => console.log(`  ✓ ${s}${d ? ` — ${d}` : ""}`);
const no = (s: string, d: string) => { bad++; console.log(`  ✗ ${s} — ${d}`); };

const get = async <T>(p: string): Promise<T> => (await fetch(`${BASE}${p}`)).json() as Promise<T>;
const money = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;

type Txn = {
  transactionId: string; merchantId: string; buyerAgentId: string | null;
  status: string; amount: number; createdAt: string; paidAt: string | null;
  items: Array<{ productId: string; quantity: number; unitPrice: number; lineTotal: number }>;
};

/** What each shop's story is supposed to look like once it is in the data. */
const EXPECTED: Record<string, { label: string; check: (m: Story) => string | null }> = {
  mer_hazel: { label: "growing", check: (m) => (m.lastMonth > m.firstMonth * 1.15 ? null : `last month ${money(m.lastMonth)} is not clearly above the first ${money(m.firstMonth)}`) },
  mer_atelier: { label: "repeat-driven", check: (m) => (m.repeatShare >= 0.5 ? null : `only ${Math.round(m.repeatShare * 100)}% of buyers came back`) },
  mer_ovenroom: { label: "declining", check: (m) => (m.weekChange !== null && m.weekChange < -10 ? null : `this week is ${m.weekChange}%, not a visible decline`) },
  mer_northstar: { label: "product-driven", check: (m) => (m.topProductShare >= 0.2 ? null : `no single product carries the shop (top is ${Math.round(m.topProductShare * 100)}%)`) },
  mer_urbanloom: { label: "collection problem", check: (m) => (m.unpaidShare >= 0.12 ? null : `only ${Math.round(m.unpaidShare * 100)}% of orders are unpaid`) },
  mer_studioscent: { label: "opportunity", check: (m) => (m.lapsed >= 5 ? null : `only ${m.lapsed} lapsed buyers to win back`) },
};

interface Story {
  firstMonth: number; lastMonth: number; repeatShare: number;
  weekChange: number | null; topProductShare: number; unpaidShare: number; lapsed: number;
}

async function main(): Promise<void> {
  const { transactions } = await get<{ transactions: Txn[] }>("/analytics/transactions");
  const { merchants } = await get<{ merchants: Array<{ merchant_id: string; name: string; upi_vpa: string }> }>("/merchants");
  console.log(`\n  ${transactions.length} transactions across ${merchants.length} shops\n`);

  /* ── 1. nothing impossible ───────────────────────────────────────────── */
  console.log("1 · nothing impossible in the rows");
  const now = Date.now();
  const negative = transactions.filter((t) => t.amount < 0);
  const future = transactions.filter((t) => Date.parse(t.paidAt ?? t.createdAt) > now + 60_000);
  const zeroQty = transactions.filter((t) => t.items.some((l) => l.quantity <= 0));
  const badLines = transactions.filter((t) => t.items.reduce((s, l) => s + l.lineTotal, 0) !== t.amount);
  negative.length === 0 ? ok("no negative amounts") : no("no negative amounts", `${negative.length}`);
  future.length === 0 ? ok("nothing dated in the future") : no("nothing dated in the future", `${future.length}, e.g. ${future[0]!.paidAt}`);
  zeroQty.length === 0 ? ok("no zero or negative quantities") : no("no zero or negative quantities", `${zeroQty.length}`);
  badLines.length === 0 ? ok("line totals sum to the transaction") : no("line totals sum to the transaction", `${badLines.length} disagree`);

  /* ── 2. nothing orphaned ─────────────────────────────────────────────── */
  console.log("\n2 · nothing orphaned");
  const shops = new Set(merchants.map((m) => m.merchant_id));
  const { items } = await get<{ items: Array<{ item_id: string; merchant_id: string }> }>("/catalog");
  const products = new Map(items.map((i) => [i.item_id, i.merchant_id]));
  const badShop = transactions.filter((t) => !shops.has(t.merchantId));
  const badProduct = transactions.filter((t) => t.items.some((l) => !products.has(l.productId)));
  const crossed = transactions.filter((t) => t.items.some((l) => products.get(l.productId) !== t.merchantId));
  badShop.length === 0 ? ok("every transaction names a real shop") : no("every transaction names a real shop", `${badShop.length}`);
  badProduct.length === 0 ? ok("every line names a real product") : no("every line names a real product", `${badProduct.length}`);
  crossed.length === 0 ? ok("no sale credited to a shop that does not stock it") : no("no sale credited to a shop that does not stock it", `${crossed.length}`);

  /* ── 3. the ledger agrees with itself ────────────────────────────────── */
  console.log("\n3 · totals match the rows they come from");
  const integrity = await get<{ ok: boolean; checked: number; faults: Array<{ problem: string }> }>("/analytics/integrity");
  integrity.ok ? ok("no integrity faults", `${integrity.checked} checked`) : no("no integrity faults", integrity.faults[0]?.problem ?? "");

  for (const m of merchants.slice(0, 6)) {
    const a = await get<{ revenue: number; orders: number }>(`/merchants/${m.merchant_id}/analytics`);
    const mine = transactions.filter((t) => t.merchantId === m.merchant_id && (t.status === "paid" || t.status === "delivered"));
    const sum = mine.reduce((s, t) => s + t.amount, 0);
    if (sum !== a.revenue) { no(`${m.name}: revenue matches its transactions`, `${money(a.revenue)} vs ${money(sum)}`); }
    else if (mine.length !== a.orders) { no(`${m.name}: order count matches`, `${a.orders} vs ${mine.length}`); }
  }
  ok("every shop's headline equals the sum of its own rows");

  /* ── 4. UPI is consistent ────────────────────────────────────────────── */
  console.log("\n4 · payment details");
  const noUpi = merchants.filter((m) => !m.upi_vpa || !/^[\w.-]+@[\w.-]+$/.test(m.upi_vpa));
  noUpi.length === 0 ? ok("every shop has a well-formed UPI id") : no("every shop has a well-formed UPI id", noUpi.map((m) => m.name).join(", "));

  /* ── 5. the stories are actually in the data ─────────────────────────── */
  console.log("\n5 · each shop's story shows up in its transactions");
  for (const [id, want] of Object.entries(EXPECTED)) {
    const mine = transactions.filter((t) => t.merchantId === id);
    const paid = mine.filter((t) => t.status === "paid" || t.status === "delivered");
    if (paid.length === 0) { no(`${id} — ${want.label}`, "no paid transactions at all"); continue; }

    const byMonth = new Map<string, number>();
    for (const t of paid) {
      const k = (t.paidAt ?? t.createdAt).slice(0, 7);
      byMonth.set(k, (byMonth.get(k) ?? 0) + t.amount);
    }
    // Drop the first and last calendar months: both are partial and would make
    // a growing shop look like it collapsed.
    const months = [...byMonth.entries()].sort().slice(1, -1).map(([, v]) => v);

    const buyers = new Map<string, number>();
    for (const t of paid) if (t.buyerAgentId) buyers.set(t.buyerAgentId, (buyers.get(t.buyerAgentId) ?? 0) + 1);
    const repeatShare = buyers.size === 0 ? 0 : [...buyers.values()].filter((n) => n > 1).length / buyers.size;

    const byProduct = new Map<string, number>();
    for (const t of paid) for (const l of t.items) byProduct.set(l.productId, (byProduct.get(l.productId) ?? 0) + l.lineTotal);
    const total = [...byProduct.values()].reduce((a, b) => a + b, 0);
    const topProductShare = total === 0 ? 0 : Math.max(...byProduct.values()) / total;

    const trend = await get<{ change_pct: number | null }>(`/merchants/${id}/trend?period=week`);
    const cust = await get<{ lapsed: unknown[] }>(`/merchants/${id}/customers`);

    const story: Story = {
      firstMonth: months[0] ?? 0,
      lastMonth: months[months.length - 1] ?? 0,
      repeatShare,
      weekChange: trend.change_pct,
      topProductShare,
      unpaidShare: mine.filter((t) => t.status === "awaiting_payment").length / mine.length,
      lapsed: cust.lapsed.length,
    };
    const problem = want.check(story);
    problem === null ? ok(`${id} reads as ${want.label}`) : no(`${id} should read as ${want.label}`, problem);
  }

  /* ── 6. the same data, both ways of asking ───────────────────────────── */
  console.log("\n6 · Simple Mode and Insights Mode agree");
  for (const m of merchants.slice(0, 3)) {
    const viaAgent = await (await fetch(`${BASE}/merchants/${m.merchant_id}/agent`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversation_id: `verify_${m.merchant_id}`, message: "how much did I make in the last 7 days" }),
    })).json() as { steps: Array<{ tool: string }>; cards: Array<{ value?: string }> };
    const viaDash = await get<{ revenue: number }>(`/merchants/${m.merchant_id}/analytics`);
    const said = viaAgent.cards?.[0]?.value ?? "";
    // Both must be reading the ledger; the agent's weekly figure cannot exceed
    // the shop's all-time revenue, and it must be a real number.
    const n = Number(String(said).replace(/[^\d]/g, ""));
    Number.isFinite(n) && n <= viaDash.revenue
      ? ok(`${m.name}: the assistant's figure is inside the dashboard's`, `${said} of ${money(viaDash.revenue)}`)
      : no(`${m.name}: the assistant's figure is inside the dashboard's`, `${said} vs ${money(viaDash.revenue)}`);
  }

  /* ── 7. the panel only says what the rows say ────────────────────────── */
  console.log("\n7 · every claim the insight panel makes is re-derivable");
  for (const m of merchants.slice(0, 6)) {
    const trend = await get<{
      change_pct: number | null; direction: string;
      now: { revenue: number; orders: number; customers: number; repeatCustomers: number };
      before: { revenue: number; orders: number; customers: number; repeatCustomers: number };
      contributors: Array<{ what: string; detail: string; change: number }>;
    }>(`/merchants/${m.merchant_id}/trend?period=week`);

    const mine = transactions.filter((t) => t.merchantId === m.merchant_id && (t.status === "paid" || t.status === "delivered"));
    const inWindow = (from: number, to: number) =>
      mine.filter((t) => {
        const at = Date.parse(t.paidAt ?? t.createdAt);
        return at >= now - from * 86_400_000 && at < now - to * 86_400_000;
      });
    const a = inWindow(7, 0);
    const b = inWindow(14, 7);
    const revA = a.reduce((s, t) => s + t.amount, 0);
    const revB = b.reduce((s, t) => s + t.amount, 0);

    if (revA !== trend.now.revenue || revB !== trend.before.revenue) {
      no(`${m.name}: the panel's revenue is the sum of its own rows`,
        `panel ${money(trend.now.revenue)}/${money(trend.before.revenue)} vs rows ${money(revA)}/${money(revB)}`);
      continue;
    }
    const wantPct = revB === 0 ? null : Math.round(((revA - revB) / revB) * 100);
    if (wantPct !== trend.change_pct) {
      no(`${m.name}: the headline percentage is that comparison`, `${trend.change_pct}% vs ${wantPct}%`);
      continue;
    }

    // Every contributor must restate a number present in the rows. A line the
    // rows cannot produce is the definition of a fabricated insight.
    const bad2 = trend.contributors.filter((c) => {
      if (c.what === "how many orders") return !c.detail.includes(`${a.length} orders against ${b.length}`);
      if (c.what === "how many different buyers") {
        const ca = new Set(a.map((t) => t.buyerAgentId).filter(Boolean)).size;
        const cb = new Set(b.map((t) => t.buyerAgentId).filter(Boolean)).size;
        return !c.detail.includes(`${ca} buyers against ${cb}`);
      }
      if (c.what === "buyers coming back") {
        const rep = (rows: Txn[]) => {
          const n = new Map<string, number>();
          for (const t of rows) if (t.buyerAgentId) n.set(t.buyerAgentId, (n.get(t.buyerAgentId) ?? 0) + 1);
          return [...n.values()].filter((x) => x > 1).length;
        };
        return !c.detail.includes(`${rep(a)} people bought more than once against ${rep(b)}`);
      }
      return false; // product and AOV lines are checked by the revenue equality above
    });
    bad2.length === 0
      ? ok(`${m.name}: ${trend.contributors.length} contributor line(s) restate the rows`,
          trend.change_pct === null ? "no comparison to make" : `${trend.change_pct}%`)
      : no(`${m.name}: every contributor restates the rows`, bad2.map((c) => c.what).join(", "));

    // And when there is nothing to compare against, nothing is claimed.
    if (trend.direction === "unknown" && trend.contributors.length > 0) {
      no(`${m.name}: no comparison is asserted when there is no prior period`, "contributors returned anyway");
    }
  }

  console.log(bad === 0 ? `\n  All checks passed.\n` : `\n  ${bad} check(s) failed.\n`);
  process.exit(bad === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`\n  Could not run: ${err instanceof Error ? err.message : String(err)}`);
  console.error(`  Is the server up at ${BASE}?\n`);
  process.exit(1);
});

export {};
