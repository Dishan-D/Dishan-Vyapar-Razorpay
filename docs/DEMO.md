# How to run and check the demo

Every number in this file was taken from the running system, not written from
memory. If something here does not reproduce, that is a bug worth reporting.

---

## Start it

```bash
node scripts/fetch-photos.mjs   # once — product photos for the storefront
npm run serve                   # http://localhost:3000
```

The photo step is one-off and idempotent. It pulls one keyword-matched
Creative Commons photo per product from loremflickr and saves it under
`data/sample_products/generic/`, so the demo never depends on someone else's
CDN being up mid-presentation. They are not committed to the repo, because
redistributing CC images without attribution is not ours to do — and they are
**illustrative**: a stock photo of a cake is not Sri Balaji Bakery's cake. The
merchant's catalog screen says so on every row, and a shopkeeper's own upload
replaces it immediately. Skip the step and every product falls back to a drawn
tile that claims nothing.

Two commands prove the system works without opening a browser:

```bash
npm run demo           # the seven-stage walkthrough, narrated
npx tsx scripts/audit.ts   # 60 claims re-derived from the running system
```

The audit is the one to run in front of a judge. It re-checks every headline
claim against live state and fuzzes the negotiation invariants over 500
randomised policies, so "the agent never pays above its ceiling" is a checked
statement rather than a confident one. Its last stage buys something and then
proves the shelf, the product's statistics and the shop's revenue all moved
together.

With the server already running, `npm run check:analytics` does the same six
checks in more detail against whatever state the database is in.

---

## The six shops

Small neighbourhood shops with a UPI QR and nothing else — the merchant this
product exists for. Each carries its own policy, and the Revenue Agent obeys it.

| Shop | Sells | Negotiates | Promotions |
|---|---|---|---|
| Sri Balaji Bakery | cakes, puffs, muffins | yes, to 8% | yes |
| New Krishna Sweets | cakes, sweets | yes, to 7% | **no** |
| Anand Bake House | premium cake, bread | **no** | no |
| Ganesh Tea & Coffee | coffee, buns, cookies | yes, to 6% | yes |
| Lakshmi Cloth Store | shirts, trousers, belts | yes, to 10% | yes |
| Deepa Home Needs | candles, diya sets, gift boxes | yes, to 9% | yes |

Three of them sell a chocolate cake at different prices, which is what makes
comparison and rejection demonstrable rather than asserted:

```
Sri Balaji Bakery    Chocolate Cake 500g          ₹450   floor ₹420   5 in stock
New Krishna Sweets   Chocolate Truffle Cake 500g  ₹490   floor ₹460   8 in stock
Anand Bake House     Premium Chocolate Cake 500g  ₹620   floor ₹590   3 in stock
```

Two products are deliberately **held** — the shopkeeper described them without
settling:

```
Fresh Fruit Pastry     price confidence 0.10 < 0.6   "price abhi decide nahi kiya"
Festive Gift Candle    stock confidence 0.15 < 0.6   "godown mein dekhna padega"
```

They stay out of every offer until a human confirms them. That is the
clarification loop, and it is the point — the system asks rather than guessing.

---

## The five demos

### 1 · Comparison, negotiation, and a refusal

**Storefront → ask:** *"a chocolate cake under ₹500"*

```
Sri Balaji Bakery    ₹423   eligible ✓     ← negotiated down from ₹450
New Krishna Sweets   —      ✗
Anand Bake House     —      ✗              floor ₹590 is above the ceiling
→ paid ₹423
```

Three shops asked, one deal. The agent never pays above the buyer's ceiling and
never below the merchant's floor, and both limits are enforced by the same call
that gates the payment.

```bash
curl -s -XPOST localhost:3000/agent/run -H 'content-type: application/json' \
  -d '{"goal":"a chocolate cake under ₹500","max_price":500,"opening_offer":400,"settle":"test_rail"}'
```

### 2 · Cross-sell — the Revenue Agent

**Buy the ₹450 cake with a ₹700 ceiling.** After the buyer confirms the cake,
the storefront offers:

```
Chocolate Cake 500g        ₹450
+ Birthday Candle Set       ₹30
+ Cupcake Box (6 pcs)      ₹180
  Total                    ₹660     ✓ within your ₹700 limit
        [ Confirm ₹660 ]   [ Keep it at ₹450 ]
```

Both buttons are equal. Nothing is added unless the buyer presses, and the rules
layer re-checks the new total either way.

```bash
curl -s -XPOST localhost:3000/revenue-agent/basket -H 'content-type: application/json' \
  -d '{"item_id":"itm_hazel_001","max_price":700}'
```

### 3 · Upsell that respects the ceiling

**Same cake, ceiling ₹800.** The shop has a ₹599 Red Velvet *and* a ₹760
Celebration Cake — both fit. It recommends the **₹599**:

```
Red Velvet Cake 1kg   ₹599
Serves 8-10 where Chocolate Cake 500g serves 4-6.
```

This is the one to point at. A ceiling is a limit, not a target, and an upsell
that cannot name its benefit is not offered at all.

### 4 · Dead stock — merchant side

**Merchant → Deep Insight → Grow.**

```
[100/100]  DEAD STOCK   +₹2,175    Butter Puff — 25 in stock, moving slowly
  ✓ Stock is sitting idle          25 on the shelf, against a shop median of 12
  ✓ Buyers have asked for it       19 recent searches matched breakfast, pastry, tea snack
  ✓ Merchant allows promotions     enabled, up to 8%
  ✓ Offer stays above your floor   ₹87 against your floor of ₹85
```

The offer lands at ₹87, not the ₹80 you might expect, because Sri Balaji's
policy caps discounts at 8% — ₹95 less 8% is ₹87.40. The agent obeyed the merchant. Every factor is a
sentence that can be checked, including any that fail.

### 5 · No deal — nothing moves

**Ceiling below every floor.**

```
status    no_deal
order_id  none
money     ₹0
```

No Razorpay order is created at all. This is the safety demo: the failure is
clean, and there is nothing to refund because nothing happened.

---

## Every number traces to an order

There is no revenue counter anywhere in this system, and no sales figure stored
next to a product. A statistic is recomputed from the signed chains each time it
is asked for, so a dashboard cannot quietly drift away from the transactions it
claims to summarise.

```bash
curl -s localhost:3000/merchants/mer_hazel/analytics          # revenue, orders, AOV, by day, by category
curl -s localhost:3000/merchants/mer_hazel/products/analytics # every product's own units and revenue
curl -s localhost:3000/products/itm_hazel_001/analytics       # one product, and the orders behind it
curl -s localhost:3000/analytics/transactions                 # the rows themselves, unaggregated
curl -s localhost:3000/analytics/integrity                    # does any of it contradict itself?
```

The last two are the point. Any figure on any screen can be checked against the
rows it came from without opening the database, and `integrity` re-checks that
line totals sum to their transaction, that no payment id appears on two sales,
and that no sale is credited to a shop that does not stock the product. `ok:
true` with an empty `faults` list is the healthy answer.

**Stock comes off the shelf when money is captured** — once, on the deduped
capture path, so a webhook and a browser callback for the same payment do not
take two units. Sell a product down to zero and the shop stops offering it:

```
sale 1 → paid, stock now 2
sale 2 → paid, stock now 1
sale 3 → paid, stock now 0
sale 4 → no_match          ← the shelf is empty, and it says so
```

Inventory never goes negative. If two sales ever race for the last unit that is
a real oversell for a human to sort out, and the log says so rather than the
catalog recording "−1 on the shelf".

**Why a sale happened is recorded when it happens.** A cross-sold packet of
candles and one the shopper asked for by name produce identical orders, so the
storefront states which it was at the moment the buyer agrees and the ledger
stores it verbatim. Working it out afterwards from product names would be a
guess dressed up as a statistic. The growth panel shows the split, and it shows
nothing at all when nothing has been taken up — a row of zeros beside a working
cross-sell panel reads as a broken panel.

One thing worth knowing when reading these screens: a cart mandate carries a
single item, so **one order is one product**. A basket bought in conversation
becomes several orders, each separately signed. "Orders containing this product"
therefore counts chains, and for this schema it equals units sold.

---

## Real Razorpay, in test mode

```bash
curl -s -XPOST localhost:3000/agent/run -H 'content-type: application/json' \
  -d '{"goal":"a chocolate cake under ₹500","max_price":500,"opening_offer":400,"settle":"checkout"}'
```

Returns a genuine order — `order_TWrGatHK1MTst4` — created against Razorpay's
API. To see that it exists somewhere other than our own database:

```bash
curl -s localhost:3000/transactions/<txn>/gateway-status
```

That fetches the order back from Razorpay and prints both sides. Our record and
theirs, including when they disagree.

**Capability is probed, never claimed.** `GET /razorpay/capabilities` makes five
read-only calls against the account:

```
✅ Payments        Orders + Checkout, the primary path
✅ Payment Links   GET /payment_links → 200
✅ Invoices        GET /invoices → 200
✅ Settlements     GET /settlements → 200
✅ QR Codes        GET /payments/qr_codes → 200
⛔ Smart Collect   GET /virtual_accounts → 400, not enabled on this account
```

The unavailable product shows the call and the status code that proved it, and
says whose problem it is: Razorpay refuses a product an account has not
activated with `400 "The requested URL was not found on the server"`, while a
genuinely wrong path is refused by the gateway with `404 "no Route matched"`.
Smart Collect is an opt-in product — the integration is correct and the account
has not enabled it. It is not on the purchase path; Orders and Checkout are.

Mocking them would have been easy and would have been the one thing this project
cannot afford.

---

## Adding a product to a shop

**Merchant → Catalog → + Add a product.** Photo, name, price, stock.

What you type is what an AI buyer sees: merchant-stated, confidence 1, no
clarification queued. An unpriced row stays off sale until a price is set —
the merchant's choice, not a doubt about them. It is immediately buyable:

```bash
curl -s -XPOST localhost:3000/onboarding/merchants/mer_hazel/items \
  -F 'items=[{"name":"Rusk Packet","price":45,"stock":30,"category":"food.snack"}]'
```

---

## Onboarding a shop from scratch

**/onboard.html**, three steps. Step 2 takes four kinds of input:

- **Photos** — read by a vision model, with OCR reading any printed price tag
- **Voice** — recorded and transcribed, shown for correction before it counts
- **Text** — a sentence
- **One by one** — a row per product with its own photo, no extraction at all

The last one exists because nothing reliably ties a photo to a product: a shelf
photo may hold six, two photos may show one. For the five items a merchant
actually cares about, typing them is exact — and it works when the vision quota
is spent.

---

## What is real and what is not

| | |
|---|---|
| Razorpay Orders, Checkout, signature and webhook verification | **real**, test mode |
| Payment Links, Invoices | **real**, verified against the account |
| The mandate chain, signatures, hashes | **real** ES256, re-verified at read time |
| Negotiation, ceilings, floors, stock, categories | **real**, deterministic, no model |
| Revenue Agent scoring | **real** arithmetic over stored state |
| Merchant and product statistics, stock counts | **real**, recomputed from signed chains on every read |
| The `sim_` rail | simulated, and labelled `Gateway · Simulated` |
| The UPI settlement feed | generated, and every screen says so |
| Seeded buyer demand | generated — but outcomes are played by the live engine |

Nothing is presented as measured when it is modelled. Anything estimated carries
the word **estimate** on screen.

---

## Presenting it

`docs/DEMO_10MIN.md` is the run sheet — the prompts in order, what each one
proves, and what to do when the language model is rate-limited mid-demo. Run
`npm run demo:reset` before each rehearsal: stock is real now, so buying the
same cake six times genuinely sells it out.

---

## If something does not work

- **`EADDRINUSE :::3000`** — a server is already running. `lsof -ti:3000 | xargs kill -9`
- **Photo onboarding returns 429** — the vision model's daily token allowance is
  spent. Your photos are saved; press Try again after it resets, or use the
  **One by one** tab, which needs no model.
- **The assistant says it could not reach the model** — the per-minute token
  budget. Wait about a minute. Everything deterministic still works.
- **Empty dashboards** — the database is fresh. Run `npm run demo` once, or send
  a buyer agent from the storefront, and the merchant screens fill up.
