# The ten-minute demo — what to say, and when

Every figure below came back from the running system after a clean reseed. If a
number here does not match your screen, reseed and it will.

**On the quoted answers:** the *figures* are deterministic — 45%, ₹5,392,
₹73,024 will be what you see. The *sentences* are not. The one reasoning turn is
phrased by a language model, so it will word the same finding differently each
run. Read what is on your screen; do not recite from this page.

**The 20-second version, the sourced figures and the differentiation table are
in `docs/PITCH.md`.** Read that first; this expands on it.

**The tech stack is a section of its own near the end** — read it before you
present, but do not read it out. The callouts through the script pull in the
right piece at the moment it explains something you have just shown.

**Before you walk in:**
```bash
npx tsx scripts/seed-history.ts --fresh && npx tsx scripts/seed-history.ts
npm run demo:reset
npm run serve
```
Two browser tabs open: `/store.html` and `/merchant.html`. A terminal on the
second monitor if you have one — the server log is a live trace of the agent's
reasoning and it is worth having visible.

---

# The shape of it

| | Minutes | What | Why it is there |
|---|---|---|---|
| **1** | 0:00–1:15 | The problem | Everything rests on one fact |
| **2** | 1:15–3:30 | A buyer-agent buys something | The thing nobody else can do |
| **3** | 3:30–4:15 | The refusals | Why anyone would allow it |
| **4** | 4:15–7:00 | The merchant assistant | Where the judges lean forward |
| **5** | 7:00–8:30 | How the numbers are made | Why to believe any of it |
| **6** | 8:30–10:00 | Novelty, and the audit | The close |

**If you are cut to five minutes:** sections 1, 4 and 6. The merchant assistant
is the strongest thing you have.

---

# 1 · The problem (0:00 – 1:15)

**Open on the homepage.**

> "India has roughly **thirteen million kirana shops** — 88% of its retail.
> Six hundred and seventy-eight million UPI QR codes are deployed, and 93% of
> these shops take digital payments. This is one of them — Sri Balaji Bakery.
>
> Everything a machine can read about this shop is **one string**: their UPI ID.
> That is the whole of their machine-readable existence.
>
> Meanwhile, buyer-agents have arrived. Last September Google shipped **AP2**,
> the Agent Payments Protocol, with sixty-plus partners — Mastercard, PayPal,
> Amex. It answers the question agentic commerce actually turns on: *was the
> charged amount the agreed amount?*
>
> And it assumes the merchant already exposes a catalog over MCP. That holds for
> Amazon. It holds for a Shopify store.
>
> For this shop it is not poor data. It is **no data**. A QR sticker moves money.
> It cannot say what is for sale, what it costs, whether any is left, or whether
> the shopkeeper would take less.
>
> So when a buyer-agent goes looking for a chocolate cake, this shop does not
> lose the sale. It is not in the running. It is invisible."

**Scroll to the four-step loop.**

> "What we built is the layer in between. The merchant sends what they already
> have — a photo, a voice note in Hinglish, a sentence. Not a form. And out the
> other side is something an agent can transact against, sitting on top of the
> same UPI ID they have always had.
>
> The payment rail doesn't change. What changes is that there is now something
> behind it worth reading."

> **Tech, in one breath:** "A photo goes through Groq's vision model; a printed
> price tag goes through tesseract OCR first, behind a confidence gate so
> low-confidence text is thrown away rather than believed; a Hinglish voice note
> goes through Whisper. Every field comes out with a confidence score, and
> anything under the threshold is **held back and asked about** rather than
> guessed."

*Say it and move — nobody buys a project on its model list. The confidence gate
is the only part worth a second sentence, and you will show it later.*

---

# 2 · A buyer-agent actually buys something (1:15 – 3:30)

**Storefront tab.** Type into the agent rail:

> **"a chocolate cake under ₹500"**

```
Two cakes under ₹500: Chocolate Cake 500g at Sri Balaji Bakery (₹450)
and Chocolate Truffle Cake 500g at New Krishna Sweets (₹490). Which would you like?
```

> "Two shops. Note what is on screen above the answer — the lookup it ran. That
> matters more than the sentence. An assistant that made this up would look
> **identical** without that trail."

**Click the Chocolate Cake card.**

> "The shopper answers by pointing. And this path uses **no language model at
> all** — the card already knows the product, the shop and the price, so
> clicking it cannot fail because something is rate-limited. That will matter in
> about four minutes."

**Press Confirm.** The rail fills in:

```
understand   Read that as: chocolate cake 500g, ceiling ₹450
shop         Checked 7 shops; 1 stock it
choose       Chose Sri Balaji Bakery at ₹422
sign         Intent and cart mandates signed
authorize    Purchase authorized
pay          Paid ₹422
wait         Paid, not delivered
```

> "Asked ₹450. Paid **₹422**. The shopper's ceiling was ₹450, the shop's floor is
> ₹420, and the price landed between them.
>
> Here is the part I want to be precise about. **A language model wrote none of
> those numbers.** The haggle is a deterministic engine — floor, ceiling, round
> count, all enforced in code. The model may phrase a sentence. It never picks
> one of these numbers."

**When the cross-sell panel appears — press "Keep it at ₹450".**

> "The shop suggested two things to go with it. I said no, and nothing was added.
> Both buttons are equal. That refusal working is the point of showing it."

> **Tech, pointing at the trail:** "Those steps are Socket.io events fired from
> **real state transitions** — the server emits where it already writes to the
> database, so there is nothing to fake. And that price becomes a real Razorpay
> order the moment the rules agree it: `orders.create` on the Razorpay SDK, test
> mode, on this shop's own UPI ID."

**If you have a spare fifteen seconds, run this and show the id:**

```bash
curl -s -XPOST localhost:3000/agent/run -H 'content-type: application/json' \
  -d '{"goal":"Chocolate Cake 500g under ₹450","item_id":"itm_hazel_001",
       "max_price":450,"opening_offer":396,"settle":"checkout"}'
```
```
status        awaiting_payment
order_id      order_TXAzHdrbFvZlw6
```

> "A real order, created against Razorpay's API a second ago. And `awaiting_payment`
> — not paid. **A payment id cannot be created server-side.** Somebody has to
> actually pay, which is exactly the property you want."

*There is also a `gateway-status` endpoint that calls `orders.fetch` and prints
Razorpay's answer beside ours, including when they disagree. Mention it; only
open it if asked.*

---

# 3 · The refusals (3:30 – 4:15)

**This section is short and it does a lot of work.** Run it from a terminal:

```bash
curl -s -XPOST localhost:3000/agent/run -H 'content-type: application/json' \
  -d '{"goal":"Chocolate Cake 500g under ₹300","item_id":"itm_hazel_001",
       "max_price":300,"opening_offer":240,"settle":"test_rail"}'
```

```
status      no_deal
transaction none
reason      No merchant reached a price within the buyer's authorization.
```

> "Ceiling below every floor. Back in seven-tenths of a second, and — this is
> the bit — **no Razorpay order was created at all.** There is nothing to refund
> because nothing happened.
>
> This is the answer to the only question that actually matters about agentic
> commerce: *why would I let software spend my money?*
>
> The agent can search, compare, rank and haggle as freely as it likes. **Exactly
> one gate moves money**, and it compares two documents the agent did not write —
> the intent the shopper signed, and the cart the merchant signed. The agent's
> own opinion is not an input to that comparison.
>
> Which means the safety property does not depend on the model behaving. It
> holds even if the model is adversarial."

> **Tech, and this is the one to say properly:** "Every sale is **four
> ES256-signed mandates** — intent, cart, payment, fulfilment — each carrying a
> SHA-256 hash of the one before it. Signed with `jose` over **RFC-8785 canonical
> JSON**, so the hash breaks on tampering rather than on key order. And the chain
> is **re-verified when it is read**, not trusted from a stored flag.
>
> Change an agreed price by one rupee and verification fails, with the reason
> printed.
>
> Razorpay's own two signatures sit inside that: Checkout's
> `validatePaymentVerification`, and the webhook's `validateWebhookSignature`
> checked over the **raw request bytes** — because parsing the body first is how
> signature checks quietly stop working. An unsigned webhook gets a 401."

*The audit at the end proves the tamper case over 500 randomised policies. You
do not need to open the code.*

---

# 4 · The merchant assistant (4:15 – 7:00)

**This is your strongest segment. Give it the time.**

**Everything below runs on Sri Balaji Bakery.** It is seeded so that every
capability has something real to work on — a bad week inside a good month, orders
waiting, money uncollected, buyers who stopped coming, a product still awaiting a
price. **You never have to change shops.**

**Merchant tab → Sri Balaji Bakery.** Press the mic.

### 4a — Open with what is waiting

> 🎙 **"what needs my attention"**

```
₹101 today across 1 order. 71 waiting to be handed over —
say "hand these over" and I will do all of them.

     ┌──────────────────────────────────────────────────────────┐
     │ Mark all 71 paid orders — ₹16,305 — as handed to buyers   │
     │                       [ Yes, do it ]        [ No ]        │
     └──────────────────────────────────────────────────────────┘
```

> "It didn't just tell me. The answer arrived **with the action on it.**"

**Don't press yet — come back to it in 4e.**

### 4b — The question every shopkeeper has

> 🎙 **"why are my sales down"**

```
Your sales are down 36% to ₹20,812, mostly because your top sellers —
the 1kg Chocolate Cake and the 500g Chocolate Cake — sold much less than usual.
```

> "Six months of trading history, eleven thousand transactions, in about a second
> and a half. Watch the three lookups tick off, each tagged with which specialist
> ran it — those are real queries against real transactions."

### 4c — The same shop, a different window

> 🎙 **"how did i do this month"**

```
₹1,23,967 the last 30 days, across 419 orders.       ↑ 17% vs the month before
```

> "**Stay on this for a second.** The week is down thirty-six per cent. The month
> is up seventeen. Same shop, same data, both true — it measures the window you
> asked about rather than having one opinion about the business.
>
> A templated system has one answer and reaches for it. This one goes and looks."

**Optional, fifteen seconds, and the strongest honesty moment you have:** switch
the selector to **Ganesh Tea & Coffee** and ask *"why are my sales down"* again.

```
Your sales are actually up 11% over the last 7 days.
```

> "I asked a loaded question and it told me they aren't. It measures first and
> explains second — so a healthy shop does not get handed reasons for a decline
> that never happened."

**Switch back to Sri Balaji.**

### 4d — Speed, and why it matters

> 🎙 **"whos my biggest customer"**

```
Latha D spends the most — ₹33,350 over 116 orders. Your top five are 22% of
everything you take, and 60% of your 126 buyers have come back more than once.
```

> "Three hundred and eighty milliseconds. **Zero language-model tokens.**
>
> A router recognised the question, a ledger read answered it, a template said
> it. The model is only called for the one question that needs reasoning — the
> *why*.
>
> We are on a free tier of eight thousand tokens a minute. Routing everything
> through a model would mean a demo that apologises instead of answering."

**Then, to show it is a conversation:**

> 🎙 **"which of them stopped coming"**

```
17 buyers who used to come regularly have not bought in 30+ days.
Between them they had spent ₹89,380. The biggest is Usha R, quiet for 75 days.
```

> "*Them.* No subject in that question at all — every word saying what it is
> about was in the one before. That state is held server-side, because the
> answers are about money and the browser is not where the money is."

### 4e — It acts, and it is careful about it

**Back to the action from 4a.**

> 🎙 **"hand these over"**

```
71 paid orders worth ₹16,305 are waiting. Confirming marks every one of them
as handed to its buyer — each gets its own signed record.
```

**Press it.**

```
Done — 71 orders marked as handed over.
```

> "Seventy-one handovers from one sentence. And that is **not** a bulk database
> update — each one is a separate signed fulfilment mandate on its own chain.
> Seventy-one signatures, because seventy-one sales were closed."

**Press it again.**

```
Already done.
```

> "Idempotent by action id. A shopkeeper on a shop's connection who presses twice
> because the first response never came back gets seventy-one handovers, not a
> hundred and forty-two. And a partial failure reports *'handed over 60 of 71'* —
> it will not put a green tick over a partial result."

**And to show it will not guess:**

> 🎙 **"send a payment link"**

```
There are 188 of those — tell me which one and I will get it ready.
Chocolate Puff (txn_h511wzhaze), Red Velvet Cake 1kg (txn_h511x0haze), …
```

> "A hundred and eighty-eight orders were agreed and never paid for — ₹55,898.
> It will not pick one for me. Bulk when I say *these*; a question when I say
> *that*."

### 4f — Two things it refuses

> 🎙 **"refund two thousand four hundred to rahul"**
>
> *Refunds are not wired up in this build, so I cannot start one — and I would
> rather say that than tell you a refund is on its way.*

> "**I am showing you this deliberately.** An honest refusal of something we have
> not built, sitting next to a dozen things we have.
>
> An assistant that never says *I can't* is one you can never believe when it
> says *I did*."

> **Tech for this whole section:** "Groq is called for **one** of those six
> answers — the *why*. Everything else is a deterministic router over a tool
> registry, where each capability declares whether it writes and whether it needs
> a human press. Twenty-five spoken phrasings are regression-tested, so the ones
> I just used are checked in CI.
>
> The actions are idempotent by action id. And the microphone is the **browser's
> own** Web Speech API — there is no speech service in our stack to fail on
> stage."

### 4g — Optional: the Razorpay products behind the actions

*Only if you have the time. It closes the loop between the assistant and the
payment rail.*

> 🎙 **"send a payment link"** → name one of the 188 unpaid orders → press.

> "That is a **real Razorpay payment link** — `POST /v1/payment_links` — carrying
> the transaction id as its reference, so the link traces back to the signed
> chain that authorised it. The same panel raises a **real invoice** through
> `POST /v1/invoices`, and it refuses to raise one before handover is confirmed:
> *an invoice for goods that have not moved is not a record, it is a fiction.*"

**Tech:** *These two go over the raw REST v1 API rather than the SDK, because the
SDK's coverage of the newer products lags and we would rather call the documented
endpoint than trust a wrapper.*

---

## Sri Balaji has all of it — reference

Seeded so that every merchant capability has something real to work on. Counts
drift as you rehearse; the shapes hold.

| Ask | What is there | Beat |
|---|---|---|
| "what needs my attention" | **71 handovers waiting**, ₹16,305 | inline action |
| "why are my sales down" | **week −36%** | measured decline |
| "how did i do this month" | **month +17%** | two true answers |
| "who hasn't paid me" | **188 unpaid**, ₹55,898 | uncollected money |
| "whos my biggest customer" | 126 buyers, 60% repeat, top 5 = 22% | customer analytics |
| "which buyers stopped coming" | **17 lapsed**, ₹89,380 of past trade | win-back |
| "what are my best sellers" | Chocolate Cake 1kg, ₹1,49,233 · 1 never sold | product analytics |
| "when is my rush" | **6pm, Saturday** | trading patterns |
| "how do i earn more" | **8 opportunities** — Butter Puff idle | Revenue Agent |
| "what can't agents buy yet" | **Fresh Fruit Pastry** held | the clarification loop |
| "hand these over" | bulk, idempotent | the action |
| "set the price of butter puff to 88" | proposal → catalog changes | a write |
| Money screen | 99% reconciled, 29 exceptions | UPI matching |

**Reset to exactly this:**
```bash
npx tsx scripts/seed-history.ts --fresh && npx tsx scripts/seed-history.ts
npm run demo:reset
```
`--fresh` also clears what your rehearsals wrote — without it, an afternoon of
practice runs leaves the shop reading *+109% this week*, which is true and
destroys the story.

---

# 5 · Where the numbers come from (7:00 – 8:30)

**Merchant → Insights.**

> "Five figures: sales, orders, buyers, average order, repeat rate.
>
> Here is the claim I want to make about all of them. **There is no revenue
> counter anywhere in this system.** No `merchant.revenue` field, no
> `product.sales` column. Every number is recomputed from the signed transaction
> chains at the moment you ask for it."

**Explain each, briefly — this is the "how is it calculated" answer:**

| On screen | How it is computed |
|---|---|
| **Sales** | Sum of amounts on chains that carry a **payment** mandate. Agreed-but-unpaid is excluded. |
| **Orders** | Count of those same chains. |
| **Average order** | Sales ÷ orders — per *order*, not per item. |
| **Buyers** | Distinct buyer ids, read off the **signed intent** mandate. |
| **Came back** | Buyers with more than one paid order ÷ all buyers in the window. |
| **The change %** | This window against the one immediately before it, same length. |

> "Why does that matter? The alternative — a counter you increment when a payment
> lands — has a failure mode this does not. One write succeeds, the other
> doesn't, and from then on your dashboard is confidently wrong and **nothing in
> the system can tell.**
>
> Here, a figure cannot drift from the transactions it summarises, because it
> *is* the transactions."

**Point at "I noticed something".**

> "This panel takes the largest measured change and names it. And it **hides
> itself** when nothing moved enough to be worth saying — because a dashboard
> that always has an insight is one whose insights nobody reads."

**Then, the line that lands it — run this:**

```bash
curl -s localhost:3000/analytics/integrity
curl -s localhost:3000/analytics/transactions
```

> "Any figure on any screen can be checked against the rows it came from without
> opening the database. And `integrity` re-checks the arithmetic — that line
> totals sum to their transaction, that no payment id appears on two sales, that
> no sale is credited to a shop that does not stock the product.
>
> A statistic nobody can audit is indistinguishable from one that is made up."

> **Tech:** "SQLite, append-only — a mandate type is written once per transaction
> and never updated, because an evidence chain you can overwrite in place is not
> evidence. No ORM, no cache, no materialised view. Eleven thousand transactions
> is a query, not a prompt: the model **explains** these numbers, it never
> computes one."

**Worth saying if asked about the data:** *"The six-month history is generated —
those buyers never existed. But every order in it ran through the production
negotiation engine and came out as four genuinely signed mandates. Signing costs
0.3 milliseconds, so eleven thousand of them took under six seconds. It is
synthetic in **who**, and real in **how**."*

---

# 6 · Novelty and the close (8:30 – 10:00)

**Three claims. Do not list more.**

### 1. The honest before-and-after

**Homepage → the comparison panel. Type a query.**

> "Most demos show you a 'before' they built themselves. This runs a literal text
> search over the merchants' **actual transcribed voice notes** — which is
> genuinely all a machine has before our pipeline runs.
>
> It cannot filter on price, because no price has been parsed. It cannot check
> stock. It cannot negotiate.
>
> And the honest version matched a cotton **shirt** for a cotton **saree** query.
> We kept that. A staged comparison could never have produced a failure that
> specific."

### 2. The agent may choose freely; it may not spend freely

> "I said this earlier and I will say it once more because it is the whole idea.
> Search, compare, haggle — unbounded. One gate moves money, and it compares two
> documents the agent did not author."

### 3. Nothing is presented as measured when it is modelled

**Merchant → Money → the Razorpay capability panel.**

```
✅ Payments        Orders + Checkout, the primary path
✅ Payment Links   GET /payment_links → 200
✅ Invoices        GET /invoices → 200
✅ QR Codes        GET /payments/qr_codes → 200
✅ Settlements     GET /settlements → 200
⛔ Smart Collect   GET /virtual_accounts → 400, not activated on this account
```

> "Five read-only `GET`s against `api.razorpay.com/v1`, made with this account's
> test keys when the page loaded.
> Four answer. One comes back unavailable — and the panel shows the call and the
> status code that proved it, and says **whose problem it is**, because Razorpay
> refuses an unactivated product with a message that reads like *we* called a
> wrong URL.
>
> We could have mocked that last one. That is the one thing this project cannot
> afford."

### The close

**Run the audit. Let it scroll.**

```bash
npx tsx scripts/audit.ts
```

```
60/60 claims verified
Every claim in the audit list holds against the running system.
```

> "Everything I have claimed in ten minutes, this script re-derives from the
> running system — including fuzzing the negotiation invariants over five hundred
> randomised policies.
>
> So *'the agent never pays above its ceiling'* is a **checked** statement, not a
> confident one.
>
> Three sentences to leave you with.
>
> **One.** These shops have a UPI QR and nothing else a machine can read.
> Everything here is built on top of that fact, not on a catalog they don't have.
>
> **Two.** The agent may choose freely. It may not spend freely.
>
> **Three.** Nothing here is presented as measured when it is modelled — and
> where we couldn't build something, it says so.
>
> Thank you."

---

---

# The stack, in one place

Read this before you present. **Do not read it out** — the callouts through the
script pull the right piece in at the moment it explains something. This is the
reference for the questions afterwards.

## Razorpay — what we actually call

Everything here is **test mode**, key `rzp_test_TVzyrvLO79DETV`, and every one of
these was made by the running system, not read from documentation.

| Where | Call | What it does here |
|---|---|---|
| **Orders API** | `orders.create` | A real order the moment the rules agree a price — e.g. `order_TXAzHdrbFvZlw6` |
| | `orders.fetch` | Reads our own order **back from Razorpay** for the gateway-status panel |
| **Payments API** | `payments.fetch` · `payments.capture` | Confirms and captures against the gateway, not against our own record |
| **Checkout** | `checkout.razorpay.com/v1/checkout.js` | The hosted flow the buyer actually pays through |
| **Signature verification** | `validatePaymentVerification` | Checkout's `razorpay_signature`, checked **server-side** — never in the browser |
| | `validateWebhookSignature` | Webhook HMAC, checked over the **raw request bytes**, not the parsed body |
| **Webhooks** | `POST /webhooks/razorpay` | `payment.captured` lands here; an unsigned one is refused with 401 |
| **Payment Links** | `POST /v1/payment_links` | A real link for an order the buyer agreed and never paid |
| **Invoices** | `POST /v1/invoices` | A real invoice, only after the merchant confirms handover |
| **Settlements** | `GET /v1/settlements` | What Razorpay has actually paid out |
| **Capability probe** | `GET` × 5 | Asks the account what it can do — see the ⛔ on Smart Collect |

**SDK:** `razorpay@2.9.8` for Orders, Payments and the signature utilities. The
four newer products go over the **raw REST v1 API** with HTTP Basic auth,
because the SDK's coverage of them lags and we would rather call the documented
endpoint than trust a wrapper.

**The three sentences worth having ready:**

> *"Orders and Checkout are the primary path — every agent purchase goes through
> them."*
>
> *"Both signatures are verified server-side, and the webhook one over raw bytes,
> because parsing the body first is how signature checks quietly stop working."*
>
> *"We probe five products rather than claiming them. One comes back
> unavailable and we show the status code."*

## The rest

| Layer | What | Why that |
|---|---|---|
| **Reasoning** | Groq · `qwen/qwen3.8-27b` | Tool-calling, and fast enough to answer inside a conversation |
| **Vision** | Groq vision | Photos of a shelf or a price list → products |
| **Speech (merchant photos/notes)** | Groq · `whisper-large-v3-turbo` | The Hinglish voice note the shopkeeper sends |
| **Speech (the mic)** | Browser Web Speech API | **No service to configure and nothing to fail on stage** |
| **OCR** | `tesseract.js` | Printed price tags, behind a confidence gate — low-confidence text is discarded rather than believed |
| **Fallback model** | Anthropic · `claude-opus-5` | If Groq is unreachable; the deterministic paths never depend on either |
| **Signatures** | `jose` — ES256 on P-256 | Four mandates per sale, each independently signed |
| **Canonical bytes** | RFC 8785 (JCS subset), SHA-256 | So a hash link breaks on tampering, not on key order |
| **Store** | `better-sqlite3`, append-only | A mandate type is written once per transaction and never updated |
| **Server** | Express 5 + Socket.io 4 | Events fired from real state transitions |
| **Language** | TypeScript, run by `tsx` | No build step |
| **Frontend** | Hand-written HTML/CSS/JS | **No framework, no bundler** — three pages, one stylesheet |
| **QR decode** | `jsqr`, in the browser | The merchant's QR image never leaves their device |
| **WhatsApp** | `twilio` | The clarification question, and the sale confirmation |
| **Validation** | `zod` | Every model output is parsed before it is believed |

**The line if someone asks why no React:** *"Three pages and no build step. The
whole frontend is served as-is, so what you are looking at is the file on disk —
which is also why the CSS problems we hit were CSS problems and not toolchain
problems."*

## Where each thing earns its place

- **Deterministic beats the model wherever it can.** The negotiation engine, the
  authority gate, the analytics and the merchant router are all plain code. The
  model parses intent, phrases a haggle, and joins several findings into a
  sentence. That is the whole of its job.
- **The free tier forced good architecture.** 8,000 tokens a minute meant we
  could not route every question through a model, so we route deterministically
  first — which is faster, cheaper *and* more predictable than the alternative
  we would have built with more budget.
- **Nothing is mocked.** The one simulated component — a payment rail for CLI
  runs — is labelled `Gateway · Simulated` on every screen it touches.

---

# The three conversations with the most impact

If you only get to show three, show these, in this order:

| # | Say | Where | Why it lands |
|---|---|---|---|
| **1** | "what needs my attention" → "hand these over" | Sri Balaji | The answer carries the action; 71 signed handovers from one sentence |
| **2** | "why are my sales down" then "how did i do this month" | Sri Balaji | **−36% and +17%, both true.** It measures the window you asked about |
| **3** | "refund ₹2,400 to rahul" | Sri Balaji | An honest *I can't*, which is what makes every *I did* believable |

**Number 2 is the one.** Fifteen seconds, one shop, no switching — and if you
have a spare fifteen, follow it by asking the same question at Ganesh Tea &
Coffee, which is up 11%, and watch it decline to invent a decline.

---

# Questions you will get, and short answers

**"Is the data real?"**
> The six months of history is generated — those buyers never existed. Every
> order in it went through the production negotiation engine and is four signed
> mandates. Synthetic in who, real in how. The Razorpay orders are real test-mode
> orders.

**"What stops the AI hallucinating a price?"**
> Two things. The model never picks a number — the haggle is deterministic code.
> And every figure the assistant says is checked against the tool results behind
> it before the answer ships; an ungrounded number gets the answer replaced.

**"How is this different from a chatbot on a dashboard?"**
> A chatbot answers questions. This one holds session state, calls tools that
> read real rows, proposes actions that a person approves, and executes them
> idempotently. And most of what it does costs no model call at all.

**"Which Razorpay APIs are you actually using?"**
> Orders and Payments through the SDK — `orders.create`, `orders.fetch`,
> `payments.fetch`, `payments.capture`. Hosted Checkout. Both signature
> utilities, server-side, with the webhook one over raw bytes. Payment Links and
> Invoices over the REST v1 API. And a read-only probe of five products so we
> report what the account can actually do rather than claiming it. All test mode.

**"Why raw REST for links and invoices instead of the SDK?"**
> The SDK's coverage of the newer products lags the API. We would rather call the
> documented endpoint than trust a wrapper we cannot see.

**"Why not use an LLM for the analytics?"**
> Cost, latency and truth. Eleven thousand transactions is a database query, not
> a prompt. The model explains the result; it does not compute it.

**"What doesn't work?"**
> Refunds aren't built. There is no way to contact a buyer — an agent acts for
> someone the shop never meets. Smart Collect isn't enabled on our Razorpay
> account, and we show the status code rather than mocking it.

---

# Timing discipline

- **Section 4 will overrun.** It is the best material; let it, and cut section 3
  to the single `no_deal` command.
- **Do not read the tech stack as a list.** Name a technology when it explains
  something you have just shown, then move.
- **The pauses matter more than the words** — after `no_deal`, after "they
  aren't", and after `58/58`. Let each sit for two seconds.
