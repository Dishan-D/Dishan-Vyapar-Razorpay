/**
 * Milestone A — the mandate chain, in isolation.
 * No LLM, no Razorpay, no database, no network. Just: can we build a four-link
 * signed evidence chain, and does it actually break when someone tampers with it?
 *
 *   npm run milestone-a
 */
import { Keyring } from "../src/mandates/keys.js";
import {
  buildCartMandate,
  buildFulfillmentMandate,
  buildIntentMandate,
  buildPaymentMandate,
  chainFingerprint,
  verifyChain,
  type MandateChain,
} from "../src/mandates/chain.js";
import { mandateHash } from "../src/mandates/sign.js";
import type { CartMandate } from "../src/mandates/schema.js";

const g = (s: string) => `\x1b[32m${s}\x1b[0m`;
const r = (s: string) => `\x1b[31m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

function heading(text: string): void {
  console.log(`\n${bold(text)}\n${dim("─".repeat(text.length))}`);
}

function short(hash: string | undefined): string {
  return hash ? `${hash.slice(0, 14)}…${hash.slice(-6)}` : "—";
}

/** Deep clone so a tamper test can mutate a copy without touching the good chain. */
const clone = <T>(v: T): T => structuredClone(v);

async function printChain(chain: MandateChain, keyring: Keyring): Promise<boolean> {
  const report = await verifyChain(chain, keyring);

  for (const m of report.mandates) {
    if (!m.present) {
      console.log(`  ${dim("○")} ${m.type.padEnd(12)} ${dim("not yet issued")}`);
      continue;
    }
    const sigs = m.signatures
      .map((s) => `${s.ok ? g("✅") : r("❌")} ${s.field.replace(/_signature$/, "")}`)
      .join("  ");
    const link = m.link ? (m.link.ok ? g("✅ link") : r("❌ link")) : dim("— root");
    console.log(`  ${bold(m.type.padEnd(12))} ${short(m.hash)}  ${link}  ${sigs}`);
    if (m.link && !m.link.ok) {
      console.log(`     ${r("expected")} ${short(m.link.expected)}  ${r("found")} ${short(m.link.found)}`);
    }
  }

  console.log(`  ${dim("status:")} ${report.status}`);
  console.log(`  ${dim("chain fingerprint:")} ${short(chainFingerprint(chain))}`);

  if (report.ok) {
    console.log(`\n  ${g("CHAIN VERIFIED")} — all signatures valid, all hash links intact.`);
  } else {
    console.log(`\n  ${r("CHAIN REJECTED")} — ${report.failures.length} problem(s):`);
    for (const f of report.failures) console.log(`     ${r("•")} ${f}`);
  }
  return report.ok;
}

/**
 * Mutate a copy of a good chain and assert how verification should react.
 * Most cases expect "reject" — that inversion is the point of the test. One case
 * expects "accept": reordering an object's keys is not tampering, and if
 * canonicalization is doing its job the chain must survive it untouched.
 */
async function tamperTest(
  name: string,
  expect: "reject" | "accept",
  mutate: (chain: MandateChain) => void | Promise<void>,
  goodChain: MandateChain,
  keyring: Keyring,
): Promise<boolean> {
  const chain = clone(goodChain);
  await mutate(chain);
  const report = await verifyChain(chain, keyring);
  const passed = expect === "reject" ? !report.ok : report.ok;

  const verdict = passed
    ? g(expect === "reject" ? "✅ rejected" : "✅ accepted")
    : r(expect === "reject" ? "❌ MISSED  " : "❌ REJECTED");
  console.log(`  ${verdict}  ${name}`);

  if (expect === "reject") {
    console.log(
      passed
        ? `     ${dim(report.failures[0] ?? "")}`
        : `     ${r("verification still passed — this is a real hole in the chain")}`,
    );
  } else if (!passed) {
    console.log(`     ${r(report.failures[0] ?? "canonicalization is broken")}`);
  }

  return passed;
}

async function main(): Promise<void> {
  console.log(bold("\nVyapar-to-Agent · Milestone A — signed mandate chain"));

  const keyring = await Keyring.generate();
  heading("Keys");
  for (const [role, k] of Object.entries(keyring.publicKeyring())) {
    console.log(`  ${role.padEnd(12)} ${dim(`kid=${k.kid} alg=ES256 crv=${k.jwk.crv}`)}`);
  }

  // ── Build the chain, stage by stage ───────────────────────────────────────
  const transaction_id = "txn_demo_0001";

  const intent = await buildIntentMandate(
    {
      issuer: keyring.get("buyer_agent").kid,
      buyer_agent_id: "agent_xyz",
      constraints: { max_price: 1500, category: "apparel.saree", ttl_seconds: 600 },
      prompt_playback: "Find a blue cotton saree under 1500",
    },
    keyring,
  );

  const cart = await buildCartMandate(
    intent,
    { item_id: "itm_001", final_price: { value: 1100, currency: "INR" }, merchant_id: "mer_001" },
    keyring,
  );

  const payment = await buildPaymentMandate(
    cart,
    {
      razorpay_order_id: "order_TESTdummy0001",
      razorpay_payment_id: "pay_TESTdummy0001",
      amount: 1100,
      currency: "INR",
      status: "captured",
    },
    keyring,
  );

  const fulfillment = await buildFulfillmentMandate(
    payment,
    { confirmed_by: "merchant", evidence_note: "Handed over in person, 30 Aug", evidence_photo_ref: null },
    keyring,
  );

  const chain: MandateChain = { transaction_id, intent, cart, payment, fulfillment };

  heading("Chain");
  const chainOk = await printChain(chain, keyring);

  // ── Tamper tests ──────────────────────────────────────────────────────────
  heading("Tamper tests");

  const results = [
    await tamperTest(
      "flip one character inside a signature",
      "reject",
      (c) => {
        const sig = c.cart!.buyer_agent_signature!;
        const i = sig.length - 5;
        const ch = sig[i] === "A" ? "B" : "A";
        c.cart!.buyer_agent_signature = sig.slice(0, i) + ch + sig.slice(i + 1);
      },
      chain,
      keyring,
    ),
    await tamperTest(
      "change the agreed price after both parties signed",
      "reject",
      (c) => {
        c.cart!.final_price.value = 100;
      },
      chain,
      keyring,
    ),
    await tamperTest(
      "swap a real buyer-agent signature onto a re-priced cart",
      "reject",
      async (c) => {
        const other = await buildCartMandate(
          intent,
          { item_id: "itm_001", final_price: { value: 100, currency: "INR" }, merchant_id: "mer_001" },
          keyring,
        );
        (other as CartMandate).buyer_agent_signature = c.cart!.buyer_agent_signature;
        c.cart = other;
      },
      chain,
      keyring,
    ),
    await tamperTest(
      "re-point the payment mandate at a different cart",
      "reject",
      (c) => {
        c.payment!.cart_mandate_hash = "sha256:" + "0".repeat(64);
      },
      chain,
      keyring,
    ),
    await tamperTest(
      "raise the captured amount above what was agreed",
      "reject",
      (c) => {
        c.payment!.amount = 99999;
      },
      chain,
      keyring,
    ),
    await tamperTest(
      "forge a fulfillment the merchant never signed",
      "reject",
      (c) => {
        delete c.fulfillment!.merchant_signature;
      },
      chain,
      keyring,
    ),
    await tamperTest(
      "drop the cart but keep payment and fulfillment",
      "reject",
      (c) => {
        delete c.cart;
      },
      chain,
      keyring,
    ),
    await tamperTest(
      "reorder a mandate's keys (control — not tampering, must still verify)",
      "accept",
      (c) => {
        const p = c.payment!;
        c.payment = {
          platform_signature: p.platform_signature,
          issued_at: p.issued_at,
          status: p.status,
          currency: p.currency,
          amount: p.amount,
          razorpay_payment_id: p.razorpay_payment_id,
          razorpay_order_id: p.razorpay_order_id,
          cart_mandate_hash: p.cart_mandate_hash,
          mandate_type: p.mandate_type,
        };
      },
      chain,
      keyring,
    ),
  ];

  // ── Verdict ───────────────────────────────────────────────────────────────
  const passed = results.filter(Boolean).length;
  heading("Milestone A — definition of done");
  console.log(`  ${chainOk ? g("✅") : r("❌")} full 4-mandate chain builds and verifies`);
  console.log(`  ${passed === results.length ? g("✅") : r("❌")} tamper tests: ${passed}/${results.length}`);
  console.log(`  ${dim("hash links:")} intent ${short(mandateHash(intent))} → cart → payment → fulfillment\n`);

  if (!chainOk || passed !== results.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
