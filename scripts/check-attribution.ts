/**
 * Does what the shop is told match what actually happened?
 *
 * Six checks, all against a running server, all re-derived rather than
 * asserted. They exist because every one of them was false at some point: the
 * catalog reported the stock it shipped with however much was sold, and there
 * was no product-level reading of the ledger at all, so a shopkeeper could not
 * have found either problem from any screen the product offered.
 *
 *   npm run serve            # in one terminal
 *   npx tsx scripts/check-attribution.ts
 */

const BASE = process.env.BASE ?? "http://localhost:3000";

let failures = 0;
const ok = (name: string, detail = "") => console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`);
const bad = (name: string, detail: string) => {
  failures++;
  console.log(`  ✗ ${name} — ${detail}`);
};

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${BASE}${path}`);
  return (await r.json()) as T;
}
async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await r.json()) as T;
}

type Item = { item_id: string; name: string; merchant_id: string; price: { value: number }; stock: { quantity: number } };
type Prod = { productId: string; unitsSold: number; revenue: number; currentStock: number; ordersContaining: number; averageSellingPrice: number; byAttribution: Record<string, number> };
type Merch = { revenue: number; orders: number; unitsSold: number; averageOrderValue: number; byAttribution: Record<string, { revenue: number; units: number }>; topProducts: Array<{ productId: string; revenue: number }> };

async function main(): Promise<void> {
  const { items } = await get<{ items: Item[] }>("/catalog");
  const target = items.find((i) => i.stock.quantity >= 2 && i.price.value > 0);
  if (!target) throw new Error("no sellable product with stock to test against");
  const merchantId = target.merchant_id;

  console.log(`\nTesting against ${target.name} (${target.item_id}) at ${merchantId}\n`);

  const before = {
    stock: target.stock.quantity,
    product: await get<Prod>(`/products/${target.item_id}/analytics`),
    merchant: await get<Merch>(`/merchants/${merchantId}/analytics`),
    shelf: new Map(
      (await get<{ products: Prod[] }>(`/merchants/${merchantId}/products/analytics`)).products.map(
        (p) => [p.productId, p] as const,
      ),
    ),
  };

  /* 1 — a paid sale reaches the exact product it was for. */
  console.log("1 · a purchase is attributed to its own product");
  const run = await post<{ status: string; final_price?: number; transaction_id?: string }>("/agent/run", {
    goal: `${target.name} under ₹${target.price.value}`,
    item_id: target.item_id,
    max_price: target.price.value,
    opening_offer: Math.round(target.price.value * 0.88),
    settle: "test_rail",
    attribution: "cross_sell",
  });
  if (run.status !== "settled" && run.status !== "paid") {
    bad("the test purchase settled", `status was ${run.status}`);
    console.log("\nCannot continue without a paid sale.\n");
    process.exit(1);
  }
  const paid = run.final_price ?? 0;
  const afterProduct = await get<Prod>(`/products/${target.item_id}/analytics`);
  afterProduct.unitsSold === before.product.unitsSold + 1
    ? ok("units sold went up by exactly one", `${before.product.unitsSold} → ${afterProduct.unitsSold}`)
    : bad("units sold went up by exactly one", `${before.product.unitsSold} → ${afterProduct.unitsSold}`);
  afterProduct.revenue === before.product.revenue + paid
    ? ok("product revenue rose by the amount paid", `+₹${paid}`)
    : bad("product revenue rose by the amount paid", `expected +₹${paid}, got +₹${afterProduct.revenue - before.product.revenue}`);

  /* 2 — no other product moved. */
  console.log("\n2 · no other product was touched");
  const others = await get<{ products: Prod[] }>(`/merchants/${merchantId}/products/analytics`);
  const moved = others.products.filter(
    (p) => p.productId !== target.item_id && p.unitsSold !== (before.shelf.get(p.productId)?.unitsSold ?? 0),
  );
  moved.length === 0
    ? ok("every other product's units are unchanged", `${others.products.length - 1} checked`)
    : bad(
        "every other product's units are unchanged",
        moved.map((p) => `${p.productId} ${before.shelf.get(p.productId)?.unitsSold ?? 0} → ${p.unitsSold}`).join(", "),
      );

  /* 3 — the shelf count went down, once. */
  console.log("\n3 · stock came off the shelf");
  const { items: after } = await get<{ items: Item[] }>("/catalog");
  const nowStock = after.find((i) => i.item_id === target.item_id)?.stock.quantity ?? -1;
  nowStock === before.stock - 1
    ? ok("stock decremented by one", `${before.stock} → ${nowStock}`)
    : bad("stock decremented by one", `${before.stock} → ${nowStock}`);
  afterProduct.currentStock === nowStock
    ? ok("the analytics agree with the catalog", `both say ${nowStock}`)
    : bad("the analytics agree with the catalog", `analytics ${afterProduct.currentStock}, catalog ${nowStock}`);

  /* 4 — the merchant total is the sum of its products. */
  console.log("\n4 · merchant totals equal the sum of their parts");
  const m = await get<Merch>(`/merchants/${merchantId}/analytics`);
  const sum = others.products.reduce((s, p) => s + p.revenue, 0);
  sum === m.revenue
    ? ok("product revenue sums to merchant revenue", `₹${m.revenue}`)
    : bad("product revenue sums to merchant revenue", `products ₹${sum} vs merchant ₹${m.revenue}`);
  m.averageOrderValue === (m.orders === 0 ? 0 : Math.round(m.revenue / m.orders))
    ? ok("average order value is revenue ÷ orders")
    : bad("average order value is revenue ÷ orders", `${m.averageOrderValue}`);

  /* 5 — the reason the sale happened was kept. */
  console.log("\n5 · attribution survived the round trip");
  afterProduct.byAttribution.cross_sell === (before.product.byAttribution.cross_sell ?? 0) + 1
    ? ok("the sale was credited as cross_sell")
    : bad("the sale was credited as cross_sell", JSON.stringify(afterProduct.byAttribution));
  const attrTotal = Object.values(m.byAttribution).reduce((s, v) => s + v.revenue, 0);
  attrTotal === m.revenue
    ? ok("attributed revenue sums to total revenue", `₹${m.revenue}`)
    : bad("attributed revenue sums to total revenue", `attributed ₹${attrTotal} vs ₹${m.revenue}`);

  /* 6 — nothing in the ledger contradicts itself. */
  console.log("\n6 · the ledger holds together");
  const integrity = await get<{ checked: number; ok: boolean; faults: Array<{ transactionId: string; problem: string }> }>("/analytics/integrity");
  integrity.ok
    ? ok("no integrity faults", `${integrity.checked} transactions checked`)
    : bad("no integrity faults", integrity.faults.map((f) => `${f.transactionId}: ${f.problem}`).join("; "));

  console.log(
    failures === 0
      ? `\nAll checks passed.\n`
      : `\n${failures} check${failures === 1 ? "" : "s"} failed.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`\nCould not run: ${err instanceof Error ? err.message : String(err)}`);
  console.error(`Is the server up at ${BASE}? Start it with: npm run serve\n`);
  process.exit(1);
});

export {};
