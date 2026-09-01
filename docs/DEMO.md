# How to run and check the demo

Every number in this file was taken from the running system, not written from
memory. If something here does not reproduce, that is a bug worth reporting.

---

## Start it

```bash
npm run serve          # http://localhost:3000
```

Two commands prove the system works without opening a browser:

```bash
npm run demo           # the seven-stage walkthrough, narrated
npx tsx scripts/audit.ts   # 29 claims re-derived from the running system
```

The audit is the one to run in front of a judge. It re-checks every headline
claim against live state and fuzzes the negotiation invariants over 500
randomised policies, so "the agent never pays above its ceiling" is a checked
statement rather than a confident one.

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

**Same cake, ceiling ₹800.** The shop has a ₹620 Red Velvet *and* a ₹760
Celebration Cake — both fit. It recommends the **₹620**:

```
Red Velvet Cake 1kg   ₹620
Serves 8-10 where Chocolate Cake 500g serves 4-6.
```

This is the one to point at. A ceiling is a limit, not a target, and an upsell
that cannot name its benefit is not offered at all.

### 4 · Dead stock — merchant side

**Merchant → Deep Insight → Grow.**

```
[100/100]  DEAD STOCK   +₹1,992    Blueberry Muffin — 24 in stock, moving slowly
  ✓ Stock is sitting idle          24 on the shelf, flagged slow-moving
  ✓ Buyers have asked for it       recent searches matched breakfast, tea snack
  ✓ Merchant allows promotions     enabled, up to 8%
  ✓ Offer stays above your floor   ₹83 against your floor of ₹72
```

The offer lands at ₹83, not the ₹75 you might expect, because Sri Balaji's
policy caps discounts at 8%. The agent obeyed the merchant. Every factor is a
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
⛔ QR Codes        GET /payments/qr_codes → 400, not enabled on this account
⛔ Smart Collect   GET /virtual_accounts → 400, not enabled
```

The two unavailable products show the call and the status code that proved it.
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
| The `sim_` rail | simulated, and labelled `Gateway · Simulated` |
| The UPI settlement feed | generated, and every screen says so |
| Seeded buyer demand | generated — but outcomes are played by the live engine |

Nothing is presented as measured when it is modelled. Anything estimated carries
the word **estimate** on screen.

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
