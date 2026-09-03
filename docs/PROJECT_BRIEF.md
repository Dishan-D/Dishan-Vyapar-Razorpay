# Vyapar-to-Agent — complete project briefing

*Razorpay AI Buildathon · Track 01, AI Growth & Agentic Commerce*

**What this document is.** A full, self-contained context dump for whoever (or
whatever) is writing the presentation script. It covers the problem, the
architecture, every implemented feature, the exact success and failure cases to
demonstrate, and the novelty claims with the evidence behind each one.

**Every number in this document was read from the running system.** Where a
figure appears, it came back from an endpoint or a script, not from memory.

---

# PART 1 — THE PROBLEM

## 1.1 The one-sentence problem

An AI buyer-agent cannot buy anything from an Indian kirana shop, because the
shop's entire machine-readable presence is **one UPI VPA string**.

## 1.2 Why that matters now

Agentic commerce is arriving: buyer-agents that search, compare, negotiate and
pay on a person's behalf. Every protocol being drafted for it assumes the seller
already has structured data — a product feed, an API, a catalog with prices and
stock. That assumption holds for Amazon and for Shopify stores. It does not hold
for the ~13 million small Indian merchants who accept UPI and nothing else.

For those shops the situation is not "poor data". It is **no data**. A QR sticker
carries a payee handle. It cannot say what is for sale, what it costs, whether
any is left, or whether the shopkeeper would take less.

## 1.3 What that means concretely

Take a real shop in this demo. Before: Sri Balaji Bakery has
`sribalajibakery@okicici` — **1 machine-readable field**. An agent asked for a
chocolate cake under ₹500 finds nothing, because there is nothing to find.

The failure is not that the agent searched badly. There was no object to search.

## 1.4 The gap nobody is filling

Two things exist already and neither closes this:

- **Payment rails** (Razorpay, UPI) move money once a decision is made. They
  carry no information about *what was sold*.
- **Marketplaces** (Amazon, Swiggy, ONDC sellers-on-platforms) solve it by making
  the merchant join a platform, adopt its catalog format, and accept its terms.

The missing layer is a **commerce layer that sits on top of the payment rail the
merchant already has**, built from what the merchant can actually provide — a
photo, a voice note, a sentence — and which produces something an agent can
transact against without the merchant changing anything.

That layer is this project.

---

# PART 2 — WHAT WAS BUILT, IN ONE PARAGRAPH

A merchant sends photos, a voice note or a sentence. A vision/LLM pipeline turns
that into structured products, and **anything it is not confident about is held
back and asked about rather than guessed**. Those products become discoverable to
AI buyer-agents. A buyer-agent searches across shops, compares, and negotiates
inside bounds the merchant set — deterministically, with the language model
allowed to phrase but never to pick a number. If a price is agreed, four
cryptographically signed, hash-linked mandates are produced (intent → cart →
payment → fulfillment), a real Razorpay order is created, and payment is gated by
a check that compares what the shopper authorised against what the merchant
signed. The merchant confirms handover, which is the only thing that marks an
order delivered. Every statistic the merchant sees is recomputed from those
signed chains, and a separate Revenue Agent proposes cross-sells, upsells and
dead-stock promotions that obey the merchant's own discount policy.

---

# PART 3 — ARCHITECTURE, TOP DOWN

## 3.1 The five stages

```
   MERCHANT INPUT              →  photos · voice · text · one-by-one
        │
   [1] STRUCTURING             →  vision + OCR + LLM → CatalogItem[]
        │                         confidence-gated; low confidence → clarification
        ▼
   [2] DISCOVERY               →  word-level matching, category, attributes, stock
        │                         held items withheld entirely, never ranked low
        ▼
   [3] NEGOTIATION             →  deterministic engine, floor/ceiling/max_rounds
        │                         LLM phrases the sentence; never chooses the number
        ▼
   [4] MANDATES + AUTHORITY    →  ES256-signed intent→cart→payment→fulfillment
        │                         one gate compares shopper's signature to merchant's
        ▼
   [5] PAYMENT + FULFILMENT    →  Razorpay Orders/Checkout, webhook-verified
                                  merchant signs handover; nothing self-delivers
        │
        ▼
   ANALYTICS  ←  every figure recomputed from the signed chains, never counted
```

## 3.2 Codebase map

**~18,000 lines of TypeScript**, no framework beyond Express + Socket.io.

| Module | Lines | What it owns |
|---|---|---|
| `src/server.ts` | 5,914 | 78 HTTP endpoints, the run loop, the wiring |
| `src/agent/buyerloop.ts` | 503 | The shopper's agent: tools, guards, fallbacks |
| `src/structuring/storefront.ts` | 438 | Photos/voice/text → products |
| `src/revenue/agent.ts` | 345 | Cross-sell, upsell, dead-stock with visible scoring |
| `src/revenue/recovery.ts` | 324 | Lost-sale recovery cases |
| `src/payments/razorpay-extras.ts` | 308 | Capability probes, payment links, invoices |
| `src/db/store.ts` | 308 | Append-only SQLite mandate store |
| `src/analytics/ledger.ts` | 513 | **The single analytics aggregator** |
| `src/payments/gateway.ts` | 335 | Razorpay + simulated rails behind one interface |
| `src/agent/shopping.ts` | 258 | Server-side shopper session state |
| `src/catalog/discovery.ts` | 254 | Matching, withholding, ranking |
| `src/negotiation/engine.ts` | 223 | The bounded haggle |
| `src/mandates/chain.ts` | 221 | Hash-linking and chain verification |
| `src/finance/upi.ts` | 220 | UPI credit → sale reconciliation |
| `src/llm/ratelimit.ts` | 210 | Token-per-minute governor with deadlines |
| `src/agent/merchant-tools.ts` | 383 | The merchant tool registry: domain, writes, confirm |
| `src/agent/supervisor.ts` | 266 | Deterministic question → lookup routing |
| `src/demo/history.ts` | 299 | Six months of signed history, generated |
| `src/mandates/authority.ts` | 184 | **The one gate that moves money** |

Two browser pages, no build step: `frontend/store.html` (shopper) and
`frontend/merchant.html` (shopkeeper), sharing `app.css` and `ui.js`.

## 3.3 Live system size

```
7 shops · 30 products (28 transactable, 2 deliberately held)
188 transactions in the ledger · 155 delivered, 10 paid, 23 awaiting payment
28 through real Razorpay test mode, 160 through the labelled simulated rail
78 HTTP endpoints
60 audit claims, all passing
```

---

# PART 4 — EVERY IMPLEMENTED FUNCTIONALITY

## 4.1 Merchant onboarding & structuring

- **Four input modes**: photos, voice (recorded + transcribed + shown for
  correction), free text, and one-by-one manual entry with a photo per row.
- **OCR before the LLM** — `tesseract.js` reads printed price tags, with a
  **confidence gate**: text below a threshold is discarded rather than passed on
  as fact. (Low-confidence OCR was returning garbage at confidence 22–36.)
- **Per-field confidence**. Every extracted field carries a confidence score.
- **Confidence gating**: any product whose price or stock confidence is below
  0.6 is marked `needs_merchant_confirmation` and **withheld from every offer**.
- **The clarification loop**: held items generate a specific question sent to the
  merchant over WhatsApp (Twilio) — *"Fresh Fruit Pastry — what price?"* — with
  suggested options. The merchant's reply resolves it and the product goes live.
- **Price sanity check**: an extracted price is compared against the merchant's
  own history; a 10× outlier is flagged. With fewer than 3 peer products it
  **skips rather than fabricate a baseline**.
- **Provenance on every row**: the merchant's catalog screen shows whether each
  field came from a model, from rules, or from the merchant typing it.
- **Full CRUD**: add, edit, delete products; upload a photo; edits persist
  (they outrank the seed, and deletions leave tombstones so seeds do not
  resurrect).

## 4.2 The shopper's AI agent

- **12 tools**: `search_shelf`, `get_product`, `compare_products`,
  `find_alternatives`, `find_complements`, `view_cart`, `add_to_cart`,
  `remove_from_cart`, `get_orders`, `get_order`, `check_shop`, `start_purchase`.
- **Server-side session state**: what was shown (and in what order), what is
  selected, what is being compared, the stated budget, the cart. This is what
  makes *"which is better"*, *"does it come smaller"*, *"add that one"* work.
- **Reference by number, not by id.** The model kept inventing plausible ids
  (`sri-balaji-choc-500`), so `search_shelf` returns a numbered list and tools
  take the number. The model may choose among real things; it may not mint them.
- **Ranking never reads `cost_price`.** A shopper's agent that quietly sorts by
  what the shop earns is not the shopper's agent.
- **Five hallucination guards** (detail in §6.2).
- **Click-to-pick**: while the agent has the shelf narrowed, clicking a product
  card prepares the purchase — with no model call at all.

## 4.3 Discovery and comparison

- **Word-level matching**, not substring. (Substring matching returned Wired
  Earphones for a search for a phone *charger* — "phone" is inside "earphones".)
- **Category and attribute filters** from the parsed intent.
- **Attribute vocabulary normalisation** — the shopkeeper's word and the
  shopper's word reach the same fact (`flavour`/`flavor`, `colour`/`color`,
  `scent`/`fragrance`, `serves`/`servings`).
- **Held items are withheld**, not ranked low — they cannot appear at all.
- **Multi-shop comparison** with a readiness score per merchant, and a
  risk-adjusted effective price.
- **The honest structured-vs-unstructured comparison** (§7.1).

## 4.4 Negotiation

- **Deterministic engine.** Floor, ceiling and `max_rounds` are hard limits
  enforced in code. The LLM may phrase a line; it never selects a number.
- **Per-merchant policy**: whether the shop negotiates at all, its floor, its
  maximum discount percentage, whether it allows promotions.
- **Endgame fix**: if the buyer's ceiling is at or above the merchant's floor,
  the merchant takes the floor rather than letting rounds run out on a deal both
  sides wanted.
- **Fuzzed invariants**: 500 randomised policies per audit run confirm the agent
  never pays above its ceiling, never below the floor, never above list price,
  and never exceeds `max_rounds`.

## 4.5 The mandate chain

Four mandates, each **ES256-signed (`jose`)** over **RFC-8785 canonical JSON**,
each carrying a SHA-256 hash of its predecessor:

| Mandate | Signed by | Says |
|---|---|---|
| **Intent** | buyer agent | what the shopper authorised: ceiling, category, attributes, TTL |
| **Cart** | merchant **and** buyer agent | the agreed item and price |
| **Payment** | platform | the Razorpay order and payment ids, and the captured amount |
| **Fulfillment** | merchant | that the goods were handed over |

- **Append-only.** A mandate type is written once per transaction and never
  updated — an evidence chain that can be overwritten in place is not evidence.
- **Re-verified at read time**, never read from a stored "verified" flag.
- **A CartMandate holds exactly one item.** One order is one product; a basket
  bought in conversation becomes several separately-signed chains. This is a
  deliberate schema property, and it makes every line item independently
  auditable.

## 4.6 The authorization gate — the most important 184 lines

`checkAuthority()` is **the only thing in the system that can stop money moving.**
It compares two documents the agent did not author: the intent the shopper
signed, and the cart the merchant signed. The agent's own opinion is not an
input.

It returns **every check, passed or failed** — because a trust panel that only
lists problems tells you nothing when there are none.

## 4.7 Payments (real Razorpay test mode)

- **Orders API** — genuine orders, e.g. `order_TWrGatHK1MTst4`.
- **Checkout** with `validatePaymentVerification` server-side.
- **Webhooks** verified with `validateWebhookSignature` **over the raw bytes**,
  not the parsed body.
- **`orders.fetch` / `fetchPayments`** — `GET /transactions/:id/gateway-status`
  asks Razorpay about our own order and prints both answers, *including when they
  disagree*.
- **Payment Links** and **Invoices** — real, verified against the account.
- **Capability probing** (§7.5) — five read-only calls that ask the account what
  it can actually do.
- **A simulated rail** for CLI demos, labelled `Gateway · Simulated` everywhere
  it appears, with per-process-unique ids.
- **A failed real call is never downgraded into simulated success.**

## 4.8 Fulfilment

- The merchant presses **Confirm handover**; that signs the fourth mandate.
- The shopper's order page updates live over Socket.io — no reload.
- **Nothing self-delivers.** Payment never implies fulfilment.
- WhatsApp confirmation to the merchant on capture, deduplicated across the
  webhook and the browser callback (both routinely land).

## 4.9 Stock

- A captured payment **takes the unit off the shelf**, once, at the single
  deduplicated capture point.
- Never below zero. A genuine race for the last unit is a real oversell for a
  human, logged as such, not recorded as "−1 on the shelf".
- Persisted through the same path a merchant's own edit takes, so it survives a
  restart.
- At zero the shop **stops offering it** and says so.

## 4.10 Analytics — the ledger

**There is no revenue counter anywhere in this system, and no sales figure stored
beside a product.** Every statistic is recomputed from the signed chains on each
read.

- `GET /merchants/:id/analytics` — revenue, orders, units, AOV, by day, by
  category, by attribution, top products.
- `GET /merchants/:id/products/analytics` — per product: units, revenue, orders
  containing it, average selling price, list price, stock, stock value, sales
  velocity **with the window it was measured over**.
- `GET /products/:itemId/analytics` — one product and the transactions behind it.
- `GET /analytics/transactions` — the unaggregated rows, so any figure on any
  screen can be checked without opening the database.
- `GET /analytics/integrity` — re-checks that line totals sum to their
  transaction, that no payment id appears on two sales, that no sale is credited
  to a shop that does not stock the product, that nothing counted as paid lacks a
  payment time.

**Attribution is recorded when the purchase happens, never inferred afterwards.**
A cross-sold packet of candles and one the shopper asked for by name produce
identical orders; working it out later from names or prices would be a guess
dressed as a statistic. An unrecognised value records as `organic` —
under-crediting the Revenue Agent beats claiming sales it had nothing to do with.

## 4.11 The Merchant Revenue Agent

Three opportunity kinds, each with **visible score factors**:

- **Cross-sell** — from the merchant's own declared complements and shared tags.
- **Upsell** — must name a concrete benefit (`"Serves 8-10 where Chocolate Cake
  500g serves 4-6"`), and picks the **cheapest qualifying option**, not the
  dearest that fits.
- **Dead stock** — slow-moving inventory against real buyer demand.

Every factor is a checkable sentence: *"Merchant allows promotions — enabled, up
to 8%"*, *"Offer stays above your floor — ₹87 against your floor of ₹85"*.
**Nothing changes until the merchant approves it.**

## 4.12 UPI reconciliation

The pipeline that turns *"₹450 arrived from someone@okhdfcbank"* into *"that was
the Chocolate Cake 500g, order txn_xyz, handed over at 14:32"*.

- Matches on payment reference first, then on amount-and-time-window.
- Labels each row: `matched`, `probable`, `unexplained`, `wrong amount`,
  `no credit`.
- **0% explained before → 99% after** on the live data.
- Exceptions are filterable, because 5 rows that need attention among 150 are
  otherwise unreachable.

## 4.13 Price elasticity

Replays **real recorded buyers** through the **production negotiation engine** at
different floors. It cannot promise a sale the engine would refuse. Closes are
truncated to actual stock.

## 4.14 Lost-sale recovery

Buyers who walked become cases with a recommended action, anchored to the
*latest* walkaway. Reads `₹8,030 at risk`, not `expired`.

## 4.15 Real-time

Socket.io event bus: `extraction.completed`, `clarification.sent`,
`negotiation.agreed`, `payment.order_created`, `payment.captured`,
`stock.changed`, `fulfillment.confirmed`, `agent.step`. Events fire from **actual
state transitions**, not from display code.

## 4.16 Verifiable Commerce History

A signed report of the merchant's trading record. Not a lending product — a
repackaging of what the chains already prove. Hand it to anyone; they can check
it without trusting us. It carries explicit caveats about what it does **not**
claim.

---

# PART 5 — THE DEMO SCRIPT

Full run sheet with exact commands: **`docs/DEMO_10MIN.md`**. Summary:

## 5.1 Before presenting

```bash
npm run demo:reset      # stock is real; rehearsing sells it out
npm run serve
```

## 5.2 Act 1 — the shopper (needs the language model)

1. **Type** *"a chocolate cake under ₹500"* → the shelf narrows, and the rail
   shows the lookup that produced the answer. **Point at the trail** — an
   assistant that made the sentence up looks identical without it.
2. **Click the Chocolate Cake 500g card** → prepares the purchase. Say out loud
   that this path needs **no model at all**.
3. **Confirm** → `₹450 asked, ₹422 paid`. Ceiling ₹450, floor ₹420, both
   enforced by the call that gates the money.
4. **The shop suggests more** → cross-sell panel. **Press "Keep it at ₹450"** at
   least once. Both buttons are equal; the refusal working is the point.

## 5.3 Act 2 — the deterministic core (no model)

5. **No deal**: ceiling ₹300 → `no_deal`, **no order created at all**, 0.7s.
6. **Upsell**: ceiling ₹800 → recommends the ₹599 Red Velvet, *not* the ₹760
   Celebration Cake that also fits. **A ceiling is a limit, not a target.**
7. **Analytics**: `/analytics/transactions` and `/analytics/integrity`.
8. **Sell it out**: five purchases, then `no_match`. Stock never goes negative.
9. **`npx tsx scripts/audit.ts`** → **44/44 claims verified**.

## 5.4 Act 3 — the merchant (no model)

10. **Catalog** — per-row real sales, provenance, and the two **held** products.
11. **Grow → dead stock** — `₹87 against your floor of ₹85`, capped by the
    merchant's own 8% policy.
12. **Confirm handover** — the buyer's page updates live; the fourth mandate is
    signed.

---

# PART 6 — SUCCESS AND FAILURE CASES

**This is the strongest part of the submission and should get the most airtime.**
The thesis: *anyone can demo the happy path; the interesting question is what the
system does when things go wrong.*

## 6.1 Failure cases the system handles correctly

| Failure | What happens | Why it is the right behaviour |
|---|---|---|
| **No price both sides accept** | `no_deal`, **no Razorpay order is created at all**, no transaction | Nothing to refund because nothing happened |
| **Merchant unsure of a price** | Product **withheld from every offer**; a specific question goes to WhatsApp | The system asks rather than guessing |
| **Out of stock** | `no_match`, with the shop named and the reason stated | Sold-out and unpriced are different answers |
| **Agreed price altered after signing** | Chain verification **fails** | The signature covers a different payload |
| **Forged webhook signature** | HTTP **401** | Verified over raw bytes, not the parsed body |
| **Payment captured twice** (webhook + browser) | One sale, one stock decrement, one WhatsApp message | Deduplicated at a single capture point |
| **Language model rate-limited** | Honest message in ~1s, deterministic paths still work | A whole-call deadline, not per-attempt |
| **Language model invents a price** | Answer **replaced** with one built from tool rows, with a note | `ungroundedFigures` scans every turn |
| **Model claims a purchase completed** | Answer **replaced**; nothing was bought | The loop never sees the press, so the claim is false by construction |
| **Model points at a button that isn't there** | Retried once, then the answer is replaced | `pointsAtButton` keys on the button reference, not the word "confirm" |
| **Model prices the wrong product** | Answer replaced with the correct pairing | `misattributedPrice` |
| **OCR returns low-confidence noise** | Discarded rather than believed | Confidence gate |
| **Fewer than 3 peer products for a sanity check** | Skips rather than fabricate a baseline | An invented baseline is worse than none |
| **Razorpay product not enabled** | Says so, with the call and status that proved it | §7.5 |
| **Tool lookup crashes** | *"That lookup failed"* — never *"you have no orders"* | A failure is not an empty result |

## 6.2 The five hallucination guards, in detail

Each was written against a **real observed failure**:

1. **`ungroundedFigures`** — the agent quoted "₹7,499" for a product that costs
   nothing like that. Every rupee figure in the answer must appear in a tool
   result from *some* turn of the conversation.
2. **`claimsPurchaseDone`** — the agent said *"your order is confirmed"* with
   zero orders in the database. Any past-participle claim of completion is
   replaced, because this loop never sees the press that would make it true.
3. **`pointsAtButton`** — the agent said *"Tap the **Pay ₹80** button"* and no
   button existed. **The guard existed and missed it**, because it was anchored
   on the word "confirm". It now keys on the reference to a button, excluding
   Add-to-cart, which really is on every card.
4. **`misattributedPrice`** — a price pinned to the wrong product. Not a
   rounding error: the shopper decides on it and the shelf highlights on it.
5. **`fromRowsOnly`** — the replacement answer, built from tool rows only. At one
   point *the guard itself* fabricated a failed search, which is why the
   replacement is now constructed rather than phrased.

**All are pure functions and all are checked in the audit** — the guards are
tested directly rather than by coaxing a model into failing.

## 6.3 Bugs found and fixed — worth mentioning as engineering honesty

`docs/CHALLENGES.md` documents **62 obstacles**. The recurring theme, and the
single best line to use:

> **The hardest bugs were never crashes. They were the system being confidently
> wrong.** A crash announces itself. A catalog that silently drops seven of a
> merchant's ten photos, or a reconciliation reporting four discrepancies that
> never happened, looks exactly like a working system.

Five worth naming:

- **Eight sales shared one payment id.** The simulated gateway reset its counter
  on restart while the database did not. Reconciliation then confidently reported
  four amount mismatches that had never happened.
- **₹7,911 from nine sales of a saree with one in stock.** Every number produced
  by the real negotiation engine; the whole thing nonsense. The engine prices a
  sale — it does not know how many exist. Closes are now truncated to stock, and
  the honest total fell from ₹11,305 to ₹3,602.
- **A shop could sell its last cake four times.** Nothing decremented stock. It
  hid perfectly because every screen agreed with every other screen — they were
  all reading the same stale field.
- **"The shop did not state a flavor"** — about a cake whose attributes read
  `flavour: chocolate`. The parser wrote the American spelling and the gate
  compared raw keys. Intermittent, and *articulate*: a confident sentence about
  something untrue reads as a data problem, not a bug.
- **"Wait at most 25 seconds" meant 218.** The cap applied per retry, not per
  call. A shopper's question was measured taking 218 seconds against a setting
  whose own comment says sixty reads as broken.

## 6.4 The audit — how any of this is known

```bash
npx tsx scripts/audit.ts     # 44/44 claims verified
```

Not a test suite that checks the code does what the code does. It **re-derives
every headline claim from the running system**, and fuzzes the negotiation
invariants over **500 randomised policies**. It found the webhook status-code
bug. It is the reason *"the agent never pays above its ceiling"* is a checked
statement rather than a confident one.

Four other checks: `npm run typecheck`, `npm run check:frontend`,
`npm run check:analytics` (6 acceptance tests), `npm run demo`.

---

# PART 7 — NOVELTY, AND HOW TO ARGUE IT

## 7.1 The honest structured-vs-unstructured comparison

**What most demos do**: show a bad "before" they built themselves.

**What this does**: `POST /discover/compare-modes` runs a literal text search
over the merchants' **real transcribed voice notes**, side by side with the
structured search over the same shops.

```json
"unstructured": {
  "what_a_machine_has": "the merchant's transcribed voice note and a photo filename",
  "searched": 30, "text_matches": 2,
  "can_filter_by_price": false, "can_check_stock": false,
  "can_verify_attributes": false, "can_negotiate": false, "can_buy": false,
  "results": [{ "raw": "essential cotton shirt 1299", "matched_words": ["cotton"],
    "missing": ["no price a machine can compare", "no stock count",
                "no attributes to match against the request",
                "no floor to negotiate within"] }]
}
```

**The detail that sells it**: the honest version matched a cotton *shirt* for a
cotton *saree* query. We kept that. A staged comparison could never have
produced a failure that specific, and it demonstrates the problem far better than
anything we would have written.

## 7.2 The agent may choose freely; it may not spend freely

**This is the core intellectual claim, and it is the answer to "why would anyone
let an AI spend their money".**

Search, compare, rank and haggle are unbounded — the agent can do whatever it
likes. Exactly **one** gate moves money, and it is a comparison between two
documents **the agent did not author**:

- the **intent mandate** the shopper signed (their ceiling, category, attributes)
- the **cart mandate** the merchant signed (the item, the agreed price)

The agent's opinion is not an input to that comparison. So the safety property
does not depend on the model behaving — it holds even if the model is adversarial.

**Demonstrate it**: alter an agreed price by one rupee and chain verification
fails, with the reason printed.

## 7.3 Determinism where it matters, language where it doesn't

The LLM writes the *sentence* of a negotiation. It never picks the *number*.
Floor, ceiling and round count are code.

**The line to use**: *"A model may phrase these lines. It never picks one of
these numbers."*

This is unusual. Most agentic-commerce demos let the model decide the price and
hope. Here, the price is decided by an engine you can read, and the invariants
are fuzzed over 500 random policies every audit run.

## 7.4 Confidence gating — the system asks rather than guesses

Two products in the demo are **deliberately held**:

```
Fresh Fruit Pastry     price confidence 0.10 < 0.6   "price abhi decide nahi kiya"
Festive Gift Candle    stock confidence 0.15 < 0.6   "godown mein dekhna padega"
```

They are **withheld from discovery entirely** — not ranked low, not shown with a
warning. They cannot be sold until a human confirms them, and the system sends
that human a specific question over WhatsApp.

**Why this is novel**: every extraction pipeline produces uncertain output. Most
ship the uncertainty downstream as though it were fact. This one treats "I am not
sure" as a first-class state with its own workflow.

## 7.5 Capability probed, never claimed

`GET /razorpay/capabilities` makes five read-only calls and reports what the
account can actually do:

```
✅ Payments        Orders + Checkout, the primary path
✅ Payment Links   GET /payment_links → 200
✅ Invoices        GET /invoices → 200
✅ Settlements     GET /settlements → 200
⛔ QR Codes        GET /payments/qr_codes → 400, not activated on this account
⛔ Smart Collect   GET /virtual_accounts → 400, not activated
```

And it distinguishes **whose problem** a failure is. Razorpay refuses an
unactivated product with `400 "The requested URL was not found on the server"` —
which reads as though we called a wrong URL. A genuinely wrong path is refused by
the gateway with `404 "no Route matched"`. The panel says which.

**The argument**: *"We integrated five Razorpay APIs"* is worth nothing if one is
a mock. Two products show ⛔ with the call and status code that proved it.
Mocking them would have been easy and would have been the one thing this project
cannot afford.

## 7.6 An audit that re-derives its own claims

Most projects assert their properties in a README. This one ships a script that
checks 44 of them against the running system, including cryptographic tampering
tests and a 500-policy fuzz.

## 7.7 Every statistic traces to a signed order

No counters. No `merchant.revenue` field to increment, no `product.sales` to keep
in sync. Every figure recomputed from the chains on each read, plus an integrity
endpoint that re-checks the arithmetic.

**The argument**: the alternative has a failure mode this design does not — a
write that lands in one place and not the other, after which the dashboard is
confidently wrong and nothing in the system can tell.

## 7.8 Attribution recorded at the moment it is known

Whether a sale was what the shopper came for or something the shop suggested is
knowable at exactly one instant: when the buyer agrees. It is recorded then. The
growth panel shows the split — and shows **nothing at all** when nothing has been
taken up, because a row of zeros beside a working cross-sell panel reads as a
broken panel.

## 7.9 The commerce layer sits on the rail the merchant already has

The split to state explicitly:

> **Razorpay QR** — the payment rail. Collects money at the counter.
> **Vyapar** — the commerce layer. Products, prices, stock, policies,
> negotiation, fulfilment — the things an AI buyer needs and a QR code cannot
> carry.

The merchant changes nothing. Same UPI ID, same QR sticker. What changes is that
there is now something an agent can read behind it.

---

# PART 8 — WHAT IS REAL AND WHAT IS NOT

**State this slide explicitly. It is a credibility asset, not a disclaimer.**

| | |
|---|---|
| Razorpay Orders, Checkout, signature and webhook verification | **real**, test mode |
| Payment Links, Invoices, Settlements | **real**, probed against the account |
| The mandate chain, ES256 signatures, hash links | **real**, re-verified at read time |
| Negotiation, ceilings, floors, stock, categories, policies | **real**, deterministic, no model |
| Revenue Agent scoring | **real** arithmetic over stored state |
| Merchant and product statistics, stock counts | **real**, recomputed from signed chains |
| The `sim_` rail | **simulated**, labelled `Gateway · Simulated` on every screen |
| The UPI settlement feed | **generated**, and every screen says so |
| Seeded buyer demand | **generated** — but outcomes are *played by the live engine* |
| Product photos | **illustrative** stock images, labelled as such on every row |

**Nothing is presented as measured when it is modelled. Anything estimated
carries the word *estimate* on screen.**

---

# PART 9 — KNOWN LIMITS (say these before you are asked)

- **Groq free tier**: 8,000 tokens/minute, 200,000/day **per organisation** — a
  new key does not reset it. The conversational layer will throttle during a
  long demo. Everything deterministic keeps working, and the failure message is
  honest and immediate.
- **QR Codes and Smart Collect** are not activated on the test account. Both are
  opt-in Razorpay products; neither is on the purchase path.
- **The settlement feed is generated.** Razorpay test mode does not produce real
  bank credits.
- **Photos are illustrative.** A stock photo of a cake is not Sri Balaji
  Bakery's cake, and the merchant screen says so on every row.
- **One cart mandate holds one item**, so a multi-product basket is several
  chains rather than one order with line items.
- **Buyer identity is a single demo agent.** No cross-session personalisation or
  purchase-history-based reordering yet.

---

# PART 10 — THE THREE SENTENCES TO LAND

1. **These shops have a UPI QR and nothing else a machine can read.** Everything
   here is built on top of that one fact, not on a catalog they do not have.

2. **The agent may choose freely; it may not spend freely.** Search, compare and
   haggle are unbounded. One gate moves money, and it compares two things the
   agent did not author — what the shopper signed, and what the merchant signed.

3. **Nothing is presented as measured when it is modelled.** The simulated rail
   says so. The settlement feed says so. Two Razorpay products show ⛔ with the
   status code that proved it. The audit re-derives 44 claims rather than
   asserting them.

---

# APPENDIX A — COMMANDS

```bash
node scripts/fetch-photos.mjs      # once, ever
npm run serve                      # http://localhost:3000
npm run demo:reset                 # before every rehearsal
npm run demo                       # seven-stage narrated walkthrough
npx tsx scripts/audit.ts           # 44 claims re-derived
npm run check:analytics            # 6 acceptance tests
npm run check:frontend             # page structure + highlight logic
npm run typecheck
```

# APPENDIX B — DOCUMENTS

| File | Contents |
|---|---|
| `docs/DEMO_10MIN.md` | The run sheet: prompts in order, what each proves, failure recovery |
| `docs/CHALLENGES.md` | 62 obstacles, each with cause and fix |
| `docs/DEMO.md` | Reference: shops, products, endpoints, what is real |
| `docs/GLOSSARY.md` | Every technical term, what it means, and how to say it out loud |
| `docs/MERCHANT_UI.md` | The merchant page: both modes, every panel, how data moves |
| `docs/BUYER_UI.md` | The storefront: the shelf, the agent rail, the run, paying |
| `docs/UI_BRIEF.md` | Design system |
| `docs/PHOTO_GUIDE.md` | Measured OCR guidance for image generation |

# APPENDIX C — THE URLS

```
http://localhost:3000/store.html      the shopper and their agent
http://localhost:3000/merchant.html   the shopkeeper, six screens
http://localhost:3000/onboard.html    onboarding a shop from scratch
```
