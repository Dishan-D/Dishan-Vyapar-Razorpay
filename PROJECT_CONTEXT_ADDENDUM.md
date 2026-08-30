# Project Context — Addendum 2
### Vyapar-to-Agent: Structuring Redesign, Verified Commerce History, Marketplace, and Real-Time Layer

Read `PROJECT_CONTEXT.md` first — this extends it with Milestones G through M. Everything here is additive; it does not change the four mandate schemas or the core pipeline order already implemented. Build in the order given; later milestones depend on earlier ones in this document.

**Filter applied to every addition below:** each piece is included because it does real work for the demo or the merchant, not because it looks impressive. Where something is cosmetic, it's labeled as such explicitly and kept deliberately small.

---

## Milestone G — Structuring, redesigned as a real pipeline (replaces the current single-call Stage 1)

**Why:** one LLM call scoring its own confidence is one opinion checking itself. A merchant's own price history and a real clarification channel are both stronger, cheaper, and more honest signals than asking the model to grade itself.

### G.1 — Five stages (replaces the current `structuring` module internals; the module's external contract — a Catalog Item in, per §4.1 of the original doc — does not change)

1. **Draft extraction** — unchanged. Vision + text LLM produces fields + per-field confidence.
2. **Deterministic sanity layer (new, no LLM)** — for `price`, compute a z-score against the merchant's existing items in the same `category`. If fewer than 3 prior items exist in that category, skip this check (not enough data, don't fabricate a baseline) and rely on LLM confidence alone. Flag `sanity_check: "pass" | "fail" | "skipped"`.
3. **Combined gate** — an item is `needs_merchant_confirmation: true` if EITHER `price.confidence < 0.6` OR `sanity_check == "fail"`. Log which condition triggered it — this matters for the clarification message in G.2.
4. **Clarification loop (new)** — for flagged items, construct a short, specific question (not "please review this item" — the actual ambiguity: *"Blue Cotton Saree — did you mean ₹1200 or ₹120?"* for a confidence failure, or *"Blue Cotton Saree at ₹120 — your other sarees are ₹900–1400, is this right?"* for a sanity failure). Send via the WhatsApp integration (Milestone K) if configured; otherwise the question is queued in the merchant dashboard (Milestone I) as a fallback — the loop must work with or without Twilio configured.
5. **Finalize** — merchant's one-word/short reply resolves the field; item re-runs the combined gate once with the corrected value (should now pass) and enters the transactable catalog. If no reply arrives within the demo window, item stays held — do not auto-resolve.

**Definition of done:** a seeded example (Amma's Snacks — see Milestone J persona data) deliberately trips both the confidence gate and the sanity gate on two different items, and both resolve correctly through the clarification loop in the demo walkthrough script.

### G.2 — Schema addition
```json
{
  "extraction": {
    "field": "price",
    "llm_confidence": 0.55,
    "sanity_check": "fail",
    "sanity_reason": "z-score 2.8 vs category mean 1150",
    "gate_result": "held",
    "clarification_sent": true,
    "clarification_channel": "whatsapp",
    "resolved_value": 1200,
    "resolved_at": "2026-08-30T10:16:00Z"
  }
}
```
This travels alongside the Catalog Item (§4.1), not inside it — keep the transactable catalog record clean; this is provenance/audit metadata, queryable separately.

---

## Milestone H — Verified Commerce History (the "long-run problem, fixed" novelty)

**The real problem:** cash-and-QR merchants have no verifiable transaction history. A raw UPI settlement total ("₹40,000 moved this month") tells a lender nothing about what was sold, at what price, or whether it was delivered without dispute — which is exactly why MSME alternative-data lending exists as a category and struggles to underwrite this segment. This project's mandate chain already produces something strictly better than a settlement line, for free, as a byproduct: a signed record of what was actually sold and confirmed delivered.

**What to build:** you are NOT building a lending product. You're building one export/report endpoint that repackages data you already have.

### H.1 — Endpoint
`GET /merchants/:id/commerce-history`
Aggregates every completed 4-mandate chain for a merchant over a period into:
```json
{
  "merchant_id": "mer_001",
  "period": { "from": "2026-08-01", "to": "2026-08-30" },
  "completed_transactions": 14,
  "total_verified_value": 15400,
  "fulfillment_confirmation_rate": 0.93,
  "negotiation_avg_discount_pct": 8.2,
  "dispute_free_rate": 1.0,
  "signed_report_hash": "sha256:...",
  "generated_at": "2026-08-30T11:00:00Z",
  "verification_note": "Every transaction below is backed by a signed 4-mandate chain: buyer intent, agreed cart, captured payment, confirmed fulfillment."
}
```
Sign the whole report (same ES256/jose pattern as the mandates) so it's itself a verifiable artifact — a merchant can hand this PDF/JSON to anyone and it's checkable, not just an internal dashboard number.

### H.2 — Where it shows up in the demo
One panel on the Merchant Dashboard (Milestone I): "Your Verified Commerce History — exportable, signed, ready for a lender." This is a 20-second beat in Act 2 of the pitch, not a separate act — say the sentence, show the panel, move on. It lands because it's obviously true given everything already on screen, not because it's explained at length.

**Definition of done:** after running the demo's seeded transactions, hitting the endpoint returns a correctly aggregated, correctly signed report; tampering with one field and re-verifying fails, same as the mandate tamper tests.

---

## Milestone I — Real-time event layer

**Why this earns its place:** a stats console doesn't show a merchant experiencing anything. Watching a dashboard update live, unprompted, is the difference between "we log everything" and "look, it's happening right now."

### I.1 — Event bus
Socket.io server attached to the existing Express app. Every stage transition that already writes to SQLite also emits an event on a per-`transaction_id` room:
```
extraction.completed | extraction.held | clarification.sent | clarification.resolved
discovery.queried
negotiation.offer_made | negotiation.countered | negotiation.agreed | negotiation.no_deal
payment.order_created | payment.captured (via webhook, see Milestone L)
fulfillment.confirmed
audit.chain_verified
```
No new logic — this is a thin publish layer over state changes that already exist. Don't let this migration touch the pipeline stages themselves.

### I.2 — Merchant Dashboard (new frontend surface)
Per-merchant view, subscribes to that merchant's events. Shows: catalog with live confidence/gate status, Agent Readiness Score (Milestone J) updating in real time as items resolve, a live ticker of negotiation events as they happen ("Buyer agent viewing your saree... offer ₹1000... you countered ₹1150... deal at ₹1100"), and the Verified Commerce History panel (Milestone H).

### I.3 — Shopper Client (new frontend surface)
Buyer-agent's-eye view, chat-thread styled, narrates its own reasoning as events stream: "Checking Meena's Sarees... Checking Rafiq Mobile Accessories... comparing 2 offers... selecting Meena's Sarees — better price, higher reliability score." This is where the marketplace comparison (Milestone K) becomes visible rather than something you narrate over a slide.

### I.4 — Wide-shot visualization (cosmetic, keep small)
A single static page, no interactivity: buyer-agent node in the center, merchant nodes around it, animated lines lighting up on each event via the same Socket.io connection. Budget: ~100 lines, one afternoon. This is explicitly the one piece in this whole addendum that's mostly for the wide establishing shot at the start of Act 3 of the pitch — don't over-invest in it.

**Definition of done:** running one seeded transaction end to end with the Merchant Dashboard and Shopper Client open in two browser windows shows both updating live, in the correct order, with no manual refresh.

---

## Milestone J — Agent Readiness Score + multi-merchant marketplace

**Why together:** the score is inert until something uses it to make a decision. Pair them.

### J.1 — Readiness Score (0–100)
Computed per merchant from data you already have — no new tracking needed:
- Catalog completeness/confidence (average resolved confidence across items, post-clarification)
- Negotiation policy coverage (% of catalog with a set floor/list price vs. still using defaults)
- Fulfillment reliability (`fulfillment_confirmation_rate` from Milestone H)
Weight these however's defensible (equal weighting is fine — state that plainly rather than inventing false precision).

### J.2 — Marketplace comparison
Given one buyer intent, query 2–3 merchant storefronts in parallel (see persona data below), run Discovery + Negotiation independently against each, then select using a policy that weighs `final_price` against `readiness_score` — not price alone. Log the unselected merchant's outcome too; the demo should show the comparison actually happened, not just the winner.

### J.3 — Three merchant personas (seed data)
- **Meena's Sarees** (Jaipur) — tight floor price, low `max_rounds`, high fulfillment confirmation rate → high readiness score
- **Rafiq Mobile Accessories** (Bangalore) — wide negotiation band, a couple of unconfirmed fulfillments in history → mid readiness score
- **Amma's Snacks** (Chennai) — deliberately messy input (no photos for two items, ambiguous voice notes) → exercises Milestone G's clarification loop live

**Definition of done:** one buyer intent run against all three personas produces two independent negotiation logs plus one correctly justified selection, visible in both the Shopper Client and the wide-shot visualization.

---

## Milestone K — WhatsApp integration (Twilio Sandbox)

**Why this earns its place now, specifically:** as a standalone "sale confirmed" notification it was cosmetic — cut. As the actual channel for Milestone G's clarification loop, it's load-bearing: it's the one real input mechanism a kirana merchant would plausibly use, and it's genuinely how the item-resolution loop closes in production, not just in the demo.

**Setup:** Twilio Sandbox for WhatsApp (free tier, ~10 min): join sandbox from a test phone, get sandbox number + auth token, set `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_WHATSAPP_FROM` in `.env`.

**Two message types only** (don't scope-creep this into a chatbot):
1. Clarification question (Milestone G.2) — outbound, expects a short reply.
2. Sale confirmation ("✅ Sale confirmed! Blue Cotton Saree, ₹1100.") — outbound only, fires on `payment.captured`.

**Graceful degradation:** if Twilio keys are absent, both message types fall back to the in-dashboard queue (Milestone I.2) — the pipeline must never block on WhatsApp being configured. Say this plainly in the README, same pattern as the Groq/Claude fallback already in place.

---

## Milestone L — Razorpay webhook

**Why real, not polled:** `payment.captured` currently gets checked for; a registered webhook means Razorpay tells you, which is both a more honest architecture and a real integration point to point to on camera ("this isn't simulated — that's Razorpay's server calling ours").

Register a webhook endpoint (`POST /webhooks/razorpay`), verify the webhook signature (Razorpay provides a signing secret, verify via HMAC — same rigor as your existing Checkout callback verification in Stage 5, reuse that pattern), and on a verified `payment.captured` event, transition the transaction state and emit `payment.captured` on the event bus. In test mode, trigger this via Razorpay's dashboard test-webhook tool or by completing a real test-mode checkout — no mocking needed.

**Definition of done:** a signed test webhook event correctly transitions state and appears live in the Merchant Dashboard; an unsigned/forged webhook payload is rejected, and you have a tamper test proving it (same style as your existing 8 tamper tests — this becomes test #9).

---

## Milestone M — QR code (cosmetic, keep cheap)

`qrcode` npm package, no external service. Generate one QR per merchant linking to their dashboard. Use it exactly once in the pitch: Act 1 shows the merchant's real UPI QR sticker; Act 2's close shows this new QR, framed as "same sticker, now it opens onto something an agent can read too." One `<img>` tag, done — don't build QR scanning or anything interactive around it.

---

## Suggested build order (given what's already shipped)

1. **G** (structuring redesign) — touches existing code the most, do it while context is fresh
2. **L** (Razorpay webhook) — small, self-contained, unblocks accurate `payment.captured` events for everything downstream
3. **I.1** (event bus) — infrastructure everything else displays through
4. **H** (Verified Commerce History) — pure aggregation over existing data, fast to build once G is stable
5. **J** (readiness score + marketplace) — depends on H's fulfillment-rate figure
6. **K** (WhatsApp) — wire in once G's clarification loop needs a real channel
7. **I.2, I.3, I.4** (the three UI surfaces) — last, once every event they display actually fires correctly
8. **M** (QR) — anytime, 30 minutes, do it last

## What to explicitly say in the README/demo about what's real vs. simulated (extend the existing honesty pattern)

- Real: mandate signing/verification, Razorpay test-mode payment + webhook, sanity-check math, Socket.io event flow, WhatsApp Sandbox messages (if Twilio configured), Verified Commerce History signing.
- Simulated for demo speed, stated plainly: three merchant personas run on one backend with separate keys; voice notes pre-transcribed; clarification replies in the demo script are pre-timed rather than waiting on a live human reply.
