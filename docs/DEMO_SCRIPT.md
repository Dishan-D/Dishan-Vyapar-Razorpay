# What every screen means, and how to demo it

Companion to [PRESENTATION_GUIDE.md](../PRESENTATION_GUIDE.md), which covers the
pitch. This one covers the software: what each surface is showing, why it is
there, and the order to walk them in on camera.

```bash
npm run serve          # http://localhost:3000
```

Four pages, linked from the nav in the header. They all read the same server and
the same live event bus.

---

## The header, on every page

| Element | Means |
|---|---|
| `catalog: fixtures` | Extraction confidence came from hand-authored stand-ins. Reads `extracted live` once you run `npm run milestone-b -- --live`. |
| `gateway: razorpay · Checkout` | Real Razorpay test-mode keys are loaded. Reads `simulated` without them, and IDs are then prefixed `sim_`. |
| `live` (green) | Socket.io is connected. Everything on the page updates without a refresh. |

Worth pointing at once, early: the badges are the honesty layer. They say which
parts are real *right now*, on this run.

---

## 1 · `/` — The shop

**What it is:** one buyer-agent transacting with one shop, start to finish. The
walkthrough page.

### Left column

**The shops.** Three merchants, their items grouped under each. Every card is one
product built from a photo and a Hinglish voice note.

- **The photo** is the merchant's own phone picture — the actual input to Stage 1,
  not a stock image. Two of the three merchants have no photos at all, which is
  the realistic case: most send a voice note and nothing else.
- **The confidence chips** (`✓ price 0.94`, `✕ price 0.00`) are what the model
  said about its own reading, per field.
- **Greyed cards can't be bought.** The red strip says exactly why. Clicking one
  is refused with the reason — that *is* the held-item scenario, no separate
  button needed.
- **The readiness chip** beside each shop name is Milestone J's score. It changes
  as items resolve and sales complete.

**What the buyer-agent may do.** The ceiling and opening offer that get signed
into the Intent Mandate. Three presets: *Fair buyer*, *Can't afford it* (forces a
no-deal), *Generous buyer*.

### Right column — the transaction

Four steps that fill in as they happen. Dim until reached, then a green ✓ or a
red ✕.

1. **Discover & negotiate** — every offer and counter-offer. **The grey line under
   each turn is the point of the whole project**: it names the rule that produced
   that number. "Half the gap between ₹1200 and the ₹1050 floor."
2. **Pay** — the real Razorpay `order_...`, then Checkout, then `pay_...`.
3. **Shopkeeper confirms handover** — the button only appears after payment, and
   until it is pressed the transaction reads *paid but not delivered*.
4. **Signed audit chain** — four mandates, four hashes, who signed each.

---

## 2 · `/merchant.html` — The merchant's own view

**What it is:** what a shopkeeper sees. Pick the shop from the dropdown in the
header.

**Questions waiting on you.** The clarification queue (Milestone G). Each is a
specific answerable question with one-tap buttons. This is the panel that proves
the system asks rather than guesses.

**Your catalog, as an agent sees it.** Green dot = an agent can buy it. Red dot =
held, with the reason. This flips live when a question is answered.

**Agent Readiness.** A 0–100 score over three equally-weighted bars:

| Bar | Is |
|---|---|
| catalog confidence | how much of the catalog is resolved and sellable |
| policy coverage | how much of it has a price floor set |
| fulfillment record | how many paid sales the merchant confirmed delivering |

Equal weighting is stated on the panel rather than hidden — there is no evidence
here about which of the three matters most to a buyer.

**Verified Commerce History.** Four tiles plus a signed report hash. This is the
credit-signal beat. The *"what this report does not claim"* fold is worth opening
on camera for one second: it says `dispute_free_rate` means no disputes are
*recorded*, not that none occurred.

**The QR** is Milestone M — the same sticker idea, now pointing at a machine-readable shop.

**Live activity.** Every state change as it happens, colour-coded by family
(orange = negotiation, green = payment/fulfillment, amber = clarification, blue =
discovery/audit).

---

## 3 · `/shopper.html` — The buyer-agent's view

**What it is:** the agent narrating its own reasoning as a chat thread.

Ask for something two shops both stock — **`silicone phone case`** is the one
seeded for this — and it queries every merchant, haggles with each **separately**,
shows both negotiation logs, then picks one.

The line that matters: each offer shows the agreed price *and* the price
**adjusted for that merchant's delivery record**. A cheaper offer from someone who
may not hand the goods over is not actually cheaper. The reasoning underneath
says which won and why.

---

## 4 · `/market.html` — The wide shot

**What it is:** buyer-agent in the middle, three shops around it, a line lighting
up on every real event. Nothing here is animated on a timer — it is the same
event bus the other pages read.

Deliberately small and non-interactive. It is the establishing shot, not a
feature. Open it in a second window while driving the demo from the first.

---

## The five-minute run

Two browser windows: `/merchant.html` on the second screen, everything else on
the first.

**0:00 — `/` · the problem, on screen.** Scroll the three shops. Point at the two
red cards. *"Amma never said a price for the banana chips. So the system doesn't
invent one — it's held until she confirms."* Honest uncertainty in the first
thirty seconds.

**0:40 — `/merchant.html` as Amma · the sanity gate.** This is the strongest
single beat in the build:

> Adhirasam Packet at ₹1100 — your other snack items are ₹90–₹120. Is ₹1100 right,
> or did you mean ₹110?

Say the number that matters: **the model was 0.91 confident.** It read her
perfectly. The only thing that caught it was her own price history — one LLM
scoring its own confidence is one opinion checking itself. Tap **₹110**. The item
goes green, the readiness score moves.

**1:20 — `/shopper.html` · the marketplace.** Ask for `silicone phone case`.
Two shops, two independent haggles, one pick — justified on price *and*
reliability, not price alone.

**2:10 — `/` · one transaction end to end.** Click the saree. Read one grey
rationale line aloud. *"Half the gap toward the floor. Meena set that floor.
Nothing here can move it, and no model was asked to."* This is the AI-judgment
signal — you are showing where you chose **not** to use a model.

**3:00 — pay.** Razorpay Checkout, UPI `success@razorpay`. Real order ID, real
payment ID. Say plainly: *"Razorpay test mode, real API."*

**3:30 — confirm handover.** Show it reading *awaiting fulfillment* first.
*"It won't mark itself delivered. Only the shopkeeper's signature does that."*

**3:50 — the audit chain.** Four green checks, four hashes. Hold it.

**4:15 — the failures.** Preset *Can't afford it* → the floor holds, no payment
attempted. Then click a red card → refused, with the reason. Two different
refusals, both correct.

**4:40 — the commerce history panel.** One sentence: *"Every one of those sales
is a signed four-mandate chain. That's a trading record a lender could actually
check — and it falls out of the design for free."* Move on; don't over-explain it.

---

## If something goes wrong on camera

| Problem | Do this |
|---|---|
| Checkout rejects your card | Use UPI `success@razorpay`. The generic `4111…` test card is classed international and test accounts have that off — see [RAZORPAY_SETUP.md](RAZORPAY_SETUP.md). |
| The browser misbehaves | `npm run demo` runs the same walkthrough in the terminal, against the same API. Comment out the two Razorpay lines in `.env` first, or it will stop at Checkout — correctly, since a `payment_id` needs a browser. |
| Catalog looks wrong after clicking around | `rm -f data/vyapar.db*` and restart. Clarifications and sales reset; the seed data does not. |
| A shop shows no items | Its items are all held. Answer its questions on `/merchant.html` first. |

## Reset between takes

```bash
rm -f data/vyapar.db*     # clears sales + answered questions
npm run serve
```

Signing keys live in `data/keys.local.json` and are *not* cleared — deleting them
would make every previously signed chain unverifiable, which looks exactly like
tampering.
