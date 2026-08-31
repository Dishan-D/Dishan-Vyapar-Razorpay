# Vyapar-to-Agent — what was built, and what broke

Companion to the README. Two parts: everything implemented, then every
technical obstacle hit while building it and how each was resolved.

The second part is the honest one. Every bug listed below actually happened,
was found in a specific way, and is fixed in a specific commit — the git
history is the source, not memory.

---

# Part 1 — What was built

**39 commits · ~12,200 lines · 59 source files · 39 HTTP endpoints · 11 runnable proof scripts**

## The claim

65–90 million Indian merchants take payment through a UPI QR and nothing else:
no website, no catalog, no API. Every live agent-commerce protocol (Google AP2,
OpenAI ACP) requires a structured product feed before an agent can *see* a
merchant, and all of them assume a fixed price — while ~85% of India's retail
runs through kirana stores where negotiation is the norm.

Two gaps, not one. This builds what has to exist before agentic commerce works
for that segment.

## The pipeline

```
merchant's photos / voice / text
      ↓  AI structuring (vision + text)
      ↓  deterministic price-sanity check
      ↓  combined gate — hold anything doubtful
      ↓  clarification — ask, don't guess
agent-readable catalog
      ↓  discovery across every merchant
      ↓  bounded negotiation (merchant's floor is hard)
      ↓  buyer authority check (shopper's limits are hard)
      ↓  Razorpay test-mode payment
      ↓  merchant-signed fulfillment
signed 4-mandate evidence chain
      ↓  reconciliation + trust history
      ↓  demand intelligence → approvable recovery actions
```

## Modules

| Area | Files | What it does |
|---|---|---|
| `src/mandates/` | 7 | ES256 JWS, RFC-8785 canonical JSON, ordered two-party signatures, hash-linked chain, buyer authority |
| `src/structuring/` | 9 | Vision+text extraction, price sanity, gating, clarification, WhatsApp, Whisper transcription |
| `src/negotiation/` | 3 | Deterministic bounded haggling; LLM phrasing only |
| `src/payments/` | 2 | Razorpay gateway, two-phase authorize/settle, the pre-payment gate |
| `src/revenue/` | 3 | Demand logging, opportunity detection, recovery centre |
| `src/marketplace/` | 2 | Agent readiness score, multi-merchant comparison |
| `src/agent/` | 2 | Natural-language intent, natural-language policy edits |
| `src/finance/` | 1 | Stage-by-stage reconciliation |
| `src/audit/` | 2 | Verified timeline, signed commerce history |
| `src/onboarding/`, `db/`, `events/`, `llm/`, `catalog/`, `fulfillment/`, `demo/` | 8 | Persistence, event bus, provider abstraction, rate governor |

## Screens

| Page | Shows |
|---|---|
| `/` | The loop in ten steps, each labelled with **who decides it**; live counters from stored state |
| `/onboard.html` | Three-step setup — photos, voice recording, text — with real staged processing |
| `/shop.html` | Buyer agent: a sentence in, a purchase out, with the authority gate and trust drawer |
| `/merchant.html` | Orders, clarifications, editable catalog, readiness, revenue, recovery, twin, trust, performance |
| `/market.html` | The live network — every shop contacted lights up as it happens |

## Where the AI is, and where it deliberately isn't

| Stage | Model? | Why |
|---|---|---|
| Structuring — draft | **yes** (vision + text) | Reading a photo and a Hinglish voice note is what a model is for |
| Structuring — sanity check | no | One LLM scoring its own confidence is one opinion checking itself. A z-score against the merchant's own prices is a second, independent one |
| Voice → text | **yes** (Whisper) | Transcription, nothing more |
| Discovery | no | A buyer-agent deserves an answer it can check; a filter is auditable, an embedding match is not |
| Negotiation | **phrasing only** | The merchant set a floor. No model talks the system below it |
| Intent parsing | **yes** | Language → limits. The model sets the ceiling; it never spends against it |
| Authority, payment, fulfillment, audit | no | Cryptography and money |

## What's real vs. simulated

**Real:** all signing and verification, canonicalization, hash-linking, chain
validation, the price-sanity maths, Razorpay test-mode orders and Checkout,
webhook signature verification, Socket.io events, Whisper transcription,
commerce-history signing.

**Simulated, and labelled in the UI:** three merchant personas on one backend
with genuinely separate keys; buyer-agent and merchant in one process; the
`sim_` gateway when no Razorpay keys are set.

**Degrades rather than fails:** no model key → hand-authored fixtures; no Twilio
→ clarifications queue in the dashboard; no Razorpay → simulated gateway with
`sim_` IDs that can never be mistaken for real ones.

---

# Part 2 — Build challenges and technical obstacles

Grouped by what kind of problem they turned out to be. The pattern that matters:
**almost nothing broke inside a component. Everything broke in the seams between
them, or where a model's output met code that trusted it.**

---

## A. The bugs that lived between stages

### A1 — The system negotiated three rounds over a towel set

**What broke.** The negotiation engine passed all four of its test cases. Then
the first click in the demo UI returned `402 payment refused` — a *payment*
error on a path that should never have reached payment. The refusal said the
item's category was `home.towel`, outside the intent's `apparel`. The
buyer-agent had asked for a blue cotton saree and been offered a **towel set**.

**How it was found.** The UI was the first thing that ran the pipeline end to
end. Every test until then had exercised one stage in isolation.

**Diagnosis — three faults stacked:**

1. Discovery matched anything sharing one query term. "Cotton" was enough.
2. The Intent Mandate's category constraint was only checked at the payment
   gate, so a bad match survived a full negotiation before anything objected.
3. Discovery excluded items priced above the buyer's ceiling — correct for a
   fixed-price catalog, and exactly wrong here.

**The third one took longest to see.** In this project the list price is an
*opening ask*, and an item above the ceiling is precisely the case negotiation
exists to resolve. What finally proved it: the filter made a genuine `no_deal`
**unreachable**. If discovery only returns items whose list price is under the
ceiling, and the floor is by definition at or below list, then the ceiling
always sits above the floor and a deal is always findable. The no-deal test had
been passing only because it called the engine directly, bypassing discovery.
The test was green and the system was wrong.

**Fix.** A relevance floor on matching; the category constraint applied at
discovery as well as at the gate; the ceiling filter removed, with over-ceiling
items returned and ranked lower.

**Why it's the right fix.** The gate did its job — money never moved. But
finding out at the till that you have been haggling over towels is not a system
working correctly, it is a system saved by its last line of defence.

`6f03a7f`

### A2 — The audit trail contradicted itself

**What broke.** A negotiation's `no_deal` reason quoted the buyer's best offer
as ₹888 — a number appearing nowhere in the log the reason was attached to.

**Diagnosis.** The loop advanced the buyer's offer after its final round and
exited without logging it, so the reason cited an offer that was never made.

**Why it mattered more than it looked.** The entire claim of this project is
that the log is evidence. A reason that disagrees with its own log is corrosive
to that in a way a crash would not be — nothing errors, and the record is
quietly wrong.

**Fix.** The last round ends on the merchant's final ask; the reason cites the
buyer's last *logged* offer.

`f0f430b`

### A3 — A gate that was tested without being tested

**What broke.** The tamper test for "cart exceeds the buyer's authorization"
mutated a signed cart. It was therefore refused for a **bad signature**, and the
authorization check never ran. The test passed for the wrong reason.

**Fix.** Build a *validly signed* cart that simply asks for too much — which is
the real threat model anyway, since a merchant and a buyer-agent can both sign
something the buyer was never authorized to agree to.

`7ba48b1`

### A4 — Two shops, one product name

**What broke.** Rafiq and Amma both stock "Black Silicone Phone Case". The shop
page and the buyer agent both bought *by name*, and discovery breaks a score tie
on price — so clicking Amma's listing, or the agent selecting Amma after
comparing, silently bought Rafiq's.

**Fix.** Every buy path pins `item_id`. `/transactions` honours it instead of
re-running a search the caller had already resolved.

`cf4f955`

---

## B. The model inventing constraints — four times

This was the single most persistent class of bug, and the most dangerous,
because every instance **silently blocked a legitimate purchase** or authorized
an illegitimate one. No errors, no crashes.

### B1 — An invented size requirement

Asked for a saree "delivered today", the model returned a `size` constraint
nobody mentioned. The authority gate then refused **every saree in the catalog**
for not stating a size.

### B2 — An invented delivery deadline

Asked only for "a white cotton kurta under 800", the model set same-day
delivery. Every shop was ruled out for being a day too slow — against a
requirement the shopper never made.

### B3 — A spelling mismatch that read as a missing field

The model wrote `colour`; the catalog uses `color`. Compared raw, this looked
like "the shop did not state a colour", which was **not true** — and blocked the
sale for a reason that did not exist.

### B4 — The budget itself, misread upward

One run read *"under 1020"* as a **₹1,190** ceiling. That is the most
consequential number in the system: it would have authorized the agent to
**overspend by ₹170**.

**The fix, applied uniformly.** A model may read what someone said. It may not
decide what they meant to say.

- Attributes are discarded unless their value appears in the shopper's own text.
- Delivery deadlines survive only if the text mentions timing.
- Attribute keys are normalised through a synonym map on both sides.
- A stated budget wins over the model's interpretation of it.
- Every discard is logged and surfaced in the agent trace.

`0f44f03`, `a8d74b3`

---

## C. Live model output behaves nothing like fixtures

Everything worked on hand-authored fixtures. The first live run broke three
things at once.

### C1 — Free-text categories silently disabled the sanity check

**What broke.** The price-sanity check groups by category. Left to phrase its
own, the model returned `"Saree"`, `"sweets"`, `"Snacks"` and `""` for items
that belong together. Every category then had one member, every baseline was too
small, and **the check silently skipped everything** — the ₹1,100 adhirasam,
the demo's best beat, sailed straight through.

**Fix.** The category is a fixed enum in the schema, and the prompt receives the
shop's own trade as context, because a phone shop does not sell snacks.

### C2 — `confidence === 1` collided with a sentinel

**What broke.** The code used "price confidence is exactly 1" to mean "the
merchant confirmed this directly". Live models return exactly `1.00` often
enough that real extractions were being waved through as merchant-confirmed.

**Fix.** An explicit flag. Overloading a value with a second meaning works right
up until something else produces that value.

### C3 — Photos alone extracted nothing at all

**What broke.** Three product photos with no accompanying voice note returned
**zero products**. The prompt's careful instruction not to invent was reading as
"return nothing if unsure".

**Fix.** An unpriced product is still a product — list it with a null price and
let the clarification loop ask. That is what the loop is *for*. Three photos now
return three products, all correctly held for a price question.

### C4 — Live extraction is not repeatable

Two runs an hour apart gave different catalogs: a saree named "…with Gold Zari
Work" one time and "…with Gold Border" the next; stock read as 1 with 0.95
confidence, then as 0 with zero confidence — despite the voice note plainly
saying *"ek hi piece bacha hai"*. That second run made the item unbuyable and
broke a test that assumed it was for sale.

**Fix.** Two decisions rather than one. Tests assert *arithmetic over whatever
actually sold*, never that a specific item was in stock. And the served catalog
is an explicit choice: `--live` for the real thing, `--fixtures` to reclaim a
repeatable one, with fixtures refusing to overwrite a live catalog unless asked.

`deff56c`, `b745b01`, `c6547b4`

---

## D. Configuration and infrastructure

### D1 — An empty environment variable that broke everything downstream

**Symptom reported:** "why isn't the agent running as expected?"

**Actual cause.** A stray `GROQ_MODEL=` line in `.env`. The code read it with
`??`, which only falls back on `undefined` — an empty string is a perfectly good
value. The model name became `""`, and every structured-output call returned:

```
404  The model `` does not exist or you do not have access to it
```

**The worse half.** `parseIntent` swallowed the error and fell through to the
rule-based parser. A silent fallback is **indistinguishable from the model
choosing to be deterministic** — on a page whose entire purpose is showing where
the model is and is not used, that was the more dangerous of the two bugs.

**Fix.** Env reads treat blank as unset (also corrected for `PORT`,
`PUBLIC_BASE_URL`, `DEMO_PAUSE_MS`). Fallbacks now report *why*, in the trace, in
the server log, and as a warning row in the UI.

`2908028`

### D2 — `.env` was never loaded at all

Razorpay keys sat in `.env` doing nothing; the app silently ran on the simulated
gateway. Nothing read the file. Fixed with Node's `--env-file-if-exists`, which
loads it where present and stays quiet on a fresh clone.

`e4f111d`

### D3 — Groq's token ceiling, measured rather than guessed

**What broke.** A full 15-item catalog extraction died partway with
`rate_limit_exceeded`, discarding eleven successful calls that had already cost
money.

**Measured, not assumed:**

| | |
|---|---|
| Tier limit | **8,000 tokens per minute** (`on_demand`) |
| One product photo | **~2,074 tokens** |
| Full 15-item catalog | **~19,400 tokens** — ~2.5 minutes of budget |
| Agent intent parse | 177 tokens |

**A dead end worth recording:** downscaling images does nothing. A 191 KB photo
and a 640px version of it both cost **exactly 1,820 prompt tokens** — Groq bills
images flat. There is no way to shrink the bill, only to pace it.

**Fix.** A governor reads `x-ratelimit-remaining-tokens` and
`x-ratelimit-reset-tokens` off every response, waits when the next call will not
fit, and honours `retry-after` on a 429. One budget per process, shared by
extraction, phrasing and intent parsing — separate governors would each have to
rediscover the limit by hitting it.

**Batch and interactive want opposite things**, so they get opposite behaviour: a
catalog build waits out the minute and reports each pause; an interactive call
gives up after 3 seconds and uses its deterministic path, because a demo that
freezes for a minute reads as broken.

Result: 15/15 extracted live, zero fallbacks, three pauses. Fourteen
back-to-back agent runs at under 800 ms each.

`9b9f192`

### D4 — A cache that served a schema that no longer existed

`data/catalog.json` is reused to avoid paying for extraction on every boot. When
merchant fields were added, the cache kept serving records without them — and it
looked fine. Any merchant missing a current field now invalidates the whole file.

Separately: a plain `npm run milestone-b` overwrote a live catalog with
fixtures, throwing away three minutes of paced extraction. Fixtures no longer
overwrite a live catalog unless explicitly asked.

`92fc575`, `b745b01`

---

## E. Honesty bugs — where the system over-claimed

These are the ones that would have damaged the project most, because each one
produced a confident, plausible, **wrong** statement.

### E1 — A revenue recommendation that could not have worked

The first version told a merchant: *"lower your floor by ₹30 and five buyers who
walked would have bought it."* It was false. At a floor equal to a buyer's
ceiling the haggle has no room to converge — **none** of those five would have
closed.

**Fix.** The negotiation engine is deterministic, so the claim is testable. A
proposed floor is now checked by **replaying every lost buyer's actual offers**
against it and counting who closes, walking down in ₹10 steps to find the
smallest concession that genuinely works. The recommendation now reads
*"replaying those haggles at ₹1,000, 5 of them close"* — and it is true.

### E2 — One outlier hid an entire opportunity

The floor opportunity took the highest ceiling among buyers who walked. One
misparsed run (D1's ₹1,190) meant that buyer had headroom, which made it look as
though everyone could already afford the item, and the opportunity vanished.
Only buyers the floor genuinely shut out are counted now.

### E3 — A recovery case that deleted itself when acted on

Recovery cases were recomputed against the *current* floor. Approving an action
lowered the floor, the buyers stopped counting as shut out, and the case
disappeared — so it could never be seen reaching "recovered".

**Fix.** Judge against the floor those buyers actually faced. A record of lost
money must survive the fix.

### E4 — "Recovered" had to mean money actually returned

Approving a recovery action is an *attempt*, not an outcome. A case reads
`recovered` only once a real sale closes afterwards. Verified end to end:
`at_risk ₹3,060 → action_taken (₹0 recovered) → recovered ₹1,003`.

`dd6c43f`

---

## F. Interface and observability

### F1 — Nothing could ever be marked delivered

**Symptom reported:** "stuck on paid not delivered."

Every agent purchase sat there forever, because **no screen had a confirm
button**. An earlier page had one; it was removed during a redesign and never
rebuilt. The agent correctly refuses to confirm a handover it cannot witness, so
without that button the flow had no ending.

### F2 — The market view sat still through entire purchases

**Ten of twelve events carried no `merchant_id`**, so the network view's flash
handler bailed early and no connection ever lit. Only the final two animated,
forty milliseconds apart. Steps now name the shop they concern, every shop
contacted emits its own event, and a burst is paced so it can be read — pacing
real events, inventing none.

### F3 — The UI hung forever on "Thinking…"

The agent run had no error handling. Any failure — a restarted server, a dropped
connection — left that text on screen with the button permanently disabled,
indistinguishable from a slow run. Timing instrumentation then showed the real
answer: **641 ms of a 650 ms run is the Groq round trip**, everything else under
10 ms. Any wait beyond a second is a rate limit or a fault, never the agent
thinking.

### F4 — Every event delivered twice

The event bus broadcast to everyone *and* emitted to the per-merchant and
per-transaction rooms, so anyone watching a specific merchant received every
event twice. One emit across the room set now, and a viewer that narrows its
watch leaves the firehose.

`e57035c`, `766b443`, `c6547b4`

---

## G. Two external-service obstacles

### G1 — Razorpay rejected the standard test card

Checkout failed with *"International cards are not supported"* using
`4111 1111 1111 1111` — the card almost every payment tutorial uses. Razorpay
classifies it as international, and test accounts have international payments
disabled. Nothing was misconfigured.

**Resolution.** Documented the **domestic** test cards
(`4100 2800 0000 1007`, `5555 5100 0008 1006`, `6527 6589 0000 1005`) and
recommended UPI `success@razorpay` as the easier demo path — no card fields to
type on camera. Also recorded that cancelling a UPI payment in test mode still
reports success, so failures must be demonstrated with `failure@razorpay`.

### G2 — A real `payment_id` cannot be created server-side

The agent could complete everything except the payment: a `payment_id` only
exists once someone actually pays through Checkout in a browser. Correct
behaviour, but it meant the agentic loop could never be *shown* closing.

**Resolution.** Two rails. The default hands off to Checkout when real keys are
present. A `settle: "test_rail"` option lets the agent finish unattended, with
`sim_` IDs and the rail named in the trace. It still stops at "paid, not
delivered": the agent can spend money, it cannot hand goods across a counter.

`7d0b44b`, `2908028`

---

# The pattern

Twenty-five distinct bugs. Almost none of them were inside a component.

- **The seams** produced the worst behaviour. Every stage passed its own tests while the pipeline did something absurd.
- **Model output met trusting code** four separate times, and every instance failed *silently* — blocking legitimate purchases or authorizing overspend without an error anywhere.
- **Fixtures hid three bugs** that the first live run exposed within minutes.
- **The most dangerous bugs were the confident ones** — a recommendation that could not work, a recovery that deleted itself, a fallback that looked like a decision.

The habit that caught most of them: making the system state its reasoning in
terms a human can disagree with. A negotiation that prints the rule behind each
number exposed the ₹888. A recommendation that must name its evidence exposed
the impossible floor. A trace that says *who decided* each step exposed the
silent model fallback.

---

# For the application form (150–250 words)

> I built the pipeline bottom-up, and the negotiation engine passed all four of
> its test cases. Then the first click in the demo UI returned a *payment*
> error on a path that should never reach payment: the buyer-agent had asked for
> a blue cotton saree and been offered a towel set. Discovery matched anything
> sharing one query term, and "cotton" was enough.
>
> Two fixes were obvious. The third took longer. I had written discovery to
> exclude items priced above the buyer's ceiling — right for a fixed-price
> catalog, and exactly wrong here, where the list price is an opening ask and an
> over-ceiling item is precisely what negotiation exists to resolve. What
> convinced me was noticing the filter made a genuine no-deal *unreachable*: if
> the ceiling always sits above the floor, a deal is always findable. My no-deal
> test had been passing only because it called the engine directly, bypassing
> discovery. The test was green and the system was wrong.
>
> The lesson held for the rest of the build. Every test I had written exercised
> one stage; every serious bug lived in the seam between two. The related class
> was worse: four times the model invented a constraint nobody stated — a size,
> a delivery deadline, once a budget ₹170 above what was asked — and each one
> failed silently. Anything a model returns is now discarded unless it is
> traceable to the user's own words.
