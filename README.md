# Vyapar-to-Agent

Makes UPI-only Indian merchants transactable by an AI buyer-agent, end to end — auto-generated agent-readable catalog, **bounded price negotiation**, gated Razorpay test-mode payment, and a cryptographically signed 4-mandate audit chain from first contact to confirmed handover.

> Razorpay AI Buildathon — Track 01 (AI Growth & Agentic Commerce)

## The gap

65–90 million Indian merchants accept payment through a UPI QR code and nothing else: no website, no catalog, no API. Every live agent-commerce protocol — Google's AP2, OpenAI's ACP, Google UCP — requires a structured product feed before an agent can even *see* a merchant. And all of them assume a fixed price, while ~85% of India's retail runs through kirana stores where **negotiation is the norm**, not the exception.

Two gaps, not one. This builds what has to exist before any agentic-commerce feature works for that segment.

See [PROJECT_CONTEXT.md](PROJECT_CONTEXT.md) for the full spec: pipeline, schemas, and build sequence.

## Status

| Milestone | Scope | State |
|---|---|---|
| **A** | Mandate chain in isolation — sign, hash-link, verify, tamper-test | ✅ done |
| B | Structuring agent (photo + voice-note → catalog, with confidence gating) | not started |
| C | Bounded negotiation agent | not started |
| D | Wire negotiation → mandates → Razorpay test-mode order | not started |
| E | Fulfillment loop + audit view | not started |
| F | Demo frontend + pre-seeded scenarios | not started |

## Run Milestone A

No API keys, no network, no database — it generates ephemeral ES256 keys and runs entirely in-process.

```bash
npm install
npm run milestone-a
```

It builds a full `intent → cart → payment → fulfillment` chain, verifies every signature and hash link, then runs eight tamper tests: seven mutations that **must** be rejected (flipped signature bytes, a price changed after signing, a real signature transplanted onto a re-priced cart, a re-pointed hash link, an inflated capture amount, a missing merchant signature, a hole in the middle of the chain) and one control that **must** still pass (reordering an object's keys — that's not tampering, and canonicalization has to absorb it).

## How the chain works

- **Signing** — ES256 JWS (`jose`), three separate keypairs: `buyer_agent`, `merchant`, `platform`. One backend plays all three roles for the hackathon, but the keys are genuinely distinct, because "the merchant signed this" is only evidence if it is distinguishable from "the buyer's agent signed this."
- **Canonicalization** — every hash and signature is taken over RFC 8785-style canonical JSON ([`canonical.ts`](src/mandates/canonical.ts)), never raw `JSON.stringify`. Key order is not content; if it changed a hash, the chain would break for reasons unrelated to tampering.
- **Ordered signatures** — on a cart mandate the merchant signs the bare cart, then the buyer-agent signs the cart *including the merchant's signature*. That nesting is what makes two signatures a binding between two parties instead of two unrelated assertions.
- **Verification checks two things per signature**, not one: that the JWS verifies against the expected role's key, *and* that the bytes it signed are byte-identical to the mandate in front of us. Skipping the second check would let a valid signature over some other payload pass — the token verifies while saying nothing about this mandate.
- **Hash links** cover the fully signed mandate, so a link commits to who signed as well as to what they signed.
- **A partial chain is a legitimate state.** A transaction with no fulfillment mandate reads `payment_confirmed_awaiting_fulfillment` and is never auto-marked delivered. A gap in the *middle* of the chain, however, is a failure.

## Layout

```
src/mandates/
  canonical.ts   deterministic JSON + SHA-256
  schema.ts      all 4 mandate types, catalog item, negotiation policy
  keys.ts        the three signing identities
  sign.ts        sign / verify, and what exactly each signature covers
  chain.ts       builders, hash-linking, whole-chain verification
scripts/
  milestone-a.ts proof + tamper tests
```

## What's real vs. simulated

**Real:** all signing and verification, canonicalization, hash-linking, chain validation. This is the credibility core — there is no mocked `"signature": true` anywhere.

**Simulated (and stated plainly rather than hidden):** merchant and buyer-agent run as one backend with separate keys; voice notes start from pre-transcribed text rather than live speech-to-text.

## What broke, and how I got out

<!-- TODO: write this from what actually happens while building B–F. It gets read
     first, and a clean story reads as fabricated. Keep the awkward middle. -->
