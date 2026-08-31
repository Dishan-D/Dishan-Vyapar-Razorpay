# Groq token limits, and how the pipeline lives inside them

Measured on the free `on_demand` tier, August 2026. Re-measure if the tier
changes — the numbers below drive real pacing decisions.

## What the limits actually are

```
x-ratelimit-limit-requests:  1000
x-ratelimit-limit-tokens:    8000     ← per minute, and the one that bites
```

| Call | Measured cost |
|---|---|
| One product photo + voice note | **~2,074 tokens** |
| Voice note only, no photo | ~700–900 tokens |
| Agent intent parse | **177 tokens** |
| Negotiation phrasing | ~300–600 tokens |

**Image size does not matter.** A 191 KB photo and a 640px downscale of it both
cost exactly 1,820 prompt tokens — Groq bills images at a flat rate. Compressing
them saves bandwidth and nothing else, so the pipeline sends them as they are.

## What that means in practice

A full 15-item catalog needs roughly **19,400 tokens**: five photos at ~2,074 and
ten text-only items at ~900. Against an 8,000/minute ceiling that is about
**2.5 minutes minimum**, no matter how the run is arranged.

Fired off without pacing it fails partway with:

```
429  Rate limit reached ... on tokens per minute (TPM):
     Limit 8000, Used 7977, Requested 2074. Please try again in 15.38s
```

## How the pipeline handles it

[`src/llm/ratelimit.ts`](../src/llm/ratelimit.ts) reads
`x-ratelimit-remaining-tokens` and `x-ratelimit-reset-tokens` off every response
and waits when the next call would not fit. On a 429 it honours `retry-after`.

**One budget per process.** Extraction, negotiation phrasing and the agent's
intent parsing all draw on the same allowance, so they share one governor —
separate ones would each have to rediscover the limit by hitting it.

**Batch waits; interactive does not.** A catalog build is happy to sit out a
minute and reports each pause. An interactive call gives up after 3 seconds and
falls back to its deterministic path, because a demo that freezes for a minute
reads as broken. The fallback is never silent: the reason appears in the agent
trace, in the server log, and as a warning row in the UI.

```
⏸  79 tokens left, need ~2200 — pausing 60s
✓   6/15  kurta_white  63s
```

## Practical notes

- `npm run milestone-b -- --live` takes **~3 minutes**. That is the rate limit,
  not a hang. It prints progress per item.
- Run it **once** and commit the result: the server reads `data/catalog.json`
  and makes no model calls at boot.
- A partial run is still usable. Items that fail fall back to their fixture
  individually, and the catalog records the mix (`sourceCounts`) rather than
  claiming to be fully live.
- Interactive use is cheap. Fourteen back-to-back agent runs all completed on
  Groq in under 800 ms each — 177 tokens apiece never troubles the ceiling.
