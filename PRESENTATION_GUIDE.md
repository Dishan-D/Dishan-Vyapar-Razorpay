# Presentation & Submission Guide
### Razorpay AI Buildathon — Vyapar-to-Agent

This covers the 5-minute pitch video, the public GitHub repo, and the "what broke, and how you got out" answer — the deliverable the reviewers read **first**, per the Buildathon's own form description.

---

## 1. What judges are actually scoring (keep this pinned while you edit)

- **Problem taste** — did you pick something that actually matters?
- **Build quality** — does it run, is it structured, would you trust it?
- **AI judgment** — the right tool in the right place, and where you chose *not* to use one.
- **Failure recovery** — what broke, and what you did about it.

Every section below maps back to one of these four.

---

## 2. Five-minute video structure (target: 4:30–5:00, don't run over)

**0:00–0:30 — The problem, stated with numbers, not adjectives**
Don't open with "AI agents are changing commerce." Open with the specific, sourced gap:
> "65 to 90 million Indian merchants take UPI payments through a QR code. They have no website, no catalog, no API. Every AI shopping agent protocol — Google's, OpenAI's — requires structured product data to even see a merchant. These merchants are invisible to the agent economy that's already live."
One slide, the number, done. This is your **problem taste** signal — show you found something real and specific, not generic.

**0:30–1:15 — Why the obvious fix doesn't work**
Briefly show that "just build them a catalog" tools already exist (WhatsApp AI catalog makers) but solve the human-facing version only — pretty photos for people to scroll, not machine-queryable data an agent can transact against. This is where you plant the second insight: even if you structure the catalog, existing protocols assume **fixed prices**, and ~85% of India's retail runs on **negotiated** prices. Two gaps, not one. This is where "novel" gets earned on screen.

**1:15–3:30 — Live demo, not slides**
This is the highest-weight section. Walk one transaction straight through, live:
1. Show the raw input (a product photo + a voice-note transcript) — 10 seconds.
2. Show the structured catalog item it produces, including the confidence score — this proves Stage 1 works and is honest about uncertainty.
3. Run the negotiation — show the buyer-agent making an offer, the merchant-agent countering, landing on an agreed price within the bounded policy. Narrate that the *number logic is deterministic*, not left to an LLM's judgment — this is your **AI judgment** signal: you're showing exactly where you trusted the model and where you didn't.
4. Trigger the Razorpay test-mode payment — show the real order/payment ID.
5. Confirm fulfillment.
6. Pull up the audit view — the full 4-mandate signed chain, one screen, all green checkmarks.
Keep narration tight: name what's happening, not why it's impressive — let the working software be impressive.

**3:30–4:15 — The failure, shown, not just described**
Trigger your chosen failure case live (see §4 below) and show the system handling it correctly — refusing to guess, or walking away from a bad negotiation, or blocking a payment on an unverified mandate. Judges specifically score this; don't bury it in a bullet point, show it happening.

**4:15–5:00 — Why now, and what this unlocks**
Close with the adoption data (Gartner/Shopify AI traffic growth, Razorpay's own live pilots) reframed as: *"this wave is already here — the only question is whether 90 million merchants get to participate in it."* End on the audit chain screenshot or a one-line summary of what you built, not a personal statement about the team.

**Production notes:**
- Unlisted YouTube/Loom link is fine per the form.
- Screen-record the actual running app; don't use mockups or slides pretending to be the product.
- If any step depends on a live LLM call that could misfire on camera, use one of your pre-seeded demo scenarios (see Milestone F in the project context doc) rather than risking it live.

---

## 3. The GitHub repo (public, per the form requirement)

- **README first screen** should answer, in this order: what it is (one sentence), the problem + the two numbers that justify it, a GIF or screenshot of the audit chain output, how to run it locally, and a short "what broke" section (can be a shorter version of your written answer, see below).
- **Structure the repo the way you structured the pipeline** — folders per stage (`/mandates`, `/negotiation`, `/payments`, etc.) so a reviewer skimming the code can map it to your pitch without reading everything.
- **Include the sample data** used in your demo (`/data/sample_products`) so the repo is runnable, not just readable.
- **Commit history matters more than a clean single commit** — a visible trail of incremental work (even messy) reads as "this was actually built," not assembled at the last minute.
- Don't over-engineer the frontend at the expense of backend substance — judges are told explicitly to weigh "does it run, is it structured, would you trust it," not visual polish.

---

## 4. "What broke, and how you got out" — this is read first, weight it accordingly

Pick **one real, specific, technical failure** you actually hit while building — not a hypothetical, not a soft one ("we ran out of time"). Strong candidates from this project's own design, in order of how good a story they make:

1. **A cryptographic verification bug** — e.g., you initially hashed the mandate payload before canonicalizing the JSON, so two logically-identical mandates produced different hashes and verification silently failed. This is a great story because it's specific, technical, and shows you actually understand what you built rather than gluing together library calls.
2. **The negotiation loop not terminating correctly** — e.g., your counter-offer formula converged too slowly and could theoretically loop past `max_rounds` without resolving; you caught it, added the hard round cap, and handled the "no_deal" path explicitly instead of leaving it undefined.
3. **A gating failure you found by testing your own gate** — e.g., you discovered your code would call Razorpay's Order API *before* mandate verification completed in an early version (a real security bug), caught it by deliberately testing a tampered mandate, and fixed the ordering.

**Format for the written answer (keep it tight, 150–250 words):**
- What broke (specific, technical, one paragraph).
- How you found it (did you test for it deliberately, or did it fail live and you traced it back?).
- What you changed, and why that fix is the *right* fix, not just a patch.
- One sentence on what it taught you about the system as a whole.

Do **not** write this retroactively as a nice story with no rough edges — reviewers read hundreds of these and a suspiciously clean answer reads as fabricated. Real failure stories have a slightly awkward middle ("I assumed X, which turned out to be wrong because Y").

---

## 5. Application form checklist (12 items, ~15 minutes to fill once everything above is ready)

**About you:** full name, college, graduation year, in-person Bangalore confirmation, 6 vs. 12 month choice, resume.
**About the build:** track (01), project name, one-line "what it solves," public GitHub URL, 5-min unlisted video URL, the "what broke" answer from §4.

Have the video uploaded and repo pushed *before* you sit down to fill the form — don't fill it mid-build.
