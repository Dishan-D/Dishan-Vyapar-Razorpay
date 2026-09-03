# Project Context: Vyapar-to-Agent
### Razorpay AI Buildathon — Track 01 (AI Growth & Agentic Commerce)

**Read this whole document before writing any code.** It contains the problem framing, the research that grounds it, the full pipeline design, exact data schemas, tech stack, build sequencing, and acceptance criteria. Treat this as the spec. Ask clarifying questions before making architectural decisions not covered here — don't silently improvise on the schemas or pipeline order.

> **Kept as originally written**, because the code cites its section numbers
> throughout. One correction: the "~65–90 million merchants" figure below was
> never sourced. The sourced number is **~13 million kirana stores, 88% of
> Indian retail** (Invest India) — see `docs/PITCH.md` for that and every other
> figure with its source. Use the sourced one when presenting.

---

## 1. One-paragraph pitch

Most agentic-commerce infrastructure (Google AP2, OpenAI ACP, Google UCP) assumes a merchant already has a structured, machine-readable product catalog and a fixed price. That assumption excludes the ~65–90 million Indian merchants (kirana stores, street vendors, WhatsApp-first sellers) who accept payment only via a UPI QR code and have no catalog, no API, and no website — and whose retail culture runs on **negotiated, not fixed, prices**. Vyapar-to-Agent is an end-to-end pipeline that (1) auto-generates a structured, agent-readable catalog from a merchant's existing unstructured input (photos, voice notes, a bare Payment Page), (2) lets an AI buyer-agent discover and **negotiate** within a merchant-set bounded policy — modeling India's actual bargaining-based retail culture, which no existing protocol does — (3) executes a bounded, gated payment via Razorpay's test-mode Orders API, (4) closes the loop with a merchant-confirmed **fulfillment mandate** (since these merchants have no trackable shipping API), and (5) produces a fully signed, auditable evidence chain from first contact to confirmed delivery.

---

## 2. Problem framing and research grounding (for README / pitch, cite these in your own words — do not copy verbatim)

- NPCI + BCG estimate UPI QR/soundbox infrastructure brought **65–70 million merchants** onto digital payments, mostly roadside vendors, tea stalls, and kirana stores. A government-commissioned study (Feb 2026) found **94% of small merchants surveyed** have adopted UPI. Worldline puts the active UPI merchant network above **90 million**. Source class: NPCI/BCG report, PIB, government survey, Worldline.
- None of these merchants have structured product data. Every major agent-commerce protocol requires it: OpenAI's ACP requires a merchant-pushed CSV/JSON feed refreshed every 15 minutes with GTINs and structured attributes; non-Shopify merchants must submit catalogs manually. Even organized e-commerce catalogs fail this bar often — an estimated 60% of catalogs have missing GTINs or inconsistent attributes, enough to get a product silently excluded from AI agent discovery, "no second chance, no close enough."
- Existing India-specific tools (e.g., WhatsApp catalog AI generators like StitchMagic) solve the *human-readable* version of this problem — pretty catalogs for a person to scroll — but produce no machine-queryable, protocol-compliant, transaction-capable output. That's the specific gap this project fills.
- Retail behavior gap: fixed-price agent protocols assume no negotiation. But per BCG, **~85% of India's $850B+ retail market routes through kirana stores**, where "negotiation flexibility remains a top priority," and bargaining is documented as a defining, expected, culturally normal behavior in unorganized retail — distinct from organized retail (malls, branded stores) where it doesn't happen. This is the justification for the negotiation stage.
- Adoption trend backing the "why now": Gartner projects 20% of digital commerce transactions will run through AI platforms by 2030 and 90% of B2B purchasing will be AI-agent-mediated by 2028 (~$15T). Shopify saw AI-driven store traffic grow 8x YoY in Q1 2026. Razorpay itself already runs live pilots with NPCI + Claude (UPI Reserve Pay-based) and NPCI + OpenAI/ChatGPT. This isn't speculative infrastructure — it's already shipping, just not for this merchant segment.
- Dispute/evidence angle: industry sources (Chargeflow, Justt) note agentic commerce chargebacks have no established liability framework yet ("the consumer, the AI provider, and the merchant could all share responsibility... no framework cleanly assigns it"). Google's AP2 protocol addresses this with a chain of cryptographically signed "mandates" (Intent → Cart → Payment) as dispute evidence. This project extends that model with a **Fulfillment Mandate**, because AP2 assumes trackable shipping/fulfillment APIs, which informal merchants don't have.

**Track fit:** Track 01's actual ask is "build an agent that grows revenue... **or that makes a merchant transactable by an AI buyer end to end.**" The track's example directions (conversational checkout, agent-readable catalog, upsell agent, campaign orchestrator) all assume the merchant already has structured data to expose. This project builds what's missing *before* any of those examples become possible for this merchant segment — it satisfies the track's actual goal via an unaddressed angle, not one of the four listed examples.

---

## 3. Full pipeline (7 stages)

```
Unstructured Merchant Input
        │
        ▼
[1] STRUCTURING AGENT ──► Structured, agent-readable catalog (JSON)
        │
        ▼
[2] DISCOVERY ──► Buyer-agent queries catalog, finds candidate product(s)
        │
        ▼
[3] NEGOTIATION AGENT ──► Bounded haggling against merchant-set policy → agreed price
        │
        ▼
[4] CONSENT CHAIN ──► Intent Mandate + Cart Mandate (signed, hash-linked)
        │
        ▼
[5] PAYMENT ──► Razorpay test-mode Order created + captured (bounded, gated)
        │        Payment Mandate signed, appended to chain
        ▼
[6] FULFILLMENT LOOP ──► Merchant confirms handoff → Fulfillment Mandate signed, appended
        │
        ▼
[7] AUDIT BUNDLE ──► Full 4-mandate signed chain viewable as one evidence record
```

### Stage 1 — Structuring Agent
**Input:** merchant "raw input" — for the hackathon, simulate with: (a) 3–5 product photos with filenames as loose hints, (b) a short free-text or transcribed "voice note" string per product (e.g., `"yeh saree 1200 ka hai, cotton, blue, ek hi piece bacha hai"`), (c) optionally a Razorpay Payment Page description string.
**Process:** an LLM call (vision + text) extracts: product name, category, price (best-guess numeric + currency), material/attributes, stock quantity, and a **confidence score per field** (0–1).
**Output:** one JSON record per product conforming to the Catalog Item Schema (§4.1).
**Critical rule:** if `price.confidence < 0.6` or `stock.confidence < 0.6`, the item is flagged `needs_merchant_confirmation: true` and MUST NOT be transactable until confirmed. This is your gating logic for Stage 1 — implement it for real, don't fake it.

### Stage 2 — Discovery
**Input:** a buyer-agent's structured query (e.g., `{ "want": "blue cotton saree", "max_price": 1500 }`).
**Process:** simple filtered search over the structured catalog (no LLM needed here — deterministic filter/match is fine and arguably more defensible in the demo than an opaque LLM search).
**Output:** ranked list of matching catalog items with their `item_id`.

### Stage 3 — Negotiation Agent (NOVEL — build this for real, it's the differentiator)
**Input:** a chosen `item_id`, the merchant's **Negotiation Policy** for that item (§4.2), and a buyer-agent's opening offer.
**Process:** implement as a deterministic bounded negotiation, NOT free-form LLM haggling:
  - Merchant Negotiation Policy defines: `floor_price` (never go below), `list_price` (opening ask), `max_rounds` (e.g., 3).
  - Buyer-agent makes an offer. If offer ≥ floor_price → accept immediately at that price (favor the buyer, don't drag it out).
  - If offer < floor_price → counter with a price partway between floor and list (simple formula, e.g., midpoint of current gap), decreasing the gap each round.
  - After `max_rounds` with no agreement ≥ floor_price → **negotiation fails, gracefully** — return a clear "no deal" response, no transaction attempted. (This can double as your "one failure handled gracefully" if you want a second failure mode beyond Stage 1's low-confidence gate — pick whichever demos better.)
  - An LLM MAY be used only to phrase the counter-offer message in natural language (e.g., "Bhaiya, ₹1000 mein de dijiye" → "Sorry, best I can do is ₹1100") — but the actual number logic must be deterministic and auditable. Do not let the LLM decide the price. This is your "gated" requirement for this stage.
**Output:** either `{ status: "agreed", final_price: X }` or `{ status: "no_deal" }`, logged with every offer/counter-offer in the round.

### Stage 4 — Consent Chain
**Input:** the agreed `item_id` + `final_price` from Stage 3.
**Process:** construct and sign:
  - **Intent Mandate** — buyer-agent's authorized scope (max_price the buyer-agent was allowed to go up to, category constraint, TTL). Signed by the buyer-agent's key.
  - **Cart Mandate** — the exact final item + final_price + merchant identity. Signed first by merchant key, then by buyer-agent key (two-signature binding, matching AP2's model).
  - Each mandate is a JWS (ES256) compact token. Cart Mandate embeds a SHA-256 hash reference to the Intent Mandate.
**Output:** signed Intent Mandate + signed Cart Mandate, both persisted keyed by a new `transaction_id`.

### Stage 5 — Payment
**Input:** the signed Cart Mandate.
**Process:** verify Cart Mandate signatures are valid BEFORE calling Razorpay (this is your explicit gate — never call the payment API on an unverified mandate). Create a Razorpay **test-mode Order** (`amount` = final_price in paise, `currency: "INR"`, `receipt: transaction_id`). On successful capture, construct and sign a **Payment Mandate** (references Cart Mandate hash, Razorpay `order_id` + `payment_id`).
**Output:** signed Payment Mandate appended to the chain for this `transaction_id`.

### Stage 6 — Fulfillment Loop (NOVEL — build this for real)
**Input:** merchant confirmation event, for the hackathon simulate as a simple button/endpoint call `POST /transactions/:id/confirm-fulfillment` with an optional photo/note field.
**Process:** construct and sign a **Fulfillment Mandate** (references Payment Mandate hash, timestamp, merchant signature, optional evidence note/photo reference).
**Output:** signed Fulfillment Mandate appended to the chain. If no confirmation arrives within a demo-reasonable window, the transaction stays `status: "payment_confirmed_awaiting_fulfillment"` — do NOT auto-mark as fulfilled. This honesty is part of what makes the chain trustworthy as evidence.

### Stage 7 — Audit Bundle
**Input:** `transaction_id`.
**Process:** fetch all four mandates, verify every signature and every hash link, render as a single ordered, human-readable timeline.
**Output:** a page/endpoint `GET /transactions/:id/audit` returning the full verified chain — this is your demo's closing visual.

---

## 4. Data schemas (implement exactly — these are the contract between pipeline stages)

### 4.1 Catalog Item
```json
{
  "item_id": "itm_001",
  "merchant_id": "mer_001",
  "name": "Blue Cotton Saree",
  "category": "apparel.saree",
  "attributes": { "material": "cotton", "color": "blue" },
  "price": { "value": 1200, "currency": "INR", "confidence": 0.82 },
  "stock": { "quantity": 1, "confidence": 0.7 },
  "source": { "type": "voice_note", "raw_text": "yeh saree 1200 ka hai, cotton, blue, ek hi piece bacha hai" },
  "needs_merchant_confirmation": false,
  "extracted_at": "2026-08-30T10:00:00Z"
}
```

### 4.2 Negotiation Policy (merchant-set, once, per item or per category)
```json
{
  "item_id": "itm_001",
  "list_price": 1200,
  "floor_price": 950,
  "max_rounds": 3,
  "set_by": "merchant",
  "set_at": "2026-08-30T10:05:00Z"
}
```

### 4.3 Intent Mandate (JWS payload before signing)
```json
{
  "mandate_type": "intent",
  "issuer": "buyer_agent_key_id",
  "buyer_agent_id": "agent_xyz",
  "constraints": { "max_price": 1500, "category": "apparel.saree", "ttl_seconds": 600 },
  "prompt_playback": "Find a blue cotton saree under 1500",
  "issued_at": "2026-08-30T10:10:00Z"
}
```

### 4.4 Cart Mandate
```json
{
  "mandate_type": "cart",
  "intent_mandate_hash": "sha256:...",
  "item_id": "itm_001",
  "final_price": { "value": 1100, "currency": "INR" },
  "merchant_id": "mer_001",
  "merchant_signature": "...",
  "buyer_agent_signature": "...",
  "issued_at": "2026-08-30T10:11:30Z"
}
```

### 4.5 Payment Mandate
```json
{
  "mandate_type": "payment",
  "cart_mandate_hash": "sha256:...",
  "razorpay_order_id": "order_test_...",
  "razorpay_payment_id": "pay_test_...",
  "amount": 1100,
  "currency": "INR",
  "status": "captured",
  "issued_at": "2026-08-30T10:12:00Z"
}
```

### 4.6 Fulfillment Mandate (novel addition — not part of AP2)
```json
{
  "mandate_type": "fulfillment",
  "payment_mandate_hash": "sha256:...",
  "confirmed_by": "merchant",
  "merchant_signature": "...",
  "evidence_note": "Handed over in person, 30 Aug",
  "evidence_photo_ref": null,
  "confirmed_at": "2026-08-30T10:40:00Z"
}
```

---

## 5. Tech stack (recommended — deviate only if you have a strong reason, and say so)

- **Language/runtime:** TypeScript on Node.js (single language across the stack keeps this buildable in a weekend).
- **Signing:** `jose` npm package — `generateKeyPair('ES256')`, `CompactSign`, `compactVerify`. Do NOT attempt full W3C Verifiable Credentials/JSON-LD — that's unnecessary complexity for a hackathon; plain JWS/ES256 is defensible and matches how AP2 reference samples actually sign payloads.
- **Backend:** Express or Fastify, simple REST endpoints per stage.
- **Storage:** SQLite (via `better-sqlite3` or Prisma) — no need for anything heavier.
- **LLM calls (Stage 1 extraction, Stage 3 phrasing only):** Anthropic API (Claude) via the standard `@anthropic-ai/sdk` — vision-capable model for photo extraction, text model for voice-note parsing.
- **Payments:** Razorpay Node SDK (`razorpay` npm package), **test mode only** — use test API keys, test cards / mock bank page.
- **Frontend/demo UI:** a minimal React (or even plain HTML) page showing: catalog view → negotiation chat log → payment confirmation → audit chain timeline. Keep it visually simple; the substance is in the signed chain, not the UI polish.

---

## 6. Repo structure (proposed)

```
/src
  /structuring       — Stage 1: extraction agent
  /catalog           — Stage 2: discovery/search
  /negotiation        — Stage 3: bounded negotiation logic
  /mandates
    schema.ts         — TS types for all 4 mandate types + catalog item + negotiation policy
    sign.ts            — JWS signing/verification helpers (jose wrappers)
    chain.ts            — hash-linking + chain verification logic
  /payments
    razorpay.ts         — Razorpay test-mode Order creation/capture
  /fulfillment          — Stage 6 confirmation endpoint + mandate construction
  /audit                 — Stage 7 chain retrieval + verified timeline rendering
  /db                     — SQLite schema + queries
  server.ts                — Express/Fastify app wiring all routes
/data
  sample_products/          — sample photos + voice-note text files for demo
/frontend                    — minimal UI
.env.example                  — RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, ANTHROPIC_API_KEY, signing key seeds
README.md
```

---

## 7. Build sequencing — implement and verify in this order

**Milestone A — Mandate chain works in isolation (no LLM, no Razorpay yet)**
Build `/mandates` fully: define all 4 schemas, implement sign/verify with `jose`, implement hash-linking, write a small script that manually constructs and verifies a full 4-mandate chain with dummy data.
*Definition of done:* running the script prints all 4 mandates verified ✅ and shows the hash chain is intact; tampering with any field breaks verification (test this explicitly — flip one character in a signed payload and confirm verify() fails).

**Milestone B — Structuring agent works on sample data**
Feed 3–5 sample products (photo + voice-note text) through Stage 1. Confirm confidence scoring works and low-confidence items get flagged.
*Definition of done:* a catalog.json is produced; at least one deliberately ambiguous sample product correctly gets `needs_merchant_confirmation: true`.

**Milestone C — Negotiation agent works end to end**
Implement Stage 3 against Milestone B's catalog. Test three cases: buyer offers above floor (instant accept), buyer offers below floor and eventually meets it within max_rounds (agreement), buyer never reaches floor (graceful no_deal).
*Definition of done:* all three cases produce correct, logged outcomes with no crashes.

**Milestone D — Wire Stages 4–5 (mandates + Razorpay)**
Connect negotiation output → Intent/Cart Mandate construction → Razorpay test Order creation/capture → Payment Mandate.
*Definition of done:* a full transaction from catalog query to captured test payment produces a 3-mandate chain, verifiable via Milestone A's verify logic.

**Milestone E — Fulfillment loop + audit view**
Add Stage 6 confirmation endpoint and Stage 7 audit view.
*Definition of done:* hitting the confirm-fulfillment endpoint appends a valid 4th mandate; the audit endpoint renders the full verified 4-stage timeline for a completed transaction.

**Milestone F — Demo polish**
Minimal frontend wiring all of the above into a walkthrough: pick a product → negotiate → pay → confirm fulfillment → view audit chain. Prepare 2–3 pre-seeded demo scenarios (one clean success, one negotiation-fails case, one low-confidence-extraction case) so the video doesn't depend on live LLM calls behaving perfectly.

---

## 8. Explicit constraints and things to fake vs. build real

- **Build for real:** all mandate signing/verification, the negotiation bounding logic, the Razorpay test-mode Order flow, the confidence-gating logic, the audit chain.
- **OK to fake/simulate for the demo:** the "merchant" and "buyer-agent" as literal separate services — a single backend playing both roles with clearly labeled keys is fine. The voice-note transcription — you can start from pre-transcribed text strings rather than building real speech-to-text, and say so plainly in the README.
- **Do not fake:** the actual cryptographic signing/verification. That's the credibility core of the project — it must be real, working code, not a mocked "signature: true" field.

---

## 9. Open questions to raise with the person before deep implementation

- Preferred LLM provider/model for Stage 1 extraction (Claude vision vs. other) — default to Claude via Anthropic API unless told otherwise.
- Whether to build a real minimal frontend or keep the demo CLI/Postman-driven with a slide-based walkthrough — affects time budget significantly.
- Whether negotiation should support multi-item carts or stay single-item for the hackathon scope (recommend single-item to protect time).
