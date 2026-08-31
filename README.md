# Vyapar-to-Agent

Makes UPI-only Indian merchants transactable by an AI buyer-agent, end to end — auto-generated agent-readable catalog, **bounded price negotiation**, gated Razorpay test-mode payment, and a cryptographically signed 4-mandate audit chain from first contact to confirmed handover.

> Razorpay AI Buildathon — Track 01 (AI Growth & Agentic Commerce)

## The gap

65–90 million Indian merchants accept payment through a UPI QR code and nothing else: no website, no catalog, no API. Every live agent-commerce protocol — Google's AP2, OpenAI's ACP, Google UCP — requires a structured product feed before an agent can even *see* a merchant. And all of them assume a fixed price, while ~85% of India's retail runs through kirana stores where **negotiation is the norm**, not the exception.

Two gaps, not one. This builds what has to exist before any agentic-commerce feature works for that segment.

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
| **I** | Real-time event bus + 3 live UI surfaces | ✅ done |
| **J** | Agent Readiness Score + multi-merchant marketplace | ✅ done |
| **K** | WhatsApp (Twilio) as the clarification channel | ✅ done |
| **L** | Razorpay webhook, signature-verified | ✅ done |
| **M** | Per-merchant QR | ✅ done |

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

None of them need an API key or Razorpay credentials to run.

Credentials, when you have them, go in `.env` (copy `.env.example`). Every script
loads it via `--env-file-if-exists`, so there is nothing to export and nothing
breaks when the file is absent:

- `GROQ_API_KEY` **or** `ANTHROPIC_API_KEY` — `milestone-b -- --live` runs the
  real extraction and writes `data/catalog.json`, which the server then serves.
  On Groq's free tier this takes about three minutes and prints progress: the
  token ceiling is 8,000/minute and a photo costs ~2,074, so the run is paced
  rather than fired off. See [docs/MODEL_LIMITS.md](docs/MODEL_LIMITS.md);
  `milestone-c -- --live` lets the model phrase the haggle. Groq wins if both
  are set; `LLM_PROVIDER=claude` forces the other. Defaults are
  `qwen/qwen3.8-27b` on Groq (vision + strict JSON) and `claude-opus-5`.
- `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` — orders are created against the real
  test-mode API and the UI settles them through Razorpay Checkout. Confirm it
  took: `curl localhost:3000/config` should say `"gateway":"razorpay"`.

With real Razorpay keys the CLI walkthrough stops at `awaiting_payment` and says
so — a `payment_id` only exists once someone pays in a browser, so the full path
runs in the UI. See [docs/RAZORPAY_SETUP.md](docs/RAZORPAY_SETUP.md).

## The four screens

| Page | Who it's for | Shows |
|---|---|---|
| `/` | walkthrough | one shop, one transaction, the signed chain |
| `/merchant.html` | the merchant | catalog as an agent sees it, questions waiting on them, readiness score, commerce history, live ticker |
| `/shop.html` | the buyer-agent | its own reasoning as it shops three merchants and picks one |
| `/market.html` | the wide shot | one buyer-agent, three shops, lines lighting up per event |

## API

| Endpoint | Stage | Does |
|---|---|---|
| `GET /merchants` | — | the three merchants, with readiness scores |
| `GET /merchants/:id/readiness` | J | agent-readiness breakdown |
| `GET /merchants/:id/commerce-history` | H | signed, verifiable trading record |
| `GET /merchants/:id/qr.png` | M | QR to that merchant's dashboard |
| `GET /clarifications` | G | open questions waiting on a merchant |
| `POST /clarifications/:id/reply` | G | the merchant's answer |
| `POST /marketplace/compare` | J | one intent, every merchant, one justified pick |
| `POST /webhooks/razorpay` | L | signature-verified `payment.captured` |
| `POST /webhooks/whatsapp` | K | inbound merchant replies from Twilio |
| `GET /events` | I | replay buffer for a late-joining viewer |
| `GET /catalog` | 1 | the agent-readable catalog, held items marked with why |
| `POST /discover` | 2 | deterministic filtered search |
| `POST /transactions` | 2–5a | find → haggle → sign → authorize an order, returns the negotiation log |
| `POST /transactions/:id/settle-payment` | 5b | verifies a Razorpay Checkout callback, then issues the Payment Mandate |
| `POST /transactions/:id/confirm-fulfillment` | 6 | merchant signs that the goods changed hands |
| `GET /transactions/:id/audit` | 7 | the full chain, re-verified at read time |
| `GET /config` | — | gateway kind and the publishable Razorpay Key ID, for Checkout |

On the simulated gateway `POST /transactions` settles immediately, since there
is no browser step to wait for. With real keys it stops at `awaiting_payment`
and the UI opens Razorpay Checkout; a `payment_id` only exists once someone
actually pays, so the transaction waits rather than inventing one.

## How the chain works

- **Signing** — ES256 JWS (`jose`), three separate keypairs: `buyer_agent`, `merchant`, `platform`. One backend plays all three roles for the hackathon, but the keys are genuinely distinct, because "the merchant signed this" is only evidence if it is distinguishable from "the buyer's agent signed this."
- **Canonicalization** — every hash and signature is taken over RFC 8785-style canonical JSON ([`canonical.ts`](src/mandates/canonical.ts)), never raw `JSON.stringify`. Key order is not content; if it changed a hash, the chain would break for reasons unrelated to tampering.
- **Ordered signatures** — on a cart mandate the merchant signs the bare cart, then the buyer-agent signs the cart *including the merchant's signature*. That nesting is what makes two signatures a binding between two parties instead of two unrelated assertions.
- **Verification checks two things per signature**, not one: that the JWS verifies against the expected role's key, *and* that the bytes it signed are byte-identical to the mandate in front of us. Skipping the second check would let a valid signature over some other payload pass — the token verifies while saying nothing about this mandate.
- **Hash links** cover the fully signed mandate, so a link commits to who signed as well as to what they signed.
- **A partial chain is a legitimate state.** A transaction with no fulfillment mandate reads `payment_confirmed_awaiting_fulfillment` and is never auto-marked delivered. A gap in the *middle* of the chain, however, is a failure.

## Layout

```
src/
  structuring/   Stage 1 — extraction, confidence scoring, the gate
  catalog/       Stage 2 — deterministic discovery
  negotiation/   Stage 3 — bounded haggling; LLM phrasing only
  mandates/      Stages 4/6 — schemas, canonical JSON, signing, chain verification
  payments/      Stage 5 — Razorpay gateway + the pre-payment gate
  fulfillment/   Stage 6 — merchant confirmation
  audit/         Stage 7 — the verified timeline
  db/            SQLite: transactions + append-only mandates
  server.ts      the API
scripts/         one runnable proof per milestone
data/            sample products, merchant policies, offline fixtures
```

## Where the AI is, and where it deliberately isn't

| Stage | Uses a model? | Why |
|---|---|---|
| 1 Structuring — draft | **yes** — vision + text | reading a photo and a Hinglish voice note is exactly what a model is for. Groq or Claude, same prompt and schema either way |
| 1 Structuring — sanity check | no | one LLM scoring its own confidence is one opinion checking itself. A z-score against the merchant's own prices is a second, independent, cheaper one |
| 1 Structuring — clarification | no | the question is built from which gate fired; the merchant answers it |
| 2 Discovery | no | a buyer-agent deserves an answer it can check; a filter is auditable, an embedding match isn't |
| 3 Negotiation | **only for phrasing** | the merchant set a floor — no model gets to talk the system below it. Every number is deterministic; phrasing that loses or changes a rupee figure is discarded |
| 4–7 Mandates, payment, fulfillment, audit | no | cryptography and money |

## Razorpay

The pipeline runs on a simulated gateway until you add test-mode keys; order and
payment IDs are prefixed `sim_` so a simulated payment can never be mistaken for
a real one. Adding `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` to `.env` switches
to real test-mode orders with no code change — see
[docs/RAZORPAY_SETUP.md](docs/RAZORPAY_SETUP.md), which also covers what a real
`payment_id` additionally requires.

## What's real vs. simulated

**Real:** all signing and verification, canonicalization, hash-linking, chain validation. This is the credibility core — there is no mocked `"signature": true` anywhere.

**Also real:** the price-sanity maths, the Socket.io event flow, the Razorpay webhook signature check, the Verified Commerce History signing, and WhatsApp Sandbox messages when Twilio is configured.

**Simulated (and stated plainly rather than hidden):** the three merchant personas run on one backend with separate keys; buyer-agent and merchant are likewise one process; voice notes start from pre-transcribed text rather than live speech-to-text; extraction confidence comes from hand-authored fixtures until you run `milestone-b -- --live`.

**Falls back rather than failing:** with no `GROQ_API_KEY`/`ANTHROPIC_API_KEY` the fixtures stand in. With no Twilio, clarification questions queue in the dashboard instead of WhatsApp — same question, same loop. With no Razorpay keys, the gateway is simulated and its IDs are prefixed `sim_` so they can never be mistaken for real ones.

## What broke, and how I got out

> Draft, from the build log — rewrite it in your own voice before submitting.

I built the pipeline bottom-up and had the negotiation stage passing all four of
its test cases: instant accept, converge-within-max-rounds, buyer walks away, and
rounds-exhausted no-deal. Green across the board. Then I wired up the demo UI and
clicked the "no deal" button, and instead of a no-deal I got a `402 payment
refused` — a *payment* error on a path that was never supposed to reach payment.

The refusal reason said the item's category was `home.towel`, outside the intent's
`apparel`. The buyer-agent had asked for a blue cotton saree and been offered a
**towel set**. Discovery matched anything sharing one query term, and "cotton" was
enough. So the real chain of events was: bad match → a full three-round
negotiation over the wrong product → refused at the payment gate on a category
check. The gate did its job. But finding out at the till that you have been
haggling over towels is not a system working correctly, it's a system being saved
by its last line of defence.

Two fixes were obvious — require a match to cover at least half the query, and
apply the Intent Mandate's category constraint at discovery instead of only at
payment. The third took longer to see. I had also written discovery to exclude
anything priced above the buyer's ceiling, which is exactly right for a catalog
with fixed prices and exactly wrong for this project: here the list price is an
opening ask, and an item above the ceiling is *precisely* the case negotiation
exists to resolve. I had imported an assumption from the world this project is
arguing against.

What actually convinced me was noticing the filter made a genuine `no_deal`
unreachable. If discovery only ever returns items whose list price is under the
buyer's ceiling, and the merchant's floor is by definition at or below the list
price, then the ceiling always sits above the floor and a deal is always
findable. My no-deal test case had been passing only because it called the
negotiation engine directly, bypassing discovery. The test was green and the
system was wrong.

The lesson I took: the tests I had written all exercised one stage at a time, and
every one of these bugs lived in the seam between two stages. The UI was the first
thing that made the pipeline run end to end, and it found three bugs in the first
click.

### Two smaller ones, for the record

**The audit trail disagreed with itself.** The negotiation's no-deal reason
quoted the buyer's best offer as ₹888 — a number appearing nowhere in the log the
reason was attached to. The loop advanced the offer after its final round and
exited without logging it. Harmless-looking, and completely corrosive to a
project whose whole claim is that the log is evidence.

**A gate I tested without testing.** My tamper test for "cart exceeds the buyer's
authorization" mutated a signed cart, so it was refused for a bad signature and
the authorization check never actually ran. It passed for the wrong reason. The
fix was to build a *validly signed* cart that simply asks for too much — which is
the real threat model anyway, since a merchant and a buyer-agent can both sign
something the buyer was never authorized to agree to.
