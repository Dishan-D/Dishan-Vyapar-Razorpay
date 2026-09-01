# UI brief — Vyapar-to-Agent

For picking a template or commissioning a design. Everything below describes
what exists and what the screens must do; nothing here is decided about how it
should look.

---

## What the product is

65–90 million Indian merchants take payment through a UPI QR code and nothing
else — no website, no catalog, no API. An AI shopping agent cannot buy from
them, because there is nothing to buy *from*: a QR code accepts money and says
nothing about what is for sale.

Vyapar turns what those merchants already have — a photo of a shelf, a voice
note in Hinglish, a line of text — into a storefront an AI buyer-agent can
discover, negotiate with, and pay, with every money action signed and checkable.

**Two very different users, on the same system:**

| | Who | Device | What they need |
|---|---|---|---|
| **Merchant** | A shopkeeper between customers. Not technical. Often a mid-range Android phone. | Mobile first | Glance-and-act. What needs me, one tap to settle it. |
| **Buyer** | A shopper, and an AI agent acting for them | Desktop or mobile | Browse a shop, watch the agent work, confirm spending |

---

## The pages

### 1 · `/` — Landing
Explains the loop in ten labelled steps (each tagged with *who decides it* —
merchant, model, or rules), live counters read from stored state, a
side-by-side "what a machine can and cannot do" comparison, and a live activity
feed.

**Needs:** hero, numbered step cards, a two-column comparison block, stat tiles,
a live-updating feed list.

### 2 · `/onboard.html` — Merchant setup, 3 steps
Step 1 shop details · Step 2 what you sell · Step 3 processing then result.

Step 2 has four input modes behind tabs: **Photos** (drag-drop, thumbnails),
**Voice** (record button + transcript textarea), **Text** (textarea), and **One
by one** (repeating rows: thumbnail + name + price + stock + remove).

Step 3 shows a staged progress list that ticks off real pipeline stages with
elapsed times, then a product result list and a before/after comparison.

**Needs:** step indicator, segmented tabs, dropzone, thumbnail grid, repeating
form rows with per-row image picker, progress checklist, result cards.

### 3 · `/store.html` — Buyer storefront
A real e-commerce shelf: product grid (photo, name, shop, price, stock,
"agent-ready" badge), search, category pills, cart with a per-line price
ceiling, and an orders list whose status updates live when the merchant
confirms handover.

Right-hand rail: a **chat with the AI buyer agent** that shows its tool calls
above each answer, and renders a **confirm/decline card** before anything is
bought.

Distinctive behaviour: while the agent runs, it marks up the *same* product grid
a human browses — cards it ignored dim, ones it rejected show why on their face,
the one it buys lights up.

**Needs:** sticky header with search, filter pills, responsive product-card grid,
cart rows with inline number inputs, order rows with status pills and an
expandable detail, a chat panel with message bubbles + monospace tool-trail rows
+ an approval card.

### 4 · `/merchant.html` — Merchant dashboard
Two modes. **Simple** (default): an ask-anything chat panel plus alert cards
that each settle in one tap. **Deep Insight**: six screens behind a top menu —

| Screen | Contains |
|---|---|
| Today | What needs you; orders and handover |
| Catalog | Editable product rows (photo, name, price, stock) and the shop QR |
| Money | Bank settlements matched to sales; signed commerce history |
| Grow | Lost-revenue cases, recovery, a price-vs-revenue bar chart, before/after growth |
| Trust | Readiness score, trust passport, system performance |
| Assistant | Natural-language policy editor, live event stream |

**Needs:** top tab menu with a notification count, alert cards with primary
actions, editable table rows with an inline image picker, a simple bar chart
with hover tooltips, key-value evidence lists, status pills, a live feed.

---

## Component inventory

A template should cover most of these:

- Stat tiles / KPI cards
- Cards with a heading, a hint line, and a body
- Editable table or list rows with inline inputs and a thumbnail
- Segmented control (tabs), pill filters, top nav with active state
- Chat/message bubbles, plus a distinct monospace "system trace" row style
- Approval cards (amber/warning treatment, two buttons)
- Status pills in four states: neutral / waiting / good / problem
- Simple bar chart, horizontal progress or split bar
- Step indicator and a staged progress checklist
- Dropzone and thumbnail grid
- Product-card grid with image, price, badges
- Definition lists for evidence (label → monospace value)
- Live feed with a blinking "live" indicator
- Empty states and a full-width error banner

---

## Hard constraints

These are not stylistic preferences — the demo's credibility depends on them.

1. **Numbers must be checkable.** Rupee figures use tabular numerals and align.
   Signed hashes, payment ids and transaction ids appear in monospace. Any
   template that renders data as decorative infographics is wrong for this.
2. **Provenance is visible.** Many rows must say *how* a fact is known — "read
   from a photo", "the shopkeeper confirmed this", "decided by rules". The
   design needs a quiet secondary text treatment for that, everywhere.
3. **Information density matters.** This is a dashboard, not a marketing page.
   Cards must hold real tables and lists without breaking.
4. **Four semantic colours** are load-bearing: neutral, waiting/attention,
   good/verified, problem/blocked. They must be distinguishable without relying
   on colour alone — each pairs with an icon or a word.
5. **Mobile merchant view.** A shopkeeper uses this on a phone between
   customers. The Simple view and Today screen must be genuinely usable at
   360px.
6. **Light theme is primary.** Dark is optional.
7. **Indian rupee formatting** (`₹1,20,000` style grouping) and Devanagari/Tamil
   text may appear in product names — the font stack must not break on them.

---

## Current design system (for judging fit)

Replace freely; listed so you can see what a template would be displacing.

```
Backgrounds   #faf9f7  #ffffff  #f7f6f3  #f2f1ed
Borders       #e6e4df  #d7d4cd
Text          #16181d  #5b6070  #8b909e  #a9adb8
Good          #127a4d on #eaf4ee
Attention     #a86a09 on #fdf5e6
Problem       #b3382f on #fbefee
Accent        #2a78d6 on #eef4fd
Radii         14px cards, 10px controls
Shadows       barely there — 1px hairlines do most of the work
Type          system sans; SF Mono for ids, hashes and figures
```

Current character: restrained, light, hairline-bordered, near-flat. Think
fintech dashboard rather than consumer app.

---

## What to avoid

- Heavy gradients, glassmorphism, or large drop shadows — they make numbers look
  decorative rather than checkable.
- Templates built only for marketing pages. Four of five screens are
  application UI.
- Dark-only or neon themes.
- Icon-only navigation. The merchant is not a power user; labels stay.
- Anything that needs a paid icon set or webfont licence for a hackathon build.

---

## Practical notes

- Plain HTML + CSS + vanilla ES modules. No React, no build step, no Tailwind
  currently. A template shipping as **plain HTML/CSS** is the cheapest to adopt;
  a Tailwind one is workable; a React-only one is not.
- One shared stylesheet (`frontend/app.css`) plus a `<style>` block per page.
- Google Fonts is available; other CDNs are not guaranteed.
- Five HTML files total, ~2,900 lines of markup and page CSS.
