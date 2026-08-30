/**
 * Milestone B — structuring agent on sample data.
 *
 *   npm run milestone-b            # hand-authored fixtures, no API key needed
 *   npm run milestone-b -- --live  # real Claude call (needs ANTHROPIC_API_KEY)
 *
 * Definition of done: a catalog.json is produced, and at least one deliberately
 * ambiguous sample is correctly flagged needs_merchant_confirmation.
 */
import {
  assertTransactable,
  gateReasons,
  NotTransactableError,
  CONFIDENCE_FLOOR,
} from "../src/structuring/extraction.js";
import { hasCredentials } from "../src/structuring/extract.js";
import { activeProvider, providerLabel } from "../src/llm/provider.js";
import { runStructuring, writeCatalog } from "../src/structuring/run.js";

const g = (s: string) => `\x1b[32m${s}\x1b[0m`;
const r = (s: string) => `\x1b[31m${s}\x1b[0m`;
const y = (s: string) => `\x1b[33m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

function heading(text: string): void {
  console.log(`\n${bold(text)}\n${dim("─".repeat(text.length))}`);
}

/** Colour a confidence by which side of the gate it falls on. */
function conf(n: number): string {
  const s = n.toFixed(2);
  return n < CONFIDENCE_FLOOR ? r(s) : n < 0.85 ? y(s) : g(s);
}

async function main(): Promise<void> {
  const live = process.argv.includes("--live");
  console.log(bold("\nVyapar-to-Agent · Milestone B — structuring agent"));

  if (live && !hasCredentials()) {
    console.log(
      `\n  ${y("--live requested but no model credentials found")} ` +
        `${dim("(set GROQ_API_KEY or ANTHROPIC_API_KEY in .env)")}\n  falling back to fixtures.`,
    );
  }

  const result = await runStructuring(live);

  heading("Source");
  if (result.provider !== "fixture") {
    console.log(`  ${g("live model")} ${dim(providerLabel(result.provider === "groq" ? "groq" : "claude"))}`);
  } else {
    console.log(`  ${y("fixtures")} ${dim("— hand-authored stand-ins, not recorded model output")}`);
  }
  console.log(
    `  ${dim("photos attached:")} ${result.photosUsed}/${result.items.length}` +
      (result.photosUsed === 0
        ? dim("  (drop image files into data/sample_products/ to exercise the vision path)")
        : ""),
  );

  heading("Extracted catalog");
  let lastMerchant = "";
  for (const item of result.items) {
    if (item.merchant_id !== lastMerchant) {
      lastMerchant = item.merchant_id;
      const m = result.merchants.find((x) => x.merchant_id === item.merchant_id);
      console.log(`\n  ${bold(m?.name ?? item.merchant_id)} ${dim(m?.city ?? "")}`);
    }
    const sanity = result.sanity[item.item_id];
    const reasons = gateReasons(item, sanity);
    const flag = item.needs_merchant_confirmation ? r("● HELD") : g("● LIVE");
    const price = item.price.value === 0 ? dim("not stated") : `₹${item.price.value}`;
    const stock = item.stock.confidence === 0 ? dim("not stated") : `${item.stock.quantity} in stock`;

    console.log(`\n  ${flag}  ${bold(item.item_id)}  ${item.name}  ${dim(item.category)}`);
    console.log(
      `         price ${price} ${dim("conf")} ${conf(item.price.confidence)}` +
        `   ·   ${stock} ${dim("conf")} ${conf(item.stock.confidence)}`,
    );
    console.log(`         ${dim(`"${item.source.raw_text}"`)}`);
    if (sanity) {
      const mark = sanity.check === "fail" ? r("sanity fail") : sanity.check === "pass" ? g("sanity pass") : dim("sanity skipped");
      console.log(`         ${mark} ${dim(sanity.reason)}`);
    }
    if (reasons.length > 0) {
      console.log(`         ${r("held:")} ${reasons.join(", ")}`);
    }
  }

  // ── The gate, exercised ───────────────────────────────────────────────────
  heading("Gate enforcement");
  let blocked = 0;
  let allowed = 0;
  for (const item of result.items) {
    try {
      assertTransactable(item, result.sanity[item.item_id]);
      allowed++;
      console.log(`  ${g("✅ transactable")}  ${item.item_id}  ${dim(item.name)}`);
    } catch (err) {
      if (!(err instanceof NotTransactableError)) throw err;
      blocked++;
      console.log(`  ${r("⛔ blocked     ")}  ${item.item_id}  ${dim(err.reasons.join("; "))}`);
    }
  }

  const catalogPath = await writeCatalog(result);

  heading("Milestone B — definition of done");
  const wrote = result.items.length > 0;
  const flagged = blocked > 0;
  const passable = allowed > 0;
  console.log(`  ${wrote ? g("✅") : r("❌")} catalog written  ${dim(catalogPath)}`);
  console.log(
    `  ${flagged ? g("✅") : r("❌")} ambiguous items flagged and blocked: ${blocked}/${result.items.length}`,
  );
  console.log(`  ${passable ? g("✅") : r("❌")} clean items pass the gate: ${allowed}/${result.items.length}`);
  if (result.provider === "fixture") {
    console.log(`  ${y("⚠")}  confidence values are fixtures — rerun with --live to record real ones`);
  }
  console.log();

  if (!wrote || !flagged || !passable) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
