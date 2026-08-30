# Vyapar-to-Agent

Makes UPI-only Indian merchants transactable by an AI buyer-agent, end to end — auto-generated agent-readable catalog, **bounded price negotiation**, gated Razorpay test-mode payment, and a cryptographically signed 4-mandate audit chain from first contact to confirmed handover.

> Razorpay AI Buildathon — Track 01 (AI Growth & Agentic Commerce)

## The gap

65–90 million Indian merchants accept payment through a UPI QR code and nothing else: no website, no catalog, no API. Every live agent-commerce protocol — Google's AP2, OpenAI's ACP, Google UCP — requires a structured product feed before an agent can even *see* a merchant. And all of them assume a fixed price, while ~85% of India's retail runs through kirana stores where **negotiation is the norm**, not the exception.

Two gaps, not one. This builds what has to exist before any agentic-commerce feature works for that segment.

See [PROJECT_CONTEXT.md](PROJECT_CONTEXT.md) for the full spec: pipeline, schemas, and build sequence.

## Status

| Milestone | Scope | State |
|---|---|---|
| **A** | Mandate chain — sign, hash-link, verify, tamper-test | ✅ done |
| **B** | Structuring agent — photo + voice note → catalog, confidence gating | ✅ done |
| **C** | Discovery + bounded negotiation | ✅ done |
| **D** | Mandates → gated Razorpay test-mode payment | ✅ done |
| **E** | Fulfillment loop + audit view, over HTTP, persisted in SQLite | ✅ done |
| F | Demo frontend + pre-seeded scenarios | not started |

Each milestone is a runnable proof, not a claim:

```bash
npm install
npm run milestone-a   # signed 4-mandate chain + 8 tamper tests
npm run milestone-b   # structuring agent + confidence gate
npm run milestone-c   # discovery + 4 negotiation cases
npm run milestone-d   # mandates → payment, with the gate tested
npm run milestone-e   # fulfillment + audit, end to end over HTTP
npm run serve         # the API on :3000
```

None of them need an API key or Razorpay credentials to run. With
`ANTHROPIC_API_KEY` set, `milestone-b -- --live` runs the real extraction and
`milestone-c -- --live` lets Claude phrase the haggle. With
`RAZORPAY_KEY_ID`/`RAZORPAY_KEY_SECRET` set, orders are created against the real
test-mode API.

## API

| Endpoint | Stage | Does |
|---|---|---|
| `GET /catalog` | 1 | the agent-readable catalog, held items marked with why |
| `POST /discover` | 2 | deterministic filtered search |
| `POST /transactions` | 2–5 | find → haggle → sign → pay, returns the negotiation log |
| `POST /transactions/:id/confirm-fulfillment` | 6 | merchant signs that the goods changed hands |
| `GET /transactions/:id/audit` | 7 | the full chain, re-verified at read time |

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
| 1 Structuring | **yes** — vision + text | reading a photo and a Hinglish voice note is exactly what a model is for |
| 2 Discovery | no | a buyer-agent deserves an answer it can check; a filter is auditable, an embedding match isn't |
| 3 Negotiation | **only for phrasing** | the merchant set a floor — no model gets to talk the system below it. Every number is deterministic; phrasing that loses or changes a rupee figure is discarded |
| 4–7 Mandates, payment, fulfillment, audit | no | cryptography and money |

## What's real vs. simulated

**Real:** all signing and verification, canonicalization, hash-linking, chain validation. This is the credibility core — there is no mocked `"signature": true` anywhere.

**Simulated (and stated plainly rather than hidden):** merchant and buyer-agent run as one backend with separate keys; voice notes start from pre-transcribed text rather than live speech-to-text.

## What broke, and how I got out

<!-- TODO: write this from what actually happens while building B–F. It gets read
     first, and a clean story reads as fabricated. Keep the awkward middle. -->
