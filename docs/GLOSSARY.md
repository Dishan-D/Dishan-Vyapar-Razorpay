# Every technical term in this project

Grouped by what it belongs to. Each entry says what it means, where it lives,
and — for the ones you will actually be asked about — **how to say it out loud**.

Terms were pulled from the codebase, so this is the vocabulary that is really
there rather than a generic list.

---

# 1 · The core idea

| Term | What it means |
|---|---|
| **Agentic commerce** | Buying and selling where one side is software acting for a person, not a person clicking. |
| **Buyer-agent** | The software doing the buying. Here it searches every shop, compares, haggles and pays — under limits its shopper signed. |
| **Commerce layer** | What this project is. The layer between a payment rail and an AI buyer: products, prices, stock, policies, negotiation, fulfilment. |
| **Payment rail** | The thing that moves money — UPI, Razorpay. It carries no information about *what* was sold. |
| **Machine-readable presence** | How much of a shop a machine can actually read. For these merchants: **one field**, their UPI ID. |

> **Say it as:** *"A QR code can move money. It cannot describe a shop. We built
> the part in between."*

---

# 2 · Mandates and the audit chain

The heart of the project. Four signed documents per sale.

| Term | What it means | Where |
|---|---|---|
| **Mandate** | A signed statement of one fact in a transaction. Not a log line — evidence. | `src/mandates/schema.ts` |
| **IntentMandate** | What the *shopper* authorised: ceiling, category, attributes, TTL. Signed by the buyer-agent. | |
| **CartMandate** | The agreed item and price. Signed by the **merchant** *and* countersigned by the buyer-agent. | |
| **PaymentMandate** | The Razorpay order id, payment id and captured amount. Signed by the platform. | |
| **FulfillmentMandate** | That the goods were handed over. **Only the merchant can sign this.** | |
| **MandateChain** | All four for one transaction, each carrying a SHA-256 hash of the one before. | `src/mandates/chain.ts` |
| **Hash-linked** | Each mandate embeds its predecessor's hash, so altering an earlier one breaks every link after it. | |
| **Append-only** | A mandate type is written once per transaction and never updated. An evidence chain you can overwrite in place is not evidence. | `src/db/store.ts` |
| **Sha256Ref** | The type for those hashes — `sha256:…`. | |
| **`verifyChain`** | Re-checks every signature and every hash link **at read time**, never from a stored "verified" flag. | |

## Cryptography

| Term | What it means |
|---|---|
| **ES256** | ECDSA signatures on the **P-256** curve with SHA-256. The algorithm every mandate is signed with. |
| **P-256** | The elliptic curve (a.k.a. secp256r1 / prime256v1). |
| **JWS** | JSON Web Signature — the format the signature is stored in. |
| **Compact JWS** (`CompactJws`) | The `header.payload.signature` string form. |
| **JWK** | JSON Web Key — how the public keys are published so anyone can verify. |
| **Keyring** | The three separate keypairs: buyer-agent, merchant, platform. Separate because a chain signed by one key proves nothing about who agreed to what. |
| **RFC 8785 / JCS** | JSON Canonicalization Scheme. Deterministic serialisation — fixed key order, no incidental whitespace. |
| **Canonical bytes** | What is actually hashed and signed. Never `JSON.stringify` with default key order. |

> **Why canonical JSON matters, in one sentence:** *"If two identical payloads
> can serialise to different bytes, the hash link breaks for reasons that have
> nothing to do with tampering."*

---

# 3 · The authorization gate

**The single most important concept in the project.**

| Term | What it means | Where |
|---|---|---|
| **`checkAuthority`** | The one function that can stop money moving. | `src/mandates/authority.ts` |
| **AuthorityCheck** | One test — price, category, attribute, delivery — with its result *and its reason*, pass or fail. | |
| **AuthorityResult** | All the checks, returned whether they passed or not, because a trust panel that only lists problems tells you nothing when there are none. | |
| **`PaymentRefused`** | The exception thrown when a check fails. No gateway call is made. | `src/payments/pay.ts` |
| **Ceiling** | The most the shopper authorised. A **limit, not a target**. |
| **Floor** (`floor_price`) | The least the merchant will accept. |
| **Normalisation** (`normaliseKey`, `valuesAgree`) | Making the shopkeeper's word and the shopper's word reach the same fact — `flavour`/`flavor`, `colour`/`color`. |

> **Say it as:** *"The agent may choose freely; it may not spend freely. One gate
> moves money, and it compares two documents the agent did not author — what the
> shopper signed and what the merchant signed. The safety property doesn't depend
> on the model behaving."*

---

# 4 · Negotiation

| Term | What it means |
|---|---|
| **Bounded negotiation** | A haggle with hard limits enforced in code, not by a model. |
| **`NegotiationPolicy`** | The merchant's own terms: whether they negotiate, their floor, max discount %, whether promotions are allowed. |
| **`opening_offer`** | The buyer-agent's first number. |
| **`max_rounds`** | The hard cap on rounds. |
| **`no_deal`** | No price existed inside both bounds. **No Razorpay order is created at all.** |
| **Endgame** | If the buyer's ceiling is at or above the merchant's floor, the merchant takes the floor rather than losing a sale both sides wanted. |
| **Invariant** | A property that must always hold — never above the ceiling, never below the floor, never above list price, never past `max_rounds`. |
| **Fuzzing** | Testing those invariants over **500 randomised policies** every audit run. |
| **Deterministic** | Same inputs, same output, no model involved. Used of the engine, the gate, the analytics and the merchant router. |

> **Say it as:** *"A model may phrase these lines. It never picks one of these
> numbers."*

---

# 5 · Structuring — turning a photo into a catalog

| Term | What it means |
|---|---|
| **Structuring** | The pipeline that turns photos, voice notes and sentences into `CatalogItem`s. |
| **`CatalogItem`** | One product an agent can read: name, category, attributes, price, stock — each with a confidence. |
| **Per-field confidence** | Every extracted field carries a 0–1 score for how well the input supports it. |
| **Confidence gating** | Anything below the threshold (0.6) is **withheld from every offer** rather than guessed. |
| **`needs_merchant_confirmation`** | The flag that marks a product as held. |
| **Held** | A product that exists but cannot be sold until a human confirms it. |
| **Clarification loop** | The held product generates a **specific question** to the merchant over WhatsApp, with options. Their reply resolves it. |
| **Price sanity check** | An extracted price compared against the merchant's own history; a 10× outlier is flagged. With fewer than 3 peers it **skips rather than fabricate a baseline**. |
| **Provenance** | Where each value came from — model, rules, or the merchant typing it. Shown on every catalog row. |
| **OCR** | Optical character recognition (`tesseract.js`) on printed price tags. |
| **Confidence gate (OCR)** | Low-confidence OCR text is discarded rather than passed on as fact. |
| **Tombstone** | A record that a product was deleted, so the seed file cannot resurrect it. |

> **Say it as:** *"Every extraction pipeline produces uncertain output. Most ship
> the uncertainty downstream as though it were fact. This one treats 'I am not
> sure' as a state with its own workflow."*

---

# 6 · Discovery and comparison

| Term | What it means |
|---|---|
| **Discovery** | Matching a buyer's request against every shop's catalog. |
| **Word-level matching** | Whole-word, not substring. Substring matching returned Wired Earphones for a phone *charger* — "phone" is inside "earphones". |
| **`head_match`** | Whether the item matched the *noun* the shopper actually named. |
| **`withheld`** | Items that matched but cannot be offered, **and why**. Held items are withheld entirely, never ranked low. |
| **`above_ceiling`** | Listed above the buyer's ceiling — still offered, because that is what haggling is for. |
| **Readiness score** | How agent-ready a merchant is: catalog confidence, coverage, fulfilment record. |
| **`effective_price`** | The agreed price adjusted for the merchant's readiness — a risk-adjusted comparison. |

---

# 7 · Razorpay and payments

| Term | What it means |
|---|---|
| **Orders API** | `orders.create` / `orders.fetch`. A real order the moment the rules agree a price. |
| **Checkout** | Razorpay's hosted payment flow (`checkout.razorpay.com/v1/checkout.js`). |
| **`razorpay_signature`** | The signature Checkout returns, verified server-side with `validatePaymentVerification`. |
| **Webhook** | `POST /webhooks/razorpay`. Razorpay's server-to-server notification. |
| **`validateWebhookSignature`** | HMAC-SHA256 verification of a webhook, over the **raw request bytes** — parsing the body first is how signature checks quietly stop working. |
| **Raw body** | `express.raw` — the unparsed bytes, kept because the signature covers them. |
| **Idempotency** | The same operation applied twice has the effect of once. Razorpay retries webhooks; a second delivery returns `already_settled`. |
| **Payment Links** | `POST /v1/payment_links` — a shareable link for an order agreed but never paid. |
| **Invoices** | `POST /v1/invoices` — issued only after the merchant confirms handover. |
| **Settlements** | `GET /v1/settlements` — what Razorpay has actually paid out to the bank. |
| **Smart Collect / Virtual Accounts** | Bank-transfer reconciliation. **Not enabled on this account** — and shown as such. |
| **Capability probe** | Five read-only calls that ask the account what it can do, rather than claiming it. |
| **Test mode** | `rzp_test_…` keys. Real API, no real money. |
| **`amount_paise`** | Razorpay works in paise. ₹422 is `42200`. |
| **Simulated rail** | A local payment path for CLI runs, ids prefixed `sim_`, labelled `Gateway · Simulated` on every screen. |
| **UPI** | Unified Payments Interface — India's instant payment system. |
| **VPA** | Virtual Payment Address — a UPI handle like `sribalajibakery@okicici`. |
| **`upi://` URI** | What a UPI QR encodes: `upi://pay?pa=…&pn=…&cu=INR`. `pa` is the payee address, `pn` the payee name. |

---

# 8 · The AI layer

| Term | What it means |
|---|---|
| **Tool calling** / **function calling** | The model choosing which of a set of declared functions to invoke, with structured arguments. |
| **Tool registry** | The declared set. Each entry carries a domain, whether it **writes**, and whether it needs **confirming**. |
| **`json_schema` + `strict`** | Forcing the model's output to a schema so it can be parsed rather than hoped over. |
| **Structured output** | The result of that — a typed object, validated with **Zod** before it is believed. |
| **Grounding** | Every figure in an answer traceable to a tool result. |
| **Ungrounded figure** | A number no lookup returned. The guard replaces the whole answer. |
| **Hallucination** | The model asserting something not in its inputs. Five guards exist for five observed shapes of it. |
| **Guard** | A pure function that inspects an answer before it ships — `ungroundedFigures`, `claimsPurchaseDone`, `pointsAtButton`, `misattributedPrice`, `fromRowsOnly`. |
| **Deterministic routing** | Matching a question to a lookup with regexes, no model call. 25 spoken phrasings are regression-tested. |
| **Supervisor / specialist domains** | The routing layer, and the labels — payments, sales, customers, catalog, growth, operations. *Labels, not separate model calls.* |
| **Session state** | What the shop knows about one shopper mid-conversation: shown, selected, comparing, budget, cart. **Server-side.** |
| **Referent resolution** | Making "it", "that one", "the second one", "those" point at something real. |
| **Vision model** | Reads photographs of stock. |
| **Whisper** | Speech-to-text for the merchant's voice notes (`whisper-large-v3-turbo`). |
| **Web Speech API** | The *browser's* own speech recognition, used for the merchant mic — no service to configure. |
| **TPM / TPD** | Tokens per minute / per day. Groq's free tier: 8,000 and 200,000, **per organisation**. |
| **Rate governor** (`RateGovernor`) | Paces calls against that budget, reading the rate-limit headers rather than guessing. |
| **`maxWaitSeconds`** | A deadline for the **whole call**, not per attempt. |
| **`RateBudgetExceeded`** | Thrown when waiting would exceed it — the caller falls back to a deterministic answer. |
| **Graceful degradation** | The deterministic paths never depend on a model being reachable. |

---

# 9 · Analytics and attribution

| Term | What it means |
|---|---|
| **Ledger** | The single aggregator. Chains in, statistics out. `src/analytics/ledger.ts` |
| **Derived, not counted** | Every figure recomputed from the signed chains on each read. **There is no revenue counter anywhere.** |
| **`Txn` / `TxnLine`** | The canonical transaction shape the analytics read. |
| **Attribution** | *Why* a sale happened — `organic`, `cross_sell`, `upsell`, `revenue_agent`. Recorded **at purchase time**, never inferred later. |
| **AOV** | Average order value — revenue ÷ orders. Per *order*, not per item. |
| **ASP** | Average selling price — revenue ÷ units. Per unit, so a discount pulls it down. |
| **Sales velocity** | Units a day, reported **with the window it was measured over** — a rate measured over one afternoon is not a rate. |
| **Repeat rate** | Buyers with more than one paid order ÷ buyers in the window. |
| **Customer contribution** | One buyer's revenue ÷ total revenue. |
| **Lapsed** | A buyer who bought **more than once** and has been quiet 30+ days. One purchase two months ago is a passer-by, not a lapsed regular. |
| **Contributors** | What actually moved between two periods, ranked by how much. The function behind *"why are sales down"*. |
| **Integrity check** | Re-verifies the arithmetic: line totals sum to their transaction, no payment id on two sales, no sale credited to a shop that does not stock the product. |
| **Elasticity** | Replaying **real recorded buyers** through the **production negotiation engine** at different floors. Not a forecast. |
| **Dead stock** | Inventory that is not moving, weighed against real buyer demand. |
| **Cross-sell / upsell** | Something alongside / something bigger. An upsell must name a concrete benefit and picks the **cheapest** qualifying option. |

---

# 10 · Reconciliation

| Term | What it means |
|---|---|
| **Reconciliation** | Matching money that arrived in the bank to what was sold. |
| **`explained_share`** | The fraction of banked rupees tied to a specific sale. **0% before, 99% after.** |
| **`matched`** | A credit tied to a sale by payment reference. |
| **`matched_on_amount`** | Tied by amount and time window — probable, not certain, and labelled that way. |
| **`unexplained_credit`** | Money arrived and nothing in the shop's record accounts for it. |
| **`amount_mismatch`** | A credit whose amount disagrees with the sale it should match. |
| **`missing_credit`** | A sale with no corresponding credit. |
| **Settlement feed** | The bank-side view. **Generated here**, and every screen says so. |

---

# 11 · Infrastructure

| Term | What it means |
|---|---|
| **Express 5** | The HTTP server. 78 endpoints. |
| **Socket.io** | Real-time events, fired from **actual state transitions** — where the server already writes to the database. |
| **Event bus** | The publish layer: `extraction.completed`, `clarification.sent`, `negotiation.agreed`, `payment.captured`, `stock.changed`, `fulfillment.confirmed`, `agent.step`. |
| **SQLite / better-sqlite3** | The store. Synchronous, embedded, no ORM. |
| **WAL** | Write-Ahead Logging — the SQLite journal mode used. |
| **`multer`** | Multipart upload handling for photos and audio. |
| **`jsQR`** | QR decoding, run **in the browser** so a merchant's QR image never leaves their device. |
| **`tsx`** | Runs TypeScript directly. **No build step.** |
| **Twilio** | WhatsApp for clarification questions and sale confirmations. |
| **Zod** | Runtime schema validation of every model output. |
| **oklch** | The perceptual colour space the design system is defined in, so ramps stay even in lightness. |
| **Deterministic seed** | `mulberry32` — the demo history is identical on every reset. |

---

# 12 · Say this, not that

The merchant-facing rule: **if a shopkeeper would not use the word, translate it.**

| Never say to a merchant | Say |
|---|---|
| "confidence score below threshold" | "I wasn't sure, so I'm asking you" |
| "mandate chain verified" | "this sale has a signed record anyone can check" |
| "readiness metric" | "how ready your shop is for AI buyers" |
| "GMV increased 13.7% WoW" | "you made ₹42,600 this week — up 14%" |
| "attribution: cross_sell" | "this sold because you suggested it" |
| "the extraction was gated" | "this product is waiting on you to confirm a price" |
| "idempotent action" | *nothing — it just works when they press twice* |
| "rate limit exceeded" | "the assistant is busy for a minute; everything else still works" |
| "no_deal" | "nobody would sell it inside your budget" |

---

# The five terms to actually know cold

If you remember nothing else from this page:

1. **Mandate chain** — four signed documents per sale, hash-linked, re-verified on read.
2. **The authorization gate** — the one place money can be stopped; compares two documents the agent did not author.
3. **Bounded negotiation** — floor, ceiling and round count in code; the model phrases, never decides.
4. **Confidence gating** — uncertain extractions are held and asked about, not guessed.
5. **Derived, not counted** — no revenue counter; every figure recomputed from the chains.
