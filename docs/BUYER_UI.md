# The buyer side, in full

One page — `frontend/store.html` — a storefront with an agent rail down the
right. Read off the current file and the running server.

**The rule this page obeys:** *the agent does not get a private view.* It marks
up the same grid a person browses. A separate "agent view" would have been
easier to build and would have proved nothing — the whole point is that its
reasoning is checkable without reading a log.

---

# The frame

```
┌────────────────────────────────────────────────────────────────────────────┐
│ VYAPAR MARKET — every shop here took UPI and nothing else                   │
│                    [ Search the shelf… ]  ✓Gateway·Razorpay·Checkout  Cart 0│
├────────────────────────────────────────────────────────────────────────────┤
│ ( All )( Food )( Apparel )( Home )( Mobile )                    ← #pills    │
└────────────────────────────────────────────────────────────────────────────┘
```

| Element | Id | Source |
|---|---|---|
| Search | `#q` | filters `items` locally — no round trip |
| Gateway chip | `#mode` | `GET /config` — says which rail this session uses |
| Cart count | `#cartn` | `GET /cart?session_id=…` — **server-side** |
| Category pills | `#pills` | derived from the catalog |

**The gateway chip is not decoration.** It says `Razorpay · Checkout` or
`Simulated`, so nobody is ever unsure which rail a payment ran on.

---

# The layout

```
┌───────────────────────────────────────┬──────────────────────────┐
│  12 products across 6 shops · 10 an    │  AI BUYER        ● idle  │
│  agent can buy right now      ← #count │ ┌──────────────────────┐ │
│                                        │ │                      │ │
│  ┌────────┐ ┌────────┐ ┌────────┐      │ │   the trail          │ │
│  │  card  │ │  card  │ │  card  │      │ │   #rb                │ │
│  └────────┘ └────────┘ └────────┘      │ │                      │ │
│              #grid                     │ └──────────────────────┘ │
│                                        │  (i want a saree)        │
│  ── Cart ──────────────  #cartsec      │  (phone cover ₹250)      │
│  ── Your orders ───────  #orders       │  [ Tell it what… ][Send] │
│                                        │  ☐ Let the agent pay     │
└───────────────────────────────────────┴──────────────────────────┘
```

---

# The product card

**The same object whether a person or an agent is looking at it.**

```
┌─────────────────────┐
│      [ photo ]      │
│ Chocolate Cake 500g │
│ Sri Balaji · Bengaluru
│ ₹450                │
│ ✓agent-ready  5 in stock
│ [   Add to cart   ] │
│ Pick this one →     │  ← only while the agent has narrowed the shelf
│ ─────────────────── │
│ agentnote (hidden)  │  ← filled during a run
└─────────────────────┘
```

Five states, all applied to this one card:

| Class | Means | When |
|---|---|---|
| — | normal | browsing |
| `.dim` | not being considered | at the start of a run |
| `.looked` | mentioned, or offered a price | the agent named it |
| `.passed` | rejected, **with the reason on its face** | a shop would not agree |
| `.chosen` | bought | and it scrolls into view |
| `.pickable` | clickable | while a filter is up |

A product the shopkeeper has not confirmed shows `awaiting shopkeeper` and has
**no Add to cart at all** — it cannot be bought, so it is not offered.

---

# THE AGENT RAIL

## Asking

```
type / press a chip
        │
        ▼
POST /agent/assist  { session_id, messages[] }
        │
   the buyer agent: 12 tools, server-side session state
        │
        ▼
{ answer, steps[], proposals[] }
```

The rail renders three things:

**1 · The lookups it ran** — `search_shelf`, `compare_products`,
`find_alternatives`, `view_cart`… shown *before* the answer.

> An assistant that produced the same sentence without looking reads identically
> on screen. That is exactly why the trail is visible.

**2 · The answer**, and then two side effects on the shelf:

- **`showOnShelf`** — a `search_shelf` result *filters* the grid rather than
  re-rendering it, so the cards keep their own Add and Pick controls. The count
  line changes to *"Showing the 6 the agent found · Click any one to pick it"*
  with a way back.
- **`highlightMentioned`** — rings the products the answer actually named.

**How the highlight decides.** It matches on **price**, not name — every
significant word of "Chocolate Cake 500g" also appears in "500g Chocolate
Truffle Cake". First it strips the figures that name nothing:

```
"6 cakes under ₹800, ranging ₹450–₹750 … ₹450 … (₹599) or (₹750)"
   ceiling ─┘        range ─┘                    → names [450, 599, 750]
```

`under`, `up to`, `within`, `at most` are ceilings; `₹450–₹750` and `₹450 to
₹750` are spans. Neither names a product. **Emphasis is added, never
subtracted** — a ring on what was named, nothing done to the rest, because
dimming reads as *unavailable*.

**3 · Proposals** — the only route to spending money:

```
┌────────────────────────────────────────────────────────┐
│ Buy Chocolate Cake 500g from Sri Balaji, up to ₹450     │
│                     [ Confirm ]        [ No ]           │
└────────────────────────────────────────────────────────┘
```

Typing "confirm" does the same thing as pressing it — the shopper had no way to
know the word was addressed to a model that cannot act on it.

## Picking by pointing

While the shelf is filtered, **clicking a card is the reply**:

```
click → pickFromShelf(item)
      → "I'll take the Chocolate Cake 500g from Sri Balaji at ₹450."  ← into the transcript
      → the card rings, scrolls into view
      → a proposal, built from the card's own data
```

**No model call.** The card already knows the id, the shop and the price, so a
round trip could only add a mistake and a token bill. It is also the one action
that should never fail because a language model is busy — which makes it the
fallback when the assistant is rate-limited.

The ceiling is the **shelf price**: the shopper chose the thing at the price
shown, so the agent may go below it and never above.

---

# THE RUN — what happens on Confirm

```
Confirm
   │
   ├─→ offerBasket(prop)   ← the shop's chance to suggest more
   │      POST /revenue-agent/basket
   │      ┌──────────────────────────────────────┐
   │      │ Complete your order?                 │
   │      │  Chocolate Cake 500g          ₹450   │
   │      │ +Birthday Candle Set           ₹30   │
   │      │ +Cupcake Box (6 pcs)          ₹180   │
   │      │  Total                        ₹660   │
   │      │  ✓ Within your ₹700 limit            │
   │      │ [Confirm ₹660] [Switch] [Keep ₹450]  │
   │      └──────────────────────────────────────┘
   │      Both buttons are equal. Nothing is added without a press.
   │
   ▼
run(goal, item_id, attribution)
   POST /agent/run { goal, item_id, settle, run_id, attribution }
```

**`item_id` pins the run to the exact product picked.** Without it the run
re-searches the whole catalog by goal *text* — which usually bought the right
thing, by luck, with no way to tell the times it did not.

**`attribution` is why the sale happened** — `organic` for the anchor,
`cross_sell` for each addition, `upsell` for a switch. Only this page knows it,
and it can never be recovered afterwards: a cross-sold packet of candles and one
asked for by name produce identical orders.

## Watching it run

`resetShelf(true)` dims everything, then `agent.step` events arrive over
Socket.io and paint the grid live:

```
◆  Buyer agent started                           chocolate cake 500g under ₹450
·  Reading what you asked for…                   decided by rules
·  Read that as: chocolate cake 500g, ceiling ₹450   decided by model   ← the only model line
🔎 Checking 11 shops…                            decided by rules
🏪 Checked 11 shops; 1 stock it                  decided by rules
·  Chose Sri Balaji Bakery at ₹422               decided by rules
·  Intent and cart mandates signed               decided by rules
🔐 Purchase authorized                           decided by rules
₹  Paid ₹422                                     decided by rules
■  Paid, not delivered                           decided by rules
```

Nine stages, captured from a live run. Each carries `stage`, `headline`,
`decided_by` and `elapsed_ms`.

**Two of them are the argument.** `sign` is where the four mandates are minted;
`wait` is the page refusing to call a paid order delivered. And exactly one line
in the whole run says **decided by model** — the sentence-to-intent parse.
Everything that touches a number says *rules*.

Simultaneously on the shelf:

- eligible shops → `.looked` + *"Offered ₹422 after 2 round(s)"*
- rejected shops → `.passed` + **the reason on the card**
- the winner → `.chosen`, scrolled into view

**`decided by rules` vs `decided by model` is on every line.** That is the
project's central claim, rendered rather than asserted.

## Where it can end

| Outcome | What the shopper sees |
|---|---|
| `no_match` | *"Nothing on the shelf matches"* + why |
| `no_deal` | *"No deal"* + which shops refused. **No Razorpay order was created.** |
| refused (402) | the authority gate's own reasons |
| `paid` | the payment panel |

---

# PAYING

The choice is made before the run by one checkbox:

```
☐ Let the agent pay by itself
  Off: it stops at the order and hands you Razorpay Checkout.
  On:  it settles on the simulated rail so the run finishes unattended
       — those ids are not Razorpay's.
```

```js
settle = config.gateway === "razorpay" && !autopay ? "checkout" : "test_rail"
```

No Razorpay keys means there is no Checkout to open, so the rail is the only
thing that can finish a run rather than stranding the shopper at a dead end.

## The Checkout path

```
run returns { order_id, amount_paise }
        │
   offerPayment(r) draws the panel
        │
   press Pay → checkout(r, box)
        │
   window.Razorpay(...)  ← checkout.razorpay.com/v1/checkout.js
        │
   handler → POST /transactions/:id/settle-payment
             { razorpay_order_id, razorpay_payment_id, razorpay_signature }
        │
   server verifies the signature, appends the payment mandate
        │
   markPaid() → the panel turns green
```

**The 409 that used to look like a failure.** The webhook and the browser
callback both land, and whichever arrives second gets *"already paid"*. The page
no longer treats that as an error — it asks the server what the order actually
is, and reports that.

**"Check with the gateway"** on any order calls
`GET /transactions/:id/gateway-status`, which fetches the order back **from
Razorpay** and prints both answers — ours and theirs, including when they
disagree.

---

# THE CART

Server-side, keyed by a `SESSION` id, because *"added to your cart"* while the
cart is a variable in someone else's browser is describing something that did
not happen.

```
GET  /cart?session_id=…    POST /cart/add    /cart/remove    /cart/qty
```

Each line carries a **ceiling the shopper sets**, defaulting to the shelf price:

```
[img] Chocolate Cake 500g     qty [1]   willing to pay [₹450]   ×
```

**"Send the agent to buy these"** runs each line as its own run — its own
negotiation, order and signed chain — because **a cart mandate holds one item**.
The rules layer checks every one against its own ceiling.

---

# YOUR ORDERS

Fixed-height, and it states its own contents above the frame:

```
175 ORDERS · 5 AWAITING HANDOVER · 23 NOT PAID
┌──────────────────────────────────────────────────────────────┐
│ [img] Chocolate Cake 500g          ₹422   PAID·AWAITING HANDOVER
│       Sri Balaji · sim_pay_0001                               │
│ [img] Birthday Candle Set           ₹30   ● DELIVERED         │
│       Sri Balaji · handed over 02:59                          │
└──────────────────────────────────────────────────────────────┘
```

Click a row to expand: transaction id, ordered at, payment id, handover time,
and **Check with the gateway**.

**Status changes when the shop acts, never on its own.** `fulfillment.confirmed`
arrives over Socket.io and the row flips to DELIVERED with a `.justin` highlight
— no reload. That live update is the single clearest demonstration that the two
sides are one system.

---

# How data moves

## On load

```
boot() → socket connects
GET /config    → the gateway chip
GET /catalog   → items
GET /merchants → shop names
GET /cart      → the cart
GET /orders    → the order list
GET /agent/openers → the example chips, from this marketplace's own stock
```

## On an event

| Event | Effect |
|---|---|
| `agent.step` (matching `run_id`) | a trail row, and the shelf is marked |
| `payment.captured` | the payment panel goes green |
| `fulfillment.confirmed` | the order row flips to DELIVERED |

## The guards behind the answers

Every assistant reply passes five checks before it reaches the shopper. Each was
written against a real observed failure:

| Guard | Catches |
|---|---|
| `ungroundedFigures` | a rupee figure no lookup returned |
| `claimsPurchaseDone` | *"your order is confirmed"* with zero orders |
| `pointsAtButton` | *"tap the Pay ₹80 button"* when no button was rendered |
| `misattributedPrice` | a price pinned to the wrong product |
| `fromRowsOnly` | builds the replacement answer from tool rows only |

A failed check **replaces** the answer and attaches a note saying what was
replaced.

---

# The rules this page is built on

1. **The agent marks up the shelf a person browses.** No private view.
2. **Every answer shows its lookups.** An answer with no lookups is visibly one
   with no evidence.
3. **Nothing is bought without a press.** A proposal is a sentence to agree to.
4. **Emphasis is added, never subtracted.** Dimming reads as unavailable.
5. **The cart lives on the server.** So *"added"* is true.
6. **One order is one product.** A basket is N separately-signed chains.
7. **Which rail ran is always on screen.** Simulated ids say so.
8. **Paid is not delivered.** Only the shopkeeper's signature changes that.

---

# Files

| File | What |
|---|---|
| `frontend/store.html` | the page: markup, styles, module |
| `src/agent/buyerloop.ts` | the loop, the five guards, the fallbacks |
| `src/agent/buyer.ts` | the 12 tool definitions |
| `src/agent/shopping.ts` | session state, `resolveProduct`, ranking |
| `src/catalog/discovery.ts` | matching, withholding, ranking |
| `src/marketplace/compare.ts` | multi-shop comparison |
| `src/negotiation/engine.ts` | the bounded haggle |
| `src/mandates/authority.ts` | **the one gate that moves money** |
| `src/payments/gateway.ts` | Razorpay + the simulated rail |
| `src/revenue/agent.ts` | the cross-sell and upsell offers |

---

**The merchant side is `docs/MERCHANT_UI.md`** — the assistant, the six
Insights screens, and how an action lands.
