# The merchant side, in full

One page — `frontend/merchant.html` — with two modes over one set of data.
Everything below was read off the current file and the running server.

**The rule the whole page obeys:** the dashboard holds no state of its own. Every
figure is fetched, every action goes to the server, and a change arrives back as
an event. There is no client-side copy of anything to fall out of step.

---

# The frame — always visible

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Good evening, Sri Balaji Bakery          [💬 Simple] [📊 Insights]  ▾   │
│  1 thing needs your attention                        Sri Balaji · Bengaluru│
└──────────────────────────────────────────────────────────────────────────┘
```

| Element | Id | Where it comes from |
|---|---|---|
| Greeting | `#greeting` | time of day + the selected shop's name |
| Attention line | `#attention` | `GET /merchants/:id/alerts` → `needs_attention` |
| Mode switch | `#modes` | local; the choice is remembered in `localStorage` |
| Shop selector | `#pick` | `GET /merchants` |

**Switching shops re-runs everything.** Switching *modes* does not — both modes
read the same loaded state, so the toggle is instant and a conversation in
progress survives it.

---

# SIMPLE MODE — the assistant is the screen

`#simplewrap` → `#assistant`. One centred column, max 720px, on a soft mesh
ground. **Not a dashboard with a chat box** — there are no panels here at all.

## The empty state

```
                        Good evening 👋
              What can I help you with today?
                 Your shop, in plain language.

        ┌────────────────────────────────────────────┐
        │  One thing worth knowing.                  │   ← #proactive
        │  1 thing needs you — ask me "what needs    │      (only when true)
        │  my attention?" and I'll go through them.  │
        └────────────────────────────────────────────┘

        ┌────────────────────────────────────────────┐
        │  Ask me anything about your shop…          │   ← #say
        │                                            │
        │  🎙  📎                              ➤     │   ← #mic #upfile #send
        └────────────────────────────────────────────┘
         Type, talk, or send a photo of your UPI QR

        (How did I do today?) (Who hasn't paid me?)      ← #chips
        (What needs my attention?) (Best customers?)

        ┌────────────────────────────────────────────┐
        │      How do your customers pay you?        │   ← #qrcard
        │           ▦  Drop your QR here             │
        └────────────────────────────────────────────┘
```

**The greeting and composer are centred together** (`.assistant.empty`). They
used to be pinned to opposite ends of a full-height column, which left a screen
of blank between a question and the box for answering it.

**The chips are built from what is true right now** — `GET /merchants/:id/agent/openers`
reads the shop's unpaid orders, waiting handovers, held products and
opportunities, and only offers the questions that have an answer. A shop with
nothing unpaid is never offered *"who hasn't paid me?"*.

**The QR card is an opening move, not furniture.** It disappears the moment a
conversation starts.

## What happens when you ask

```
   type / speak / drop a file
            │
            ▼
   POST /merchants/:id/agent   { conversation_id, message }
            │
   ┌────────┴─────────┐
   │  route(message)  │  deterministic — no model
   └────────┬─────────┘
            │
   ┌────────┼─────────────────────┬──────────────────┐
   ▼        ▼                     ▼                  ▼
 direct   reason                 act              unheld
 1 lookup  2–3 lookups        resolve, then      say what it
 template  + model phrasing    propose           cannot do
            │
            ▼
   { answer, activity[], cards[], actions[], answered_by, elapsed_ms }
```

The reply is rendered in four layers, in this order:

**1 · Activity** — one line per lookup that really ran, ticked as it landed,
tagged with the specialist domain.

```
✓ Looking for what is holding sales back      SALES
✓ Checking who walked away                    GROWTH
✓ Ranking products by what they earned        SALES
```

*Not a spinner.* Each line is a lookup the server actually performed.

**2 · The sentence** — `.said`. Two or three lines, plain language, rupees as
₹1,200.

**3 · Cards** — the interface renders these rather than parsing the sentence.
Four kinds:

| Kind | Looks like | Used for |
|---|---|---|
| `stat` | a big number, a subtitle, a ↑/↓ delta, optional rows | today, sales, reconciliation, payment setup |
| `table` | scrolling columns + a footer line | customers, products, orders, lapsed buyers |
| `reasons` | coloured dots against sentences | what is holding sales back |
| `opportunities` | headline, kind, and what it is worth | the Revenue Agent's suggestions |

**4 · Actions** — a bordered blue panel, and the only thing on this page that
changes the shop:

```
┌──────────────────────────────────────────────────────────┐
│ Mark all 71 paid orders — ₹16,305 — as handed to buyers   │
│                    [ Yes, do it ]        [ No ]           │
└──────────────────────────────────────────────────────────┘
```

Press → `POST /merchants/:id/actions/:actionId/confirm`. The row shows
**Working…**, then the server's own words. Never optimistic: it does not say
done until the server has said so, and a failure returns 409 and shows red.

**Idempotent by action id** — a second press returns *"Already done."* rather
than doing it again.

## The three input paths

| Path | How | Notes |
|---|---|---|
| **Type** | `#say`, Enter to send, Shift+Enter for a newline | grows with the text to 150px |
| **Speak** | `#mic` → browser Web Speech API (`en-IN`) | no service to configure; if the answer came from voice it is **read back aloud** |
| **Upload** | `#qrdrop` (drag or click) or `#upfile` 📎 | one handler for both, so they cannot behave differently |

**The QR flow, in full:**

```
image → createImageBitmap → canvas → jsQR (loaded lazily, served locally)
                                        │  decoded in the browser;
                                        │  the image never leaves the device
                                        ▼
POST /merchants/:id/upi-qr { decoded }  → parse & validate the upi:// URI
                                        ▼
"I found your payment details — ABC Stores, paying to merchant@upi. Is that right?"
                       [ Yes, save it ]  [ No ]
```

A QR that scans but is not a UPI code gets a different message from a blurry
photo, because the merchant fixes those differently. A fixed-amount QR is
accepted with a warning that the amount is ignored.

---

# INSIGHTS MODE — six screens

`#deepwrap`: a left sidebar (`#secnav`) and one visible pane. The chosen screen
is remembered per shop.

```
┌──────────┬──────────────────────────────────────────────────────┐
│ ⬤ Today  │                                                      │
│ ▦ Catalog│              the selected pane                        │
│ ₹ Money  │              (2-column grid, 1 on mobile)            │
│ ↗ Grow   │                                                      │
│ ✓ Trust  │                                                      │
│ ✧ Assistant                                                     │
└──────────┴──────────────────────────────────────────────────────┘
```

## 1 · Today

**Your business today** — the headline row, full width.

```
Sales ₹31,599   Orders 120   Buyers 42   Average ₹263   Came back 48%
  ↗ 105% vs…      ↗ 12%        ↘ 4%        ↗ 3%           ↗ 8%
```

Read from `GET /merchants/:id/trend?period=week` and `/customers` — **the same
two endpoints the assistant calls.** Two sources for one number eventually
disagree, and the one that is wrong is whichever the merchant is looking at.

**"I noticed something"** — the largest *measured* contributor:

> ✦ **Takings are down 36% over the last 7 days.**
> The biggest change is Chocolate Cake 500g — ₹840 against ₹6,317.
> **[ Ask why ] [ See who stopped ]**

Both buttons hand the question to the assistant and switch to Simple mode. The
panel **hides itself** when nothing moved enough to register, and when there is
no previous period it says so rather than inventing a comparison.

**The chart** — a 14- or 30-day sparkline; hovering a bar gives that day's
takings and order count.

**Needs your attention** — the clarification queue. A held product asks a
specific question with tappable options; the reply resolves it and the product
goes live.

**Orders** — every order with its state, and a *Confirm handover* button on the
paid-but-undelivered ones.

## 2 · Catalog

Each row: photo · name + provenance · price · stock · state · save/delete.

```
[img] Chocolate Cake 500g          ₹450   5    ● Live    [Save] [Delete]
      ● merchant                                                          
      23 sold · ₹9,756 · avg ₹424 · 2 cross-sell
```

- **Provenance** on every row — model, rules, or the merchant typing it.
- **The sales line** comes from `/products/analytics`, so it is read from the
  ledger rather than kept beside the product. `not sold yet` where that is true,
  never `₹0`.
- **Photo saves on pick**, not on Save — it is the one field where the merchant
  can see immediately whether they got it right.
- **Deleting is refused** while a live transaction names the product.
- **+ Add a product** — what they type is merchant-stated, confidence 1, no
  clarification queued.

Below: **This shop is machine-readable** — the before/after field count.

## 3 · Money

- **Razorpay infrastructure** — five read-only probes made when the page loads.
  Anything unavailable shows the call and the status code that proved it.
- **Money in, matched to what you sold** — the UPI reconciliation. A fixed
  summary (banked / explained / unexplained + a bar), then a header stating the
  count and a **filter**: `[All 150] [5 need a look]`. The feed itself scrolls
  inside a fixed frame and keeps its own order — a statement whose rows move
  around stops being a statement.
- **Verified Commerce History** — the signed trading record, with its hash and
  an explicit list of what it does *not* claim.

## 4 · Grow

- **Today's opportunity** — the Revenue Agent's top pick with every score factor
  as a checkable sentence, including the ones that fail.
- **Grow revenue** — lost demand as approvable cards: headline, evidence, the
  advice, the price change, `[Approve] [Not now]`.
- **Revenue recovery** — buyers who walked, and what would bring them back.
- **What a different price floor would have earned** — real buyers replayed
  through the production negotiation engine at each price. Not a forecast.
- **What changed for this shop** + **Where buyers stopped** — before/after and
  the funnel.

## 5 · Trust

Agent Readiness with its components, the Commerce Trust Passport, and system
performance.

## 6 · Assistant

The AI Commerce Twin — what an agent sees of this shop, and a policy editor in
plain English (*"never go below 400 on cakes"*) that shows the parsed change for
approval before applying it.

Plus **Live activity** — the last 40 events as they happen.

---

# How data moves

## On load

```
boot() → socket connects, joins the merchant's room
       → refresh() runs 16 loaders in parallel
       → settleScrollboxes() measures which panels actually overflow
```

## On an event

The server emits from **real state transitions** — where it already writes to
SQLite, never from display code. The page reacts selectively:

| Event | What reloads |
|---|---|
| `clarification.*` | everything (`refresh()`) |
| `payment.captured` · `fulfillment.confirmed` | score, history, trust, orders, recovery, reconciliation |
| `negotiation.*` · `discovery.queried` | opportunities, recovery, performance, growth, curves |
| *any* | the Simple-mode greeting and openers |

## On an action

```
press → POST .../actions/:id/confirm → server executes once
      → row shows the server's message
      → refresh() → every panel re-reads
```

**Nothing is drawn from an optimistic local update.** The panel changes because
the server changed, not because a button was pressed.

---

# The rules this page is built on

1. **The dashboard holds no state.** Every number is fetched. There is no client
   copy to drift.
2. **One source per figure.** Simple and Insights read the same endpoints. A
   number cannot differ between modes.
3. **Nothing changes without a press.** Every write is proposed. Every proposal
   is idempotent.
4. **A failure is never a success.** 409 and the real reason, never a green tick.
5. **Silence is a valid output.** The insight panel, the proactive note and the
   opportunity list all hide when there is nothing true to say.
6. **Panels are framed, not endless.** Anything transaction-fed scrolls inside a
   fixed height and states its own contents above the frame.
7. **Provenance is visible.** Where a value came from — model, rules, or the
   merchant — is on the row.

---

# Files

| File | What |
|---|---|
| `frontend/merchant.html` | the whole page: markup, styles, module |
| `frontend/app.css` | the shared design system |
| `frontend/ui.js` | `api()`, `boot()`, formatting, `settleScrollboxes()` |
| `src/agent/supervisor.ts` | routing — question → lookups, no model |
| `src/agent/merchant-tools.ts` | the tool registry: domain, writes, confirm |
| `src/merchant/actions.ts` | the idempotent action ledger |
| `src/merchant/upi-qr.ts` | parsing and validating a decoded QR |
| `src/analytics/ledger.ts` | every merchant and product figure |
| `src/server.ts` | the endpoints, the tool executor, `performAction` |

---

# Endpoints, and who reads them

Every one verified responding. **Bold** means both modes read it — those are the
figures that cannot differ between screens.

| Endpoint | Simple | Insights |
|---|---|---|
| **`/merchants/:id/trend`** | `diagnose_sales`, the *why* answer | the KPI row, "I noticed something" |
| **`/merchants/:id/customers`** | `get_customers`, `get_lapsed_customers` | the KPI row |
| **`/merchants/:id/analytics`** | `get_sales`, `get_today` | the chart |
| **`/merchants/:id/orders`** | `get_orders`, handover resolution | Today → Orders |
| **`/merchants/:id/products/analytics`** | `get_product_performance` | Catalog → the sales line |
| **`/merchants/:id/alerts`** | the proactive note | Today → Needs your attention |
| **`/merchants/:id/revenue-agent`** | `get_opportunities` | Grow → Today's opportunity |
| **`/merchants/:id/reconciliation`** | `get_reconciliation` | Money |
| `/merchants/:id/agent` | every turn | — |
| `/merchants/:id/agent/openers` | the chips | — |
| `/merchants/:id/actions/:id/confirm` | every action | — |
| `/merchants/:id/upi-qr` | the QR flow | — |
| `/merchants/:id/patterns` | `get_patterns` | — *(assistant only)* |
| `/merchants/:id/recovery` | `get_lost_sales` | Grow → Revenue recovery |
| `/merchants/:id/opportunities` | — | Grow → Grow revenue |
| `/merchants/:id/price-curve` | — | Grow → price floors |
| `/merchants/:id/growth` | — | Grow → what changed |
| `/merchants/:id/readiness` · `/trust` | — | Trust |
| `/merchants/:id/commerce-history` | — | Money |
| `/merchants/:id/twin` | — | Assistant |
| `/razorpay/capabilities` | — | Money |
| `/clarifications` | — | Today → Needs your attention |

---

**The buyer side is `docs/BUYER_UI.md`** — the storefront, the agent rail,
and the run.
