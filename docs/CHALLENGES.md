# Build Challenges & Technical Obstacles

*Vyapar-to-Agent — Razorpay AI Buildathon, Track 01*

Every issue below was hit while building, diagnosed, and fixed. Each entry says
what broke, why it broke, and what the fix was. Where a number appears it was
measured, not estimated.

The single sentence that covers most of this document: **almost every hard bug
was a place where the system was confidently wrong rather than visibly broken.**
A crash announces itself. A catalog that quietly drops seven of a merchant's ten
photos, or a reconciliation that reports four discrepancies that never happened,
looks exactly like a working system.

---

## The short answer (for the form)

> The hardest bugs were never crashes — they were the system being confidently
> wrong. A photo pipeline silently discarded every image after the third, so a
> merchant sending ten got three products and was never told. Our simulated
> payment gateway reset its counter on restart while the database did not, so
> eight sales shared one payment id, and the reconciliation engine confidently
> reported four amount mismatches that had never happened. A price-optimisation
> curve recommended earning ₹7,911 from nine sales of a saree with one in stock —
> every number in it produced by the real negotiation engine, and the whole thing
> nonsense. A buyer agent's order lookup crashed, and the model turned that
> failure into "your order list is empty". A purchase was refused with "the shop
> did not state a flavor" about a cake whose attributes read `flavour:
> chocolate` — the parser had written the American spelling and the gate
> compared raw keys. And nothing anywhere decremented
> stock, so a shop could sell its last cake four times and every screen went on
> agreeing with every other screen — they were all reading the same stale field.
>
> Four habits caught these. **Replay instead of predict**: the price curve reruns
> real buyers through the production negotiation engine, so it cannot promise a
> sale the engine would refuse. **Make the model prove it looked**: every agent
> answer shows the tool calls behind it, so an answer with no lookups is visibly
> an answer with no evidence. **Distinguish a failure from an empty result** — a
> tool that breaks now says so in words the model is instructed on. And a
> **60-claim audit script** that re-derives every headline claim from the running
> system, including fuzzing the negotiation invariants over 500 randomised
> policies, so "the agent never pays above its ceiling" is checked rather than
> asserted.
>
> The most useful discipline was refusing to fake the demo. The
> structured-vs-unstructured comparison runs a literal text search over the
> merchants' real voice notes rather than a degraded view of the clean catalog —
> and the honest version matched a cotton *kurta* for a cotton *saree* query,
> which demonstrates the problem far better than anything we would have staged.

---

## A · Bugs that lived between stages

The stages were each correct. The faults were in what they assumed about each
other — the hardest class to find, because every unit test passes.

### A1 · A saree query negotiated three rounds over a towel set
Three faults stacked: matching accepted a single incidental term ("cotton"),
the category constraint was only enforced at payment, and a price-ceiling filter
made "no deal" unreachable. **Fix:** a relevance floor, category checked at
discovery rather than at the till, and the ceiling filter removed.

### A2 · The audit trail contradicted itself
A `no_deal` reason cited an offer that did not appear in its own log — the loop
advanced the offer after the final round without logging it. **Fix:** the log is
written before the round advances, so the reason can only cite what is recorded.

### A3 · A gate that was tested without being tested
The authorization test passed against a path that never reached the gate.
**Fix:** the test now asserts the gate ran, not just that the outcome was right.

### A4 · Two shops, one product name
Item ids were derived from names, so two merchants stocking "Blue Cotton Saree"
collided. **Fix:** ids are namespaced per merchant.

---

## B · The model inventing constraints — four times

Every one of these would have blocked or mispriced a purchase.

| | What it invented | Consequence |
|---|---|---|
| B1 | A `size` requirement nobody mentioned | Authorization refused every saree in the catalog |
| B2 | A same-day delivery deadline | Excluded shops that could have sold |
| B3 | `colour` where the catalog said `color` | Read as a missing field, item rejected |
| B4 | **"under 1020" parsed as ₹1,190** | Would have authorised ₹170 of overspend |

**Fix:** anything not traceable to the shopper's own text is discarded before it
can become a requirement, and the discard is logged. B4 is the one that mattered
— the ceiling is the only thing standing between a buyer and an unbounded
purchase, so the model may *read* it and may never *widen* it.

---

## C · Live model output behaves nothing like fixtures

### C1 · Free-text categories silently disabled the sanity check
The price sanity check compares an item against others in its category. With
free-text categories nothing shared one, so the check never fired — on live data
only. **Fix:** a fixed enum, with the shop's trade as context.

### C2 · `confidence === 1` collided with a sentinel
The value used to mean "the merchant confirmed this" was also a legitimate model
output. **Fix:** an explicit flag.

### C3 · Photos alone extracted nothing
Caution in the prompt was read as "return nothing if unsure". **Fix:** stated
plainly that an unpriced product is still a product.

### C4 · Live extraction is not repeatable
Two runs over identical photos produce different confidence scores. **Fix:** the
catalog is cached and provenance recorded, so a demo cannot silently re-extract.

---

## D · Configuration and infrastructure

### D1 · An empty environment variable broke everything downstream
`GROQ_MODEL=` produced `404 the model \`\` does not exist`, because `??` only
falls back on `undefined`, not on empty string. **This was caused by my own
`.env` de-duplication.** The worse half: `parseIntent` swallowed the error, so
the system looked like it had chosen to be deterministic. **Fix:** empty strings
are treated as unset, and a model failure is reported rather than absorbed.

### D2 · `.env` was never loaded
**Fix:** `--env-file-if-exists` in the serve script.

### D3 · Groq's token ceiling, measured rather than guessed
Photos cost a flat ~1,700–2,074 tokens regardless of resolution — downscaling
changes nothing. **Fix:** a rate governor that reads the response headers and
paces itself, rather than retrying into 429s.

### D4 · A cache that served a schema that no longer existed
**Fix:** any merchant missing a current field invalidates the whole cache file.
A stale cache that looks fine is worse than no cache.

---

## E · Honesty bugs — where the system over-claimed

This category matters most. Every one of these produced a plausible screen.

### E1 · A revenue recommendation that could not have worked
The merchant was told to give up ₹30 to recover five buyers who still could not
have bought at the new price. **Fix:** each lost buyer's actual offers are
replayed before anything is recommended.

### E2 · One outlier hid an entire opportunity
**Fix:** the recommendation is judged on the median, not the extreme.

### E3 · A recovery case deleted itself when acted on
It was recomputed against the *new* floor, so acting on it made it disappear.
**Fix:** judge each case against the floor those buyers actually faced.

### E4 · "Recovered" had to mean money actually returned
**Fix:** the lifecycle is `at_risk → action_taken → recovered`, and the last
state requires a real closed sale. Proven live: `₹3,060 → ₹0 → ₹1,003`.

### E5 · The comparison that would have been easiest to fake
The spec asks for a structured-vs-unstructured demo and warns against showing
the same clean catalog behind a different label. **Fix:** the unstructured side
runs a literal substring search over the merchants' real transcribed voice
notes. The honest version is *more* convincing: asked for a "blue cotton saree"
it returns a cotton **kurta**, because raw text has no idea which noun an
adjective belongs to. Nobody designed that failure — it is what substring
matching does.

It also surfaced a third outcome I had not modelled. Searching "silk dupatta"
found the product and *refused to offer it*: the merchant had said *"stock
godown mein dekhna padega"*, so stock confidence was 0.00 and the item was held.
My verdict string had two branches and reported this as "nothing matches",
contradicting the held-item list beside it. I had modelled the pipeline as
succeed-or-fail when its most defensible behaviour is the third state — found
it, understood it, declined to sell it, asked the shopkeeper.

---

## F · The photo pipeline

### F1 · Several photos were read as one scene
Three photos of a saree, a kurta and a towel returned **one product** — while
the model's own summary named all three. It was seeing them and not enumerating
them. **Fix:** each photo announced by number in its own text part. Same three
photos: **1 → 3 products.**

### F2 · Photos beyond the third were silently discarded
`MAX_PHOTOS_PER_CALL = 3` was a hard `slice(0, 3)`. A merchant sending ten got
three products and was never told about the other seven — quiet, plausible, and
wrong. **Fix:** it is a batch size now, not a cap; photos go up in batches and
the products merge.

### F3 · The prompt contradicted itself and the model refused
`describe()` announced the *uploaded* photo count while a different number was
actually attached. The model responded: *"impossible to isolate a single hero
product… I cannot confidently extract."* **Fix:** the count stated is the count
attached.

### F4 · A spent daily quota hung the request for 31 minutes
On a daily-limit 429 the governor honoured `retry-after` by sleeping — holding
the merchant's request open with no explanation, indistinguishable from a hung
app. **Fix:** the call is bounded, and a spent quota returns `429` in 0s naming
what happened and when it resets, with a Try again button. The photos are
already stored, so retrying costs nothing.

### F5 · Tesseract does not decline
Shown plain folded cloth, OCR returned `"2 | | » To a | Tor | J hh"` at
confidence 22–36 — and my first gate accepted it, because garbage passes any
length-based test. Feeding that to the model is worse than sending nothing:
noise wearing the costume of evidence. **Fix:** gate on confidence first. Real
printed text reads at 93–94; all five sample garment photos are now correctly
rejected.

### F6 · Products refused because the brand was not the shop's name
A supplier flyer headed *"TECHOasis Electronics Solutions"* was uploaded to
*"Dishan's Electronics store"*. OCR read it perfectly — four products, four
prices, confidence 93 — and the model listed **nothing**, reasoning the brand
and contact details belonged to another entity.

My instruction was wrong about the world. A shop's name is almost never in the
photos and other companies' names almost always are: packaging carries the
manufacturer's brand, and photographing a distributor's rate list is the fastest
way a shopkeeper says "I stock these". **Fix:** both prompts now state this, and
that the shop's trade is a plausibility check, never an ownership test. Same
flyer: **0 → 4 products**, every price and stock correct at 0.95 confidence.

### F7 · No category for a laptop or a television
Both landed in `mobile.other` — wrong enough to make them unfindable by the one
term a buyer would search. **Fix:** added `electronics.laptop/.tv/.appliance/
.other`. The storefront prompt also kept its own hardcoded copy of the category
list, which would have silently drifted from the enum the schema validates
against; it is generated from the enum now.

---

## G · Search that could not find stock the shop had

A shopper asked for *"some device to listen to music"* and got nothing, while
the shop stocked **Techno Bud Pro TWS Earbuds** and **Wired Earphones with 3.5mm
Jack**. Three faults compounded:

1. **No product-family knowledge.** `"headphones"` matched neither, because no
   substring of one appears in the other. A shopper forced to guess the
   merchant's exact noun is back to the problem this project exists to solve.
   **Fix:** a hand-written `CATEGORY_WORDS` lexicon — a term counts if it is one
   of the item's own words *or* names the family it is filed under.
   Deliberately a lexicon and not an embedding: a wrong entry can be deleted by
   anyone reading the file, and the merchant can be shown why they matched.
2. **`"device"` acted as the head noun** and names nothing, so the head-noun
   rule could never fire. **Fix:** filler.
3. **Matching was substring**, so `"phone"` matched `"earphones"` and a search
   for a phone *charger* returned earphones. **Fix:** word-boundary matching
   with a plural rule.

And a ranking bug the first two exposed: for `"phone charger"` a screen
protector, a phone cover and the actual charger all match one word of two and
tie at 0.5, so **the charger sorted last** and the shopper had to hunt for the
product they had named. **Fix:** matching the head noun outranks matching some
other word of the phrase.

---

## H · Money, and the things that count it

### H1 · A payment that succeeded, reported as a failure
Once the Razorpay webhook was configured, **two** things settled a payment: the
browser handler and the webhook. Whichever lost the race got `409 already paid`
— which means the money *arrived* — and the UI showed it as an error after a
successful purchase. **Fix:** neither racer's local view is trusted; the page
asks the server what the order actually is.

### H2 · Eight sales sharing one payment id
The simulated gateway's counter reset on restart while the database did not, so
one shop held `sim_pay_0001` **eight times**. A payment id is the thing a bank
statement, a refund and a dispute are all keyed on — a repeated one makes every
lookup by it silently ambiguous.

This was found by the reconciliation engine, which confidently reported **four
amount mismatches that had never happened**: it had matched sales to the wrong
credits, because eight of them answered to the same name. **Fix:** ids are
unique per process, and the matcher treats a shared id as a collision to be
broken by amount rather than as identity — so it stays correct against rows
already in the database.

### H3 · A price curve that ignored the shelf
The elasticity engine recommended earning **₹7,911 from nine sales of a saree
with one in stock**. Every number came from the real negotiation engine and the
whole thing was nonsense: the engine prices a sale, it does not know how many
exist. **Fix:** closes are sorted by price and truncated to stock. The advice
then inverts correctly — with one unit it says *raise* the floor (₹1,050 →
₹1,110); with ten it says lower it. Total upside fell from ₹11,305 to **₹3,602**,
which is the honest number.

### H4 · Every recovery case expired
Cases were anchored to `shutOut[shutOut.length - 1]`, and the demand query
returns newest-first — so the anchor was the **oldest** buyer who walked. With a
24-hour window, one stale loss expired an item permanently however many buyers
left this morning. Seed data read `₹8,030 expired, ₹0 at risk`. **Fix:** the
latest walkaway decides. It now reads **`₹8,030 at risk, ₹0 expired`**.

### H5 · A shop could sell its last cake four times
Nothing anywhere decremented stock. A product could be bought repeatedly and go
on reporting the quantity it was seeded with, so "5 in stock" meant "5 when we
wrote the seed file" — on the one number a shopkeeper checks against a physical
shelf. It went unnoticed because every screen agreed with every other screen:
they were all reading the same stale field.

**Fix:** the sold unit comes off the shelf at the deduped capture point, so a
webhook and a browser callback for the same payment take one unit rather than
two, and a failed or abandoned checkout takes none. It floors at zero instead of
going negative — negative inventory is never true, and a genuine race for the
last unit is an oversell for a human to sort out, not a number to record. The
new count is written back through the same path a merchant's own edit takes, so
it survives a restart rather than being restored from the seed. Selling a
product to zero now ends with the shop declining: `no_match`.

### H6 · Two true numbers, read as one wrong one
The growth panel showed **96 sales** beside **₹5,672 verified value** with
nothing between them, which reads as ₹59 a sale. Both figures were correct and
neither answered the other's question: ₹5,672 is the subset the shopkeeper has
signed a handover for, and the 96 paid sales took **₹9,581**. No code was wrong;
the layout was making a claim the data did not.

**Fix:** both are named — *Revenue taken* and, indented below it, *Of that,
confirmed handed over*.

### H7 · Statistics that no one could check
There was no product-level reading of the ledger at all. A merchant could see
their revenue and their catalog and had no way to ask which products earned it,
so neither of the two faults above was visible from any screen the product
offered.

**Fix:** one aggregator, `src/analytics/ledger.ts`, derives every merchant and
product figure from the signed chains. Nothing increments a counter and nothing
is stored beside a product, so the dashboard cannot drift from the transactions
it summarises — the alternative has a failure mode this does not, where a write
lands in one place and not the other and nothing in the system can tell.
`GET /analytics/transactions` returns the unaggregated rows and
`GET /analytics/integrity` re-checks that line totals sum to their transaction,
that no payment id appears on two sales, and that no sale is credited to a shop
that does not stock the product. A statistic nobody can audit is
indistinguishable from one that is made up.

### H8 · Why a sale happened cannot be recovered afterwards
Nothing in a mandate says whether a product was what the shopper came for or
something the shop suggested alongside it — a cross-sold packet of candles and
one asked for by name produce identical transactions. Reading it back out of
product names or prices later would have been a guess presented as a growth
figure.

**Fix:** the storefront states it at the moment the buyer agrees, because that is
the only moment it is known, and the ledger stores it verbatim. An unrecognised
value is recorded as organic rather than guessed at: under-crediting the Revenue
Agent is a far smaller sin than a growth number that claims sales it had nothing
to do with.

---

## I · Agents, and the ways they lie

### I1 · A model that turned a crash into a fact
The buyer agent's `get_orders` destructured `{status, body}` from a helper that
returns parsed JSON directly, so every call threw. The model took that failure
and answered **"your order list is empty"** — a fabrication assembled out of an
error. **Fix:** failed tool results now carry `tool_failed: true` and an explicit
instruction that a failure is *not* an empty result and must not become a
statement about what would have been returned. The system prompt says it too.

### I2 · No room left to speak
`MAX_STEPS = 3`, but a buying question legitimately costs three lookups — search
the shelf, check the shop's delivery record, prepare the purchase — leaving
nothing for the model to answer with. A correct three-tool run ended with *"I
looked that up but could not summarise it"*. **Fix:** four.

### I3 · Buying had to stay behind a human press
The design constraint throughout: read tools run immediately, anything that
spends money returns a **proposal**. Verified — *"buy me a blue cotton saree, up
to 1400"* chains `search_shelf` then `start_purchase` and stops at a Confirm
button; *"just buy me something cheap"* prepares nothing and answers that cheap
is not a budget.

### I4 · A guard that only caught one way of lying
The buyer agent ended a run with *"the Chocolate Cookie is ready. **Tap the Pay
₹80 button** when you're good to go."* No such button was on the screen — the
model had never called `start_purchase`, so nothing had been prepared. The
shopper pressed at an empty panel.

There *was* a guard for exactly this, and it did not fire. It was anchored on
the word **confirm** (`press|tap|click|hit … confirm`), so it caught the
phrasing the model used the day it was written and nothing else. "Buy", "Pay",
"the green button", "the button below" all mean the same thing to a shopper and
none of them says confirm.

**Fix:** the guard keys on the *reference to a button*, not on a label —
excluding Add to cart, which really is on every shelf card, so pointing there is
honest. And the retry is no longer the last line of defence: if the second
attempt still prepares nothing, the answer is replaced with *"I could not get
that ready, so there is no button to press yet"* rather than shipped as written.
The prompt now also tells the model what the button actually says, since it had
been inventing labels. Eight phrasings, four that must fire and three that must
not, are checked in `scripts/audit.ts` — the guards are pure functions, so they
are tested directly rather than by coaxing a model into failing.

**The general lesson**, and it is the same one as D1 and H2: a guard written
against one observed failure tests the sentence, not the behaviour. Ask what the
*class* of wrong looks like before writing the pattern.

### I5 · "I could not tell which product that is"
The same run had the model pass **`80`** — the cookie's *price* — where a
product was expected. `resolveProduct` read a bare number as a position in the
list it had just shown, found no 80th row, and returned the generic *"I could
not tell which product that is."* True, and useless: the model had no idea what
was wrong with what it sent, so it stopped looking things up and invented the
button above.

**Fix:** the error names the range it may actually refer to — *"80 is not a row
number — the list has 3 (1 to 3). If 80 was a price, pass the product's name or
its row number instead."* A tool error is a prompt like any other; one that does
not say what to try next is a dead end.

### I6 · "The shop did not state a flavor" — about a cake whose flavour is stated
A pinned purchase of a Chocolate Cake 1kg came back:

```
Checked 7 shops; 1 stock it
Sri Balaji Bakery ruled out — Flavor matches: the shop did not state a flavor
Nothing on offer satisfied what you asked for
```

The shop states it. `itm_hazel_002` carries `{"flavour": "chocolate", "weight":
"1kg", "serves": "8-10"}`. The intent parser had written **`flavor`**, the
catalog says **`flavour`**, and the authority gate compared the raw keys, found
nothing under its spelling, and refused the sale.

Two things made this hard to see. It is intermittent — the parser emits the
attribute perhaps half the time, so the same prompt buys the cake on one run and
refuses it on the next. And the refusal is *articulate*: "the shop did not state
a flavor" is a complete, confident sentence about a fact that is not true, which
reads as a data problem in the shop rather than a bug in the comparison. The
first instinct — and the user's — was to suspect the model or the API key. It is
neither: `flavor` is a perfectly good word, and no key changes which spelling
the catalog uses.

**There was already a table for exactly this.** `KEY_SYNONYMS` in
`src/mandates/authority.ts` maps `colour → color`, and its comment explains this
precise failure — *"a British spelling made it look like the shop had never
stated a colour at all, which blocked a purchase for a reason that was not
true."* Nobody added `flavour`, which is the most common attribute in a catalog
of cakes and sweets.

**Fix:** the table now covers every key this catalog actually uses — flavour,
weight, scent, serves — with the alternates a model reaches for
(taste, grams, fragrance, servings). Eight spellings are checked in
`scripts/audit.ts`. **The general shape:** a lookup table written against one
observed collision only ever covers that collision. The fix is to enumerate the
vocabulary you actually have, not to add the word that just bit you.

### I7 · The pinning exemption was written once and applied half the time
The same run exposed a second fault. A run pinned to a product the shopper
picked already dropped the model's inferred attributes — with a comment saying
why: *"the shopper has already picked the product; re-applying a constraint the
model inferred could only exclude the very thing they confirmed."*

That reasoning was applied to the **search** and not to the **authorization
gate**, which went on testing the same guessed adjectives. So a pinned run could
find the confirmed cake, agree a price for it, and then refuse it at the till —
on a constraint nobody had asked for.

**Fix:** one `filters` value, decided once, used by both. The money ceiling is
untouched either way: that is the shopper's own number and the only one the gate
exists to enforce. An adjective a model guessed from a sentence is not
authorization, and it has no business overruling a product the shopper pointed
at.

---

## J · Interface faults

### J1 · One missing element id took down the whole dashboard
The merchant module referenced nine ids that did not exist in the markup —
`askq`, `askgo`, `askout`, `askmic`, `simple`, `simplewrap`, `deepwrap`,
`modes`. `$("askgo").onclick` threw at module top level, so **every statement
below it never ran**: `loadMerchants()`, `setMode()`, `refresh()`, `boot()`.
That single throw was the empty merchant dropdown, the panels stuck on
"Loading…", the missing Simple/Deep toggle and the missing chat panel — four
symptoms, one cause. The CSS had survived; only the body markup was lost in an
earlier redesign of mine. **Fix:** markup restored, and a dashboard that cannot
reach its server now says so instead of sitting on "Loading…" forever — which is
what sent me hunting for a rendering bug that did not exist.

### J2 · Two CSS class collisions in one panel
`.ev` is the live-event row (a `6px 46px 1fr` grid) and the opportunities list
reused the name, squeezing evidence lines into three narrow columns. `.rec` is
the uppercase risk-action badge, which is why a recommendation was SHOUTING.
**Fix:** unique names.

### J3 · The buy panel crashed after a successful purchase
`Cannot read properties of undefined (reading 'log')` — the server flattens each
offer to `log` and a numeric `readiness`, while the panel read `outcome.log` and
`readiness.score`, and used a `list_price` the server never sent. **Fix:** read
the shape actually sent.

### J4 · Live events carried the headline and nothing else
`agent.step` published only its message, so a watcher could be told "checked 4
shops" but never *which* four — the interesting half. **Fix:** the step's detail
travels with it, plus the run's trace is replayed after the response so a
dropped socket frame cannot leave a successful run unmarked.

### J5 · Two pages doing one job
"Storefront" and "Agent log" were the same thing wearing two skins — one was the
pipeline with no shop, the other the shop with the pipeline inside it. **Fix:**
merged; one buyer page.

### J6 · Fifteen panels at once
The merchant dashboard rendered everything simultaneously, so a shopkeeper
looking for today's orders scrolled past a price-elasticity chart to reach them.
**Fix:** six screens behind a menu, grouped by the question being asked — Today,
Catalog, Money, Grow, Trust, Assistant. The chosen screen is remembered, and
anything waiting shows as a count on the Today tab, because a menu must not
become a place for work to hide.

### J7 · A merchant could see a mistake and not fix it
Extraction pairs photos to products *positionally* and the code says outright
that this is a display hint, not a fact — so wrong pictures were expected, and
the catalog was the one screen where a merchant could see one and had no way to
correct it. **Fix:** the catalog row's thumbnail is now an editor.

### J8 · A shelf that answered a question from three turns ago
Every early return in `highlightMentioned` left the previous turn's marks on the
grid. Ask a second question and the ring stayed where the first answer had put
it, so the shelf looked frozen while the conversation moved on. **Fix:** clear
first, then decide — the function now has one exit that leaves marks and every
other path clears.

### J9 · Emphasis by subtraction said the wrong thing
Highlighting dropped every unmentioned card to **34% opacity** — the same
treatment this page gives a product the shopkeeper has not confirmed. A search
for cakes under ₹800 returned six, the assistant summarised three, and the other
three read as out of stock. They were all in stock and all buyable.

It was also picking the wrong three. *"I found 6 cakes under ₹800, ranging
₹450–₹750"* contains four rupee figures and points at no product at all: ₹800 is
the shopper's own ceiling and the other two are the ends of a span. Read
literally, that sentence lit whichever products sat on the boundaries.

**Fix:** ceilings (`under`, `up to`, `within`, `at most`) and ranges are
stripped before anything is matched, and emphasis is added rather than taken
away — a ring on what was named, nothing done to the rest. Five sentences the
assistant really produced are checked in `scripts/check-frontend.mjs`.

### J10 · Six cards, and no way to choose one
The assistant ended on *"Which one would you like?"* beside six products the
shopper could see and not pick. The only way to answer was to type the name of
a thing already on the screen.

**Fix:** while the agent has the shelf narrowed, a card **is** the reply — click
it and the purchase is prepared from the card's own data. Deliberately built
without a model round trip: the card already knows the id, the shop and the
price, so a call could only add a mistake and a token bill, and picking a
product is the one action here that should never fail because a language model
is busy. It is now also the documented fallback for a rate-limited demo.

### J11 · The pinned product was accepted and thrown away
`run(goal, itemId)` took an item id and never sent it. The server has always
supported pinning a run to one product, and the storefront has always known
which card the shopper picked, and the two were never connected — so pressing
Confirm on one cake re-searched every shop for the goal *text*. It usually
bought the right thing, by luck, with no way to tell the times it did not.

### J12 · Two lists with no ceiling, on the two screens that grow fastest
The settlement feed and the shopper's order list are the only panels fed
directly by transactions, so they are the two that grow without bound — and
neither had a frame. After an afternoon of demos the merchant's Payments screen
carried **150 credits** and the storefront's Your Orders carried **175**, each
row with a thumbnail and an expandable detail block. Everything below them was
several screens away.

Both are now fixed-height with internal scroll, using the same `.scrollbox`
utility the Grow panels already had — which had been written for exactly this
and then applied to one screen. The helper that hides the bottom fade when
content already fits lived inside `merchant.html`, so moving it into the shared
`ui.js` was a precondition rather than tidying.

**Two things a frame makes worse, both fixed with it.** A summary above a
scrolled list implies the list agrees with it: 99% explained reads as *nothing
to see* when five credits do need a look. And the one order a shopper came back
to check is the one still waiting on the shop, which is precisely the row they
will not find by scrolling. So each list now states its own contents above the
frame — `150 credits · 5 need a look`, `175 orders · 5 awaiting handover · 23
not paid` — and the reconciliation counts are a filter, not just a label.

The filter deliberately does **not** reorder the feed to put exceptions first. A
statement whose rows move around stops being a statement.

## J13–J16 · Rebuilding the merchant side around an assistant

### J13 · The spec described a shop this project does not have
The brief for the merchant rebuild asked for "who owes me money", "your best
customers", "create an invoice for Rahul", "send Priya a reminder", and refunds.
**None of those entities exist here.** This system's buyers are AI agents
(`agent_xyz`); there is no name, no phone number, no purchase history, and no
refund path. The examples describe a small-business CRM, and this is an
agentic-commerce demo.

Building them would have meant seeding a table of fictional customers — and
"nothing is presented as measured when it is modelled" is a headline claim of
this project, not a nicety.

**What was built instead:** the whole architecture as specified — supervisor,
tool registry, deterministic routing, idempotent actions, human confirmation,
live activity, QR upload, voice — wired to data that genuinely exists. Where a
question has a real analogue it is answered with it: *"who owes me money"* is a
real question here, and the answer is 23 orders that were agreed and never paid.
Where it does not, the assistant says so and offers the nearest real thing:

> Your buyers here are AI shopping agents, so the shop never sees a name, a
> number or a history for them — there is no customer list to rank. What I can
> tell you: Chocolate Cake 500g earns the most — ₹16,086 from 38 sold.

That is a first-class outcome in the router, not a parse failure. "I don't
understand" would have been false — it understood perfectly.

### J14 · Nine paid orders counted as unpaid
The new tools filtered orders on `status === "paid"`. The merchant endpoint's
status strings are `awaiting_payment`, **`awaiting_handover`** and `delivered` —
so an order that had been paid for and was waiting to be handed over matched
none of them, and every one was counted as money owed.

The assistant reported **"31 orders were agreed but never paid — ₹5,137"**. The
truth was 23 and ₹1,480; the other nine were paid, banked, and sitting on the
counter.

**Fix:** every site reads the `paid` and `delivered` booleans on the row, which
cannot be misspelt into a wrong answer the way a status string can. Four call
sites had the same bug — the tool, the order list, the attention count, and the
action resolver — which is what happens when a filter is written from memory of
a shape rather than from the shape.

### J15 · Two follow-ups that answered a question nobody asked
Conversation state is the point of an assistant, and both failures looked like
answers rather than errors.

> "How much did I make yesterday?" → **₹12,011**
> "And the week?" → **₹19,729 today** ← wrong period

> "What are my best sellers?" → Chocolate Cake 500g
> "Which of those haven't sold?" → **₹19,729 today** ← wrong subject entirely

Both messages carry no subject at all: every word that says what they are about
was in the previous turn. Routed alone they fell to the generic path, which
answers with today's takings — a real figure, confidently given, to a question
nobody asked. **A shopkeeper would never report this as a bug.**

**Fix:** a short message naming a period is about takings whatever preceded it;
a message that refers back (*those, them, that one*) re-runs the tool the last
answer came from. Both are checked in `scripts/audit.ts`.

### J16 · The assistant could not do anything
The first router reached only read tools, so *"mark that order as handed over"*
answered with a list of orders. Recognising an instruction and carrying it out
are different problems, and only the first had been solved.

**Fix:** instructions are matched before questions — "send an invoice for that
order" also contains the word "order", and answering it with a list of orders is
the kind of near-miss that makes an assistant feel deaf. Resolution refuses
rather than guesses: nine paid orders and no way to choose produces *"There are
9 of those — tell me which one"*, because an invoice raised against the wrong
sale is not something a merchant can quietly undo.

Every write is proposed and waits for a press; the press is idempotent by action
id, so a merchant on a shop's connection who presses twice gets one invoice and
the same confirmation. A failed action returns **409** and says what failed —
tested against a real refusal from the invoice endpoint:

> That did not go through — the shop has not confirmed handover yet; an invoice
> for goods that have not moved is not a record, it is a fiction.

## J17–J19 · Six months of history that had to be real

### J17 · The choice that decided the whole thing
The brief asked for six months of synthetic transactions so the analytics have
something to find. The obvious route — write rows into a transactions table —
would have taken an hour and would have quietly severed the dashboards from the
machinery they claim to summarise. The first time a generated price appeared
that the negotiation engine would have refused, the demo would be asserting
something the product cannot do.

So every generated order goes through the **production negotiation engine** and
comes out as **four genuinely signed ES256 mandates**, backdated. `issued_at`
was already an override on all four builders — a mandate's timestamp has always
been part of what is signed rather than a column beside it — so this needed no
new code path at all.

It was affordable because signing is cheap: **0.3ms per four-mandate chain**,
measured before committing to the approach. **11,246 orders in 5.9 seconds.**

The data is synthetic in that these buyers never existed. It is real in that
every price is one the engine would have agreed to, every chain verifies, and
every figure derives exactly as one from this afternoon's sale would.

### J18 · Two thousand sales of a product that did not exist
The generator read `loadServingCatalog()` — the fixture on disk. The server
reads the same fixture and then applies the shopkeeper's **deletion
tombstones**. So the generator cheerfully sold `itm_loom_006` **1,997 times**
from a shop that no longer stocks it.

Nothing crashed. The shop's revenue was higher than its catalog could explain,
and every screen agreed with every other screen. The integrity check found all
1,997 in one pass — which is the entire argument for having written it.

**Fix:** the generator applies the same tombstones and the same merchant edits
the server does, so it sells the catalog that actually exists.

### J19 · A declining shop that was up 30%
`stories.ts` gives one shop a six-month decline so that *"why are my sales
down?"* has a real answer. It did not survive contact with the question: a
monthly slope is **invisible week-over-week**, because ordinary day-to-day
variation is larger than one week's worth of a six-month trend. Asked why sales
were down, the declining shop answered **"up 30%"**. Correct arithmetic, useless
demo.

**Fix:** the fall steepens as it approaches today — which is also how losing
customers actually works. It now reads **down 48%**, and the breakdown is
measured rather than asserted:

```
· how many different buyers: 12 against 26          [-54%]
· how many orders: 14 against 29 — 52% fewer        [-52%]
· Fresh Bread Loaf: ₹1,842 against ₹4,374           [-58%]
```

**The guard that matters more:** the same question on a *growing* shop returns
*"Your sales are actually up slightly — ₹38,270 against ₹37,954."* A template
would have handed it reasons for a decline that never happened. `contributors()`
returns nothing when nothing moved, and the audit checks exactly that.

Two smaller ones from the same build. Evening-weighted hours dated orders at 6pm
on a morning run, so the customer panel reported buyers who last bought
**"-1 days ago"** — a negative age makes every figure beside it suspect. And the
first buyer set had **100% repeat customers**, because it had no tail of people
who came once; a shop where everybody is a regular makes "your top five are half
your revenue" an arithmetic artefact rather than a finding.

### J20 · An opportunity card that rendered as five vertical strips
The Grow panel drew each card's headline, evidence, advice, price and buttons as
five ~90px columns with the text wrapping every second word. Unreadable, and on
one of the panels the demo is built around.

I could not reproduce the cause from the source. The stylesheet's braces
balance, the HTML nesting validates, no rule anywhere sets `column-count`, and
nothing injects CSS at runtime — yet `.opp` was clearly laying its children out
on a row, which it can only do if something gives it a `display` it does not
declare. Two of its child rules already carried defensive `display:block` and
`text-transform:none` resets, so something has been reaching them for a while.

**Fix:** the card states its own axis — `display:flex; flex-direction:column` —
rather than relying on `block` being what it is left with, and every child is
given a floor it cannot be squeezed below. A panel explicit about its layout
cannot be quietly relaid by something else, whatever that something turns out to
be. The price and the buttons now share a row that wraps rather than shrinking.

**Honest status:** this is a fix by construction, not by diagnosis. I would
rather say that than claim to have found a cause I did not find.

### J21 · I broke the stylesheet deleting dead rules
Removing the two vertical chains from the homepage, I deleted their CSS by
matching the selector line — and multi-line rules left their closing braces
behind. Two orphaned `}` characters, and every rule after them silently
discarded by the browser.

Nothing errored. The page rendered with a handful of styles missing, which reads
as a layout bug in whatever happens to be next rather than as a parse failure
several rules earlier.

**Fix:** `scripts/check-frontend.mjs` now balances braces in every page's
`<style>` block and in `app.css`, reporting the line of the first stray `}`.
Verified by breaking a rule on purpose and watching it fail. This is the third
time a silent CSS fault has cost real time on this project, and the first time
there has been a check for it.

### J22 · The assistant was sitting in half a page
Simple Mode looked off-centre because it was. The container still carried
`class="wrap"` — the *dashboard's* two-column grid — left over from the panel
layout it replaced, so the whole conversational surface was laid into column one
and the right half of every screen was empty. `setMode` then set it to
`display:grid`, which kept the two columns alive even after the second was gone.

The greeting and the composer were also pinned to opposite ends of a
`min-height:100vh` flex column, so an empty screen put a question at the top, a
box for answering it at the bottom, and nothing at all between them.

**Fix:** its own `.simplewrap`, `display:block`, and an `.empty` class that
centres the greeting and the composer together while there is no conversation —
and comes off the moment there is one, because then the composer does belong at
the bottom. Both states were wrong for the same reason: the layout described one
situation and was applied to two.

The rest of the gap to the reference was surface rather than structure: the mesh
ground behind the empty state, a composer sized like the only thing on the page
worth touching, the QR upload offered once as an opening move rather than as
furniture, and the mode switch as a filled pill.

### J23 · Insights had the data and showed none of it
Every endpoint the reference dashboard implies already existed — `/trend`
measures a period against the one before it, `/customers` ranks buyers,
`/analytics` returns fourteen days of revenue — and the Today screen showed a
list of orders.

**Fix:** a headline row reading the *same two endpoints the assistant calls*, so
a figure on the dashboard and the same figure in the conversation are one
reading rather than two. Two sources for one number eventually disagree, and the
one that is wrong is whichever the merchant happens to be looking at.

The "I noticed something" panel takes the largest **measured** contributor and
hides itself when nothing moved enough to register — a dashboard that always has
an insight is one whose insights nobody believes. Its buttons hand the question
to the assistant and switch modes, so the explanation happens where explanations
happen.

### J24 · "Takings are level" about a comparison never made
The insight panel is measured end to end — the headline percentage, every
contributor line, the lapsed-buyer count. All of it re-derives from the
transaction rows, which I verified by recomputing each claim independently:

```
mer_ovenroom   headline  server -48%   recomputed -48%   MATCH
               revenue   ₹5,392 / ₹10,278                MATCH
               "Fresh Bread Loaf — ₹1,842 against ₹4,374" MATCH
mer_atelier    "buyers coming back — 23 against 20"       MATCH
```

One sentence was not. The server reports `direction: "unknown"` when the
previous period took nothing at all, because there is no percentage to compute
against zero — and the panel's ternary fell through to **"Takings are level"**.
A shop that went from ₹0 to ₹5,000 would have been told its takings were
unchanged.

Nothing else in the panel was wrong, which is exactly what made it worth
finding: one asserted comparison, sitting among five measured ones, borrowing
their credibility.

**Fix:** the unknown case says what is true — *"₹5,000 over the last 7 days —
there is nothing in the period before it to compare against."* And
`scripts/check-demo-data.ts` now re-derives **every** contributor line from the
raw rows for all six shops, so a line the transactions cannot produce fails the
build rather than reaching a merchant.

**The general point:** a panel where four figures are measured and one is
asserted is more dangerous than one where none are, because the four teach the
reader to trust the fifth.

### J25 · An assistant that reported instead of acting
Asked *"what needs my attention"* it answered **"₹32,081 today across 123
orders. 49 waiting to be handed over."** — and then stopped. To do anything
about those 49 the shopkeeper had to start a fresh request, and the only
handover the assistant understood was singular: it would ask *which one of the
49*, forty-nine times.

The answer knew what needed doing and made the merchant ask for it separately.
That is an interface being a report.

**Fix, two halves.** The answer now arrives **with the action on it** — the
proposal is minted alongside the figure it describes, and still does nothing
until pressed. And *"hand these over"* is understood as a bulk instruction,
checked **before** the singular rule, because both contain the word "hand" and
answering a plural instruction with *"which one?"* is how an assistant feels
deaf.

**What it is not:** a bulk database update. Each handover is a separate signed
fulfilment mandate appended to its own chain — forty-nine signatures, because
forty-nine sales were closed. The list is re-read at execution rather than
carried on the proposal, so an order handed over by hand in between simply is
not in it any more.

And a bulk action can partly fail. The confirmation reports what actually
happened — *"handed over 40 of 49"* — rather than echoing the proposal's own
wording back, which would have claimed 49. Pressing twice still returns
*"Already done."*

**Where it nearly went wrong:** the new tool landed in `runTool` — the *older*
merchant switch — rather than `runMerchantTool`, because both have a
`case "propose_set_price"` and the edit matched the first. The typechecker
caught it (`'card' does not exist in type 'ToolResult'`). Two switches with
overlapping case labels is a trap worth naming.

### J26 · "Failed to fetch", and a merchant sent to re-shoot good photos
Onboarding step 3 showed **"That didn't work — Failed to fetch"** above a button
offering to *try different inputs*.

I could not reproduce the failure itself: the endpoint answered in **1.5s** for
text, **3s** for one photo, **12.4s** for six. The likeliest cause was the server
being restarted mid-request during development — the browser hands back a raw
`TypeError: Failed to fetch` when a connection dies, and the page printed it
verbatim.

**The message was the real bug, and it was worse than the crash.** A shopkeeper
reads *"that didn't work"* next to *"try different inputs"* as **my photos were
no good**, and goes to re-shoot them. Nothing was wrong with the photos; the
photos were already saved on the server; and the only useful action was to press
the same button again.

**Fix:** the request is now bounded (four minutes, longer than the slowest
measured run) and a connection failure is told apart from a refusal. Losing the
connection and spending the model quota both say *"nothing you sent has been
lost — your photos and notes are saved"* and offer **Try again**. Only a genuine
refusal of the input sends them back to change it. Verified against all three
failure shapes, and against the claim that matters: the inputs really are still
on the server, so Try again resumes rather than restarting.

### J27 · A prompt about photographs, handed no photographs
Chasing the above, a shopkeeper who typed *"Butter biscuits 40 rupees ten
packets. Masala chai powder 120 rupees five packets."* and uploaded nothing got
back a store summary that named **both products** — and a catalog with **zero**.

The main extraction prompt is built entirely around looking: *"every distinct
product you can SEE in the photos"*, *"if there are three photos of goods, there
are at least three products"*, *"if you can see goods, there are products"*.
Hand it no images and every instruction in it is about something that is not
there. There was already a `TEXT_ONLY_SYSTEM` written for a related case — and a
comment above it describing this exact failure — but it is only reachable from
the rate-limit **catch** branch, so the no-photos path never saw it.

**Fix:** a `WORDS_ONLY_SYSTEM` for when words are the whole input, saying so
plainly and that they are enough. Deliberately not reusing `TEXT_ONLY_SYSTEM`,
which opens with *"their photos could not be looked at"* — untrue here, and an
invitation to hedge about missing evidence.

```
before   0–1 products, non-deterministically
after    2 products, correct prices and stock, three runs out of three
```

**The lesson:** a prompt is code with a precondition. This one's was "there are
images", it was never stated, and nothing checked it.

---

## K · External services

### K1 · Razorpay rejected the standard test card
**Fix:** the documented test flow for this account, and UPI test mode.

### K2 · A real `payment_id` cannot be created server-side
It is created by Checkout, in a browser, by a person. **Fix:** the CLI demo
stops at the order and says so rather than fabricating one — *"the CLI cannot
produce a payment_id, and will not pretend to."*

### K3 · The webhook returned 503 where it meant 401
Found by the audit script. *"I cannot establish that this is you"* is an
authentication failure, not an outage — and a 503 invites a retry that will fail
identically. **Fix:** 401.

### K4 · Twilio's sandbox rejected every message
Error `63015`, because the app was sending to `+919000000002` — a seed
*placeholder* that does not exist. **Fix:** a `DEMO_WHATSAPP_NUMBER` override
read from `.env`. Deliberately not written into `data/merchants.json`: that file
is tracked in git, and a personal phone number committed for one demo outlives
the demo.

### K6 · "Wait at most 25 seconds" meant 218
`maxWaitSeconds` capped each individual sleep, not the call. With four retries
allowed, a caller asking to wait at most 25 seconds could sit through five of
them — a shopper's question was measured taking **218 seconds** to come back,
against a setting whose own comment says a demo that freezes for sixty reads as
broken.

**Fix:** one absolute deadline for the whole call, checked before every wait and
every retry. Verified in the audit against a call that 429s forever: it gives up
after 10.5s of an allowed 12. Every caller that passes this has a deterministic
fallback that answers instantly and says it is being used, so giving up early is
strictly better than arriving late.

### K7 · "The requested URL was not found" — about a URL that was found
Two of the six probed Razorpay products came back:

```
⛔ QR Codes       GET /payments/qr_codes  → 400: The requested URL was not found on the server.
⛔ Smart Collect  GET /virtual_accounts   → 400: The requested URL was not found on the server.
```

Read at face value that says we called the wrong URL — and it is the one thing
it cannot mean. The base URL and both paths are the documented ones, and
`/payment_links`, `/invoices`, `/settlements` and `/orders` all answer 200
through the same helper, with the same auth header.

**The two cases are distinguishable, and this is the test:**

```
GET /definitely_not_a_real_product  → 404  {"message":"no Route matched with those values"}
GET /payments/qr_codes              → 400  BAD_REQUEST_ERROR · "The requested URL was not found…"
```

A path that does not exist is refused by the **gateway in front of** Razorpay's
API and never reaches it — that is the 404. A path that *does* exist but belongs
to a product the account has not activated gets through the gateway and is
turned away by the **application** — that is the 400. So a 404 is our bug and
this 400 is an account setting, and the panel was reporting them identically.

**Fix:** the probe classifies rather than quoting. A 404 now says *"the path is
wrong on our side, not a setting on the account"*; this 400 says *"the route
exists — a wrong path answers 404 — so this is a product not activated on the
account rather than a bad call."* Three cases are checked in `scripts/audit.ts`.

**The lesson is about error messages, not Razorpay.** A vendor's error string is
written for the vendor's most common case, not for yours; passing it through
unread makes their guess about what went wrong into your product's claim. The
five seconds it takes to call a deliberately-wrong path tells you more than the
message does.

### K8 · A webhook failure that said "[object Object]"
Firing a signed `payment.captured` at a real order, the endpoint verified the
signature, reached settlement, and came back with:

```json
{"error":"[object Object]"}
```

Nothing was logged server-side either. The **Razorpay SDK rejects with a plain
object** — `{ statusCode, error: { code, description } }` — not an `Error`, so
the codebase's standard `err instanceof Error ? err.message : String(err)`
rendered it as the literal type name. No status, no code, nothing to look up.

**It matters more here than anywhere else in the codebase.** Razorpay *retries*
a webhook that does not return 2xx, so an unreadable failure is one that repeats
on a schedule, silently, for as long as they keep trying.

**Fix:** `describeThrown()` in `payments/gateway.ts`, which knows the SDK's shape
and falls back to `JSON.stringify` before it falls back to `String`. Applied at
all **16** sites that turned a thrown value into a message, and the webhook now
logs the transaction and order id alongside it:

```
{"error":"Razorpay 400 · BAD_REQUEST_ERROR · The id provided does not exist"}
[webhook] txn_mtk775tt (order order_TXCerVGEcTl1Dr) failed: Razorpay 400 · …
```

The underlying refusal was **correct** — the test payment id did not exist at
Razorpay, and the settlement path will not take a payment id on faith. That was
never in doubt; whether anyone could find out was.

### K5 · A new API key did not reset the quota
Groq's token-per-day limit is **per organization**, not per key — `Limit
200000, Used 199787`. Vision costs ~5–6k tokens a call, so roughly 35 storefront
extractions a day. **Fix:** OCR runs locally and unmetered, and a spent vision
quota now degrades to a text-only extraction from the OCR text and the
merchant's own words rather than failing.

---

## L · Mistakes I made, and what they cost

Kept in because they were the most instructive.

### L1 · I broke a working page while fixing another
An inverted Python slice made a string replacement **prepend the agent overlay
before `<!doctype html>`**, breaking the whole document. `node --check` missed it
because it only extracted the `<script>` block. **Fix:** restored from git, redone
with line-based splicing plus a whole-document structural check — doctype
present, one `</body>`, balanced sections, no duplicate ids. That check has since
caught two further faults before they shipped.

### L2 · My own de-duplication caused D1
The empty `GROQ_MODEL=` that produced `404 the model \`\` does not exist` was
introduced by me tidying `.env`.

### L3 · I misread my own test output
The flyer extraction appeared to return null prices. I was about to treat it as
a pipeline bug; the schema field is `price_value`, and my test script was reading
`price.value`. The pipeline had been correct the whole time. **Lesson:** verify
the probe before believing what it says about the system.

### L4 · I left a server running and broke the user's `npm run serve`
`EADDRINUSE :::3000`, from my own background test process.

---

## What actually worked

Four practices did nearly all the useful work:

1. **Replay instead of predict.** The price curve reruns real buyers through the
   production negotiation engine. It cannot promise a sale the engine would
   refuse, and every point on it can be audited against the buyers behind it.
   The same rule governs the seeded dataset: outcomes are *played* by the engine,
   never written — otherwise the curve would have been fitting its own fiction.
2. **Make the model prove it looked.** Every agent answer shows its tool calls.
   An assistant that produced the same sentence without looking reads
   identically on screen, which is exactly why the trail is visible.
3. **A failure is not an empty result.** The single most dangerous line in the
   project was a model saying "your order list is empty" because a lookup had
   crashed.
4. **An audit that re-derives the claims.** `scripts/audit.ts` checks 60 claims
   against the running system and fuzzes the negotiation invariants over 500
   randomised policies. It found the webhook status-code bug. It is the reason
   "the agent never pays above its ceiling" is a checked statement rather than a
   confident one.

---

*Part 1 of `docs/BUILD_LOG.md` describes what was built. `docs/PHOTO_GUIDE.md`
carries the measured OCR guidance that came out of section F.*
