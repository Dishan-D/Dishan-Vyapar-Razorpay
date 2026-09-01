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
> failure into "your order list is empty".
>
> Four habits caught these. **Replay instead of predict**: the price curve reruns
> real buyers through the production negotiation engine, so it cannot promise a
> sale the engine would refuse. **Make the model prove it looked**: every agent
> answer shows the tool calls behind it, so an answer with no lookups is visibly
> an answer with no evidence. **Distinguish a failure from an empty result** — a
> tool that breaks now says so in words the model is instructed on. And a
> **30-claim audit script** that re-derives every headline claim from the running
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
4. **An audit that re-derives the claims.** `scripts/audit.ts` checks 30 claims
   against the running system and fuzzes the negotiation invariants over 500
   randomised policies. It found the webhook status-code bug. It is the reason
   "the agent never pays above its ceiling" is a checked statement rather than a
   confident one.

---

*Part 1 of `docs/BUILD_LOG.md` describes what was built. `docs/PHOTO_GUIDE.md`
carries the measured OCR guidance that came out of section F.*
