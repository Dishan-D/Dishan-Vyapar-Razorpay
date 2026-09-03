# Vyapar-to-Agent

Makes UPI-only Indian merchants transactable by an AI buyer-agent, end to end — an auto-generated agent-readable catalog, **bounded price negotiation**, gated Razorpay test-mode payment, a cryptographically signed 4-mandate audit chain from first contact to confirmed handover, and a merchant assistant that answers in plain language from those same signed chains.

> Razorpay AI Buildathon — Track 01 (AI Growth & Agentic Commerce)

## The gap

India has roughly **13 million kirana stores** — 88% of its retail. **678 million UPI QR codes** are deployed and **93%** of Tier-2 shops already take digital payments. Payments are solved.

But everything a machine can read about one of these shops is a single string: a UPI ID. It moves money and describes nothing — not what is for sale, what it costs, whether any is left, or whether the shopkeeper would take less.

Every live agent-commerce protocol — Google's **AP2** (Sept 2025, 60+ partners), OpenAI's ACP, Google UCP — requires a structured product feed before an agent can even *see* a merchant. All of them also assume a fixed price, while in this segment **negotiation is the norm**.

Two gaps, not one. This builds what has to exist before any agentic-commerce feature works for that segment. Figures and sources: [docs/PITCH.md](docs/PITCH.md).

See [PROJECT_CONTEXT.md](PROJECT_CONTEXT.md) for the core spec and
[PROJECT_CONTEXT_ADDENDUM.md](PROJECT_CONTEXT_ADDENDUM.md) for Milestones G–M.

## Status

| Milestone | Scope | State |
|---|---|---|
| **A** | Mandate chain — sign, hash-link, verify, tamper-test | ✅ done |
| **B** | Structuring agent — photo + voice note → catalog, confidence gating | ✅ done |
| **C** | Discovery + bounded negotiation | ✅ done |
| **D** | Mandates → gated Razorpay test-mode payment | ✅ done |
| **E** | Fulfillment loop + audit view, over HTTP, persisted in SQLite | ✅ done |
| **F** | Demo frontend + CLI walkthrough + pre-seeded scenarios | ✅ done |
| **G** | Structuring as a 5-stage pipeline: sanity check + clarification loop | ✅ done |
| **H** | Verified Commerce History — signed, exportable | ✅ done |
| **I** | Real-time event bus + live UI surfaces | ✅ done |
| **J** | Agent Readiness Score + multi-merchant marketplace | ✅ done |
| **K** | WhatsApp (Twilio) as the clarification channel | ✅ done |
| **L** | Razorpay webhook, signature-verified | ✅ done |
| **M** | Per-merchant QR | ✅ done |
| **N** | Merchant assistant — deterministic routing, tool registry, idempotent actions | ✅ done |
| **O** | Analytics derived from signed chains + six-month demo dataset | ✅ done |

**84 HTTP endpoints · 65 TypeScript files · ~17,800 lines of `src` · 6 merchants · 11,220 signed demo transactions.**

Each milestone is a runnable proof, not a claim:

```bash
npm install
npm run milestone-a   # signed 4-mandate chain + 8 tamper tests
npm run milestone-b   # structuring agent + confidence gate
npm run milestone-c   # discovery + 4 negotiation cases
npm run milestone-d   # mandates → payment, with the gate tested
npm run milestone-e   # fulfillment + audit, end to end over HTTP
npm run milestone-g   # sanity gate + clarification loop
npm run milestone-h   # signed commerce history + tamper test
npm run milestone-i   # realtime: two windows, correct order, scoped rooms
npm run milestone-j   # readiness scores + marketplace comparison
npm run milestone-k   # WhatsApp clarification loop
npm run milestone-l   # Razorpay webhook + tamper test #9

npm run serve         # API + demo UI on http://localhost:3000
npm run demo          # the same walkthrough in the terminal, for recording
```

And four checks that re-derive the claims rather than restating them:

```bash
npm run audit           # 60 claims against the running system; fuzzes the
                        # negotiation bounds over 500 randomised policies
npm run check:analytics # every product figure re-derived from the signed chains
npm run check:demo      # 25 checks on the generated dataset
npm run check:frontend  # 5 pages: element ids, CSS brace balance, highlight rules
```

None of them need an API key or Razorpay credentials to run.

### Demo data

```bash
npm run seed:history    # six months of signed history for the six demo shops
npm run demo:reset      # restock the demo shelf between rehearsals
node scripts/prune-merchants.mjs --apply   # drop shops left behind by onboarding rehearsals
```

The history is **generated, not faked**: every order runs through the production negotiation engine and becomes four genuinely signed ES256 mandates with backdated timestamps. There is no second path into the analytics. Deterministic — the same dataset on every reset.

### Credentials

Credentials go in `.env` (copy `.env.example`). Every script loads it via
`--env-file-if-exists`, so there is nothing to export and nothing breaks when the
file is absent:

- `GROQ_API_KEY` **or** `ANTHROPIC_API_KEY` — powers extraction, transcription, intent parsing and phrasing. On Groq's free tier the token ceiling is **8,000/minute per organisation** and a photo costs ~2,074, so every call is paced by a rate governor rather than fired off. See [docs/MODEL_LIMITS.md](docs/MODEL_LIMITS.md). Groq wins if both are set; `LLM_PROVIDER=claude` forces the other. Defaults are `qwen/qwen3.8-27b` on Groq (vision + strict JSON), `whisper-large-v3-turbo` for voice, and `claude-opus-5`.
- `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` — **test mode only; a live key is refused at startup.** Orders are created against the real API and the UI settles them through Razorpay Checkout. Confirm it took: `curl localhost:3000/config` should say `"gateway":"razorpay"`.
- `TWILIO_*` — optional. Without it, clarification questions queue in the dashboard instead of WhatsApp. Same question, same loop.

With real Razorpay keys the CLI walkthrough stops at `awaiting_payment` and says
so — a `payment_id` only exists once someone pays in a browser, so the full path
runs in the UI. See [docs/RAZORPAY_SETUP.md](docs/RAZORPAY_SETUP.md).

## The four screens

| Page | Who it's for | Shows |
|---|---|---|
| `/` | the pitch | the gap, before/after for one shop, live activity |
| `/onboard.html` | a new merchant | three steps, four ways in: photos, voice, text, or one-by-one |
| `/store.html` | the buyer | shelf + chat + cart; the agent's negotiation marked on each shop's card |
| `/merchant.html` | the merchant | **Simple** (ask anything in plain language) and **Insights** (six panes: Today, Catalog, Money, Grow, Trust, Assistant) |

`/shop.html` is a single-shot buyer-agent run with its full trace and the signed audit drawer — kept for demonstrating the chain in isolation.

## API

84 endpoints. The ones that carry the argument:

| Endpoint | Stage | Does |
|---|---|---|
| `GET /catalog` | 1 | the agent-readable catalog, held items marked with why |
| `POST /onboarding/merchants/:id/structure` | 1 | photos + voice + text → typed products with confidence |
| `POST /discover` | 2 | deterministic filtered search |
| `POST /discover/compare-modes` | 2 | the same query against raw voice notes vs. the built catalog |
| `POST /agent/assist` | 2–4 | the buyer's conversational agent, 12 tools, purchases only proposed |
| `POST /agent/run` | 2–5 | one sentence → every shop haggled with → signed → order opened |
| `POST /marketplace/compare` | J | one intent, every merchant, one justified pick |
| `POST /transactions/:id/settle-payment` | 5b | verifies a Razorpay Checkout callback, then issues the Payment Mandate |
| `POST /webhooks/razorpay` | L | signature-verified `payment.captured`, HMAC over raw bytes |
| `POST /transactions/:id/confirm-fulfillment` | 6 | merchant signs that the goods changed hands |
| `GET /transactions/:id/audit` | 7 | the full chain re-verified at read time, **with the public JWKs** |
| `POST /merchants/:id/agent` | N | the merchant assistant — routes, looks up, proposes |
| `POST /merchants/:id/actions/:id/confirm` | N | the press that makes a write happen, idempotent by action id |
| `GET /merchants/:id/trend` | O | a period against the one before it, with what actually moved |
| `GET /merchants/:id/revenue-agent` | O | cross-sell, upsell and dead stock, each with checkable factors |
| `GET /analytics/integrity` | O | does any of it contradict itself? |
| `GET /razorpay/capabilities` | — | five read-only probes: what this account can actually do |

## How the chain works

- **Signing** — ES256 JWS (`jose`), three separate keypairs: `buyer_agent`, `merchant`, `platform`. One backend plays all three roles for the hackathon, but the keys are genuinely distinct, because "the merchant signed this" is only evidence if it is distinguishable from "the buyer's agent signed this."
- **Canonicalization** — every hash and signature is taken over RFC 8785-style canonical JSON ([`canonical.ts`](src/mandates/canonical.ts)), never raw `JSON.stringify`. Key order is not content; if it changed a hash, the chain would break for reasons unrelated to tampering.
- **Ordered signatures** — on a cart mandate the merchant signs the bare cart, then the buyer-agent signs the cart *including the merchant's signature*. That nesting is what makes two signatures a binding between two parties instead of two unrelated assertions.
- **Verification checks two things per signature**, not one: that the JWS verifies against the expected role's key, *and* that the bytes it signed are byte-identical to the mandate in front of us. Skipping the second check would let a valid signature over some other payload pass — the token verifies while saying nothing about this mandate.
- **Hash links** cover the fully signed mandate, so a link commits to who signed as well as to what they signed.
- **One gate moves money.** `checkAuthority` compares the shopper-signed intent against the merchant-signed cart — two documents the agent did not author. It runs before the gateway exists in that function's world, and again at settlement, because "we checked a moment ago" is not a property of the object in front of you.
- **A partial chain is a legitimate state.** A transaction with no fulfillment mandate reads `payment_confirmed_awaiting_fulfillment` and is never auto-marked delivered. A gap in the *middle* of the chain, however, is a failure.

## Layout

```
src/
  structuring/   Stage 1 — extraction, OCR, transcription, confidence gate, clarifications
  catalog/       Stage 2 — deterministic discovery
  negotiation/   Stage 3 — bounded haggling; LLM phrasing only
  mandates/      Stages 4/6 — schemas, canonical JSON, signing, chain verification
  payments/      Stage 5 — Razorpay gateway, the pre-payment gate, links + invoices
  fulfillment/   Stage 6 — merchant confirmation
  audit/         Stage 7 — the verified timeline, signed commerce history
  agent/         buyer loop, intent parsing, merchant supervisor + tool registry
  analytics/     the single ledger: chains in, every merchant figure out
  revenue/       Revenue Agent — cross-sell, upsell, dead stock, elasticity, recovery
  marketplace/   readiness scoring, multi-merchant comparison
  merchant/      idempotent action executor, UPI QR parsing
  finance/       UPI reconciliation, statements
  risk/          payment risk signals and interventions
  demo/          the six business stories and the signed history generator
  llm/           provider selection, rate governor
  events/        Socket.io bus with replay
  db/            SQLite: transactions + append-only mandates
  server.ts      the API
scripts/         milestone proofs, audits, demo data tooling
data/            sample products, merchant policies, offline fixtures
docs/            see below
```

## Where the AI is, and where it deliberately isn't

**Nine model call sites, all confined to language.** No model chooses a price, selects a merchant, authorizes a payment, or writes to the catalog.

| Stage | Uses a model? | Why |
|---|---|---|
| 1 Structuring — draft | **yes** — vision + text | reading a photo and a Hinglish voice note is exactly what a model is for |
| 1 OCR | no — local Tesseract | it either reads the characters or returns nothing. A vision model paraphrases a price tag, and a paraphrased price is a wrong price |
| 1 Sanity check | no | one LLM scoring its own confidence is one opinion checking itself. A z-score against the merchant's own prices is a second, independent, cheaper one |
| 2 Discovery | no | a buyer-agent deserves an answer it can check; a filter is auditable, an embedding match isn't |
| 3 Negotiation | **only for phrasing** | the merchant set a floor — no model gets to talk the system below it. Phrasing that loses or changes a rupee figure is discarded for a template |
| 4 Intent parsing | **yes**, then clamped | the model may *read* the shopper's ceiling; it may never widen it. Any requirement not traceable to their own words is discarded |
| 4–7 Mandates, payment, fulfillment, audit | no | cryptography and money |
| N Merchant routing | no — regex | "how much did I make today" is answered in **~275ms and zero tokens** |
| N Merchant phrasing | **yes**, for multi-source answers only | given only the sentences the tools produced, never the raw rows |
| O Analytics, Revenue Agent | no | every factor is a sentence a merchant can check |

## Razorpay

The pipeline runs on a simulated gateway until you add test-mode keys; order and
payment IDs are prefixed `sim_` so a simulated payment can never be mistaken for
a real one. Adding `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` to `.env` switches
to real test-mode orders with no code change.

Used: `orders.create` / `fetch` / `fetchPayments`, `payments.fetch` / `capture`,
`validatePaymentVerification`, `validateWebhookSignature`, hosted Checkout,
Payment Links, Invoices, Settlements.

**Capability is probed, never claimed.** `GET /razorpay/capabilities` makes five
read-only calls and reports what came back — including telling a product this
account has not enabled (`400`) apart from a path that is wrong on our side
(`404`). Mocking them would have been easy and would have been the one thing this
project cannot afford. See [docs/RAZORPAY_SETUP.md](docs/RAZORPAY_SETUP.md).

## What's real vs. simulated

**Real:** all signing and verification, canonicalization, hash-linking, chain validation. There is no mocked `"signature": true` anywhere. Razorpay orders, Checkout signature verification, webhook HMAC over raw bytes, Payment Links and Invoices. Voice notes transcribed by Whisper. OCR by Tesseract, locally. Every negotiation bound. Every merchant and product statistic, recomputed from signed chains on each read — **there is no revenue counter in this system.**

**Simulated, and stated plainly rather than hidden:** the six merchant personas run on one backend with separate keys; buyer-agent and merchant are likewise one process. The `sim_` settlement rail, labelled `Gateway · Simulated` wherever it appears. The UPI settlement feed, labelled as generated on the endpoint and the screen. The six months of buyer history — synthetic buyers, but every price is one the production engine agreed to, and every chain verifies.

**Falls back rather than failing:** with no model key the fixtures and rule-based parsers stand in, and say they are being used. With no Twilio, clarifications queue in the dashboard. With no Razorpay keys, the gateway is simulated and its IDs are prefixed `sim_`.

**Not built:** authentication — every endpoint is open, and merchant identity is a URL parameter. No key rotation. One `item_id` per cart mandate, so one order is one product and a basket is several separately signed chains. No refunds. Local deployment only.

## Documentation

| File | What it is |
|---|---|
| [docs/PITCH.md](docs/PITCH.md) | the problem, the sourced figures, and how this differs from AP2 / ONDC / marketplaces |
| [docs/BUILD_LOG.md](docs/BUILD_LOG.md) | what was built, in order |
| [docs/CHALLENGES.md](docs/CHALLENGES.md) | **77 logged faults** — what broke, why, and the fix |
| [docs/DEMO.md](docs/DEMO.md) | how to run and check the demo |
| [docs/DEMO_10MIN.md](docs/DEMO_10MIN.md) | the run sheet: prompts in order, what each proves, failure recovery |
| [docs/PROJECT_BRIEF.md](docs/PROJECT_BRIEF.md) | the whole system in one document |
| [docs/MERCHANT_UI.md](docs/MERCHANT_UI.md) · [docs/BUYER_UI.md](docs/BUYER_UI.md) | screen-by-screen walkthroughs |
| [docs/GLOSSARY.md](docs/GLOSSARY.md) | every technical term used, defined |
| [docs/SETUP.md](docs/SETUP.md) · [docs/RAZORPAY_SETUP.md](docs/RAZORPAY_SETUP.md) | getting it running |
| [docs/MODEL_LIMITS.md](docs/MODEL_LIMITS.md) · [docs/PHOTO_GUIDE.md](docs/PHOTO_GUIDE.md) | measured token ceilings and OCR guidance |

## What broke, and how I got out

The full account is [docs/CHALLENGES.md](docs/CHALLENGES.md) — 77 entries, each
with what broke, why, and the fix. One sentence covers most of it: **almost every
hard bug was a place where the system was confidently wrong rather than visibly
broken.** A crash announces itself; a catalog that quietly drops seven of a
merchant's ten photos looks exactly like a working system.

The one that set the pattern. The negotiation stage passed all four of its test
cases — instant accept, converge-within-max-rounds, buyer walks away,
rounds-exhausted no-deal. Green across the board. Then I wired up the UI, clicked
"no deal", and got a `402 payment refused` — a *payment* error on a path that was
never supposed to reach payment.

The refusal said the item's category was `home.towel`, outside the intent's
`apparel`. The buyer-agent had asked for a blue cotton saree and been offered a
**towel set**: discovery matched anything sharing one query term, and "cotton" was
enough. So the real sequence was bad match → a full three-round negotiation over
the wrong product → refused at the till on a category check. The gate did its job.
But finding out at the till that you have been haggling over towels is not a
system working correctly, it is a system saved by its last line of defence.

Two fixes were obvious: require a match to cover at least half the query, and
apply the category constraint at discovery instead of only at payment. The third
took longer. I had also written discovery to exclude anything priced above the
buyer's ceiling — exactly right for a fixed-price catalog and exactly wrong here,
where the list price is an opening ask and an item above the ceiling is *precisely*
the case negotiation exists to resolve. I had imported an assumption from the
world this project argues against.

What convinced me was noticing the filter made a genuine `no_deal` unreachable. If
discovery only returns items under the buyer's ceiling, and the merchant's floor
is by definition at or below the list price, the ceiling always sits above the
floor and a deal is always findable. My no-deal test had been passing only because
it called the engine directly, bypassing discovery. The test was green and the
system was wrong.

The lesson: every one of those bugs lived in the seam between two stages, and all
my tests exercised one stage at a time. The UI was the first thing that ran the
pipeline end to end, and it found three bugs in the first click. That is why
`scripts/audit.ts` now re-derives 60 claims against the running system instead of
testing units in isolation.
