# Setup and run

Everything runs with no credentials at all — the pipeline falls back to
fixtures, a simulated payment gateway, and an in-dashboard question queue. Each
key below turns one simulated thing into a real one.

```bash
npm install
npm run serve        # → http://localhost:3000
```

That is the whole minimum. The rest of this page is optional.

---

## What each key changes

| Key | Without it | With it |
|---|---|---|
| `GROQ_API_KEY` | Hand-authored fixtures | Real vision extraction, Whisper voice notes, live intent parsing |
| `RAZORPAY_KEY_ID` / `_SECRET` | `sim_` gateway | Real test-mode orders and Checkout |
| `RAZORPAY_WEBHOOK_SECRET` | Checkout callback only | Razorpay's own server confirms the capture |
| `TWILIO_*` | Questions queue in the dashboard | Questions arrive on a real phone over WhatsApp |

Nothing breaks when one is missing. The header on every page shows which mode
you are in.

---

## 1 · Razorpay webhook (~10 minutes)

The Checkout callback already works without this. The webhook is Razorpay's
server telling yours that money moved — a stronger claim, and a better line on
camera than a browser relaying it.

### Test it locally first — no dashboard, no tunnel

```bash
npm run milestone-l
```

This submits four bad webhooks (no signature, a forged one, a valid signature
for a different body, a body altered after signing) and asserts all four are
refused and none wrote a mandate — then settles a genuine one. If that passes,
the endpoint is correct and only the plumbing remains.

### Then wire the real one

**Start a tunnel** — Razorpay must be able to reach your machine:

```bash
ngrok http 3000
```

Copy the `https://` forwarding URL it prints (e.g. `https://a1b2c3.ngrok-free.app`).

**In the Razorpay Dashboard** — make sure you are in **Test Mode** —
go to **Account & Settings → Webhooks → Add New Webhook**:

| Field | Value |
|---|---|
| Webhook URL | `https://<your-ngrok-url>/webhooks/razorpay` |
| Secret | Invent one, e.g. `vyapar_whsec_2026`. Copy it exactly. |
| Active Events | tick **`payment.captured`** only |

**Put the same secret in `.env`:**

```
RAZORPAY_WEBHOOK_SECRET=vyapar_whsec_2026
```

**Restart the server** (it reads `.env` at boot):

```bash
npm run serve
```

### Confirm it works

Either press **Send Test Webhook** in the dashboard, or complete a real
test-mode Checkout in the UI. Watch the terminal — a verified event settles the
transaction and appears in the merchant's live activity.

An unsigned or forged POST returns `401` and writes nothing. That is worth
demonstrating: `curl -XPOST <url>/webhooks/razorpay -d '{}'`.

**Two things that catch people out.** The ngrok URL changes every restart on the
free tier, so update the dashboard if you restart it. And the endpoint is
mounted *before* the JSON body parser on purpose — the HMAC must see the exact
bytes Razorpay signed, so do not "tidy" that ordering.

---

## 2 · Twilio WhatsApp sandbox (~10 minutes)

Without this, a merchant's clarification questions queue in their dashboard and
the loop closes there. With it, the question arrives on a real phone and they
answer by text — which is a considerably better shot, and it is the one input
mechanism this segment actually uses daily.

### Join the sandbox

1. Sign up at **twilio.com** (free trial is enough).
2. Console → **Messaging → Try it out → Send a WhatsApp message**.
3. It shows a sandbox number and a join code like `join <two-words>`.
4. From your phone's WhatsApp, message that number with exactly that code.
   You should get a confirmation back.

### Copy three values into `.env`

From the Console dashboard:

```
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=your_auth_token
TWILIO_WHATSAPP_FROM=whatsapp:+14155238886
```

`TWILIO_WHATSAPP_FROM` is the sandbox number shown on that page — usually
`+14155238886`.

### Point inbound replies back at your server

In the same sandbox settings, set **"When a message comes in"** to:

```
https://<your-ngrok-url>/webhooks/whatsapp      (HTTP POST)
```

Same tunnel as the Razorpay webhook — one `ngrok http 3000` covers both.

### One thing you must do

The merchant personas ship with placeholder numbers
(`+919000000001` and so on). A question can only reach **your** phone if a
merchant's number is your phone. Edit `data/merchants.json` and put your own
number on whichever shop you will demo — Amma's is the one with the interesting
clarification:

```json
{ "merchant_id": "mer_amma", "whatsapp": "+91XXXXXXXXXX", ... }
```

Then `rm -f data/catalog.json && npm run milestone-b -- --fixtures` to rebuild,
and restart.

### Confirm it works

```bash
npm run milestone-k
```

Runs the whole loop against a recording stand-in — outbound questions, a reply
that resolves an item, a messy reply (`"Rs 60 vechuko"`), an unparseable one, and
an unknown number being refused. With Twilio configured, the same questions go
to your phone at boot.

Reply with just a number (`110`). The item goes live and the dashboard updates.

---

## 3 · Anything else?

**No other credentials exist.** `ANTHROPIC_API_KEY` is an alternative to Groq,
not an addition — you already have Groq and it covers extraction, transcription
and intent parsing.

Two optional settings:

```
# Only if you want a stable webhook URL in generated QR codes
PUBLIC_BASE_URL=https://a1b2c3.ngrok-free.app

# Only to override the model defaults
# GROQ_MODEL=qwen/qwen3.8-27b
```

**Do not add an empty line for an override you are not using.** A bare
`GROQ_MODEL=` sets the model to the empty string; the code now treats blank as
unset, but commented-out is still the clearer habit.

---

## Running it

### The five-minute demo

```bash
npm run serve        # → http://localhost:3000
```

| | Screen | Beat |
|---|---|---|
| 1 | `/` | The loop, and who decides each step |
| 2 | `/onboard.html` | A shop set up from photos and a voice note |
| 3 | `/shop.html` | An agent buys, under a verified authority |
| 4 | `/merchant.html` | Confirm handover, then the revenue recommendation |
| 5 | `/market.html` | The network, lighting up as it happens |

Open `/merchant.html` on a second screen — the clarification queue and orders
update live while you drive from the first.

### Everything else

```bash
npm run demo                       # the same walkthrough in the terminal
npm run milestone-a … -l           # 11 proof scripts, each self-checking
npm run milestone-b -- --live      # real Groq extraction (~3 min, paced)
npm run milestone-b -- --fixtures  # reclaim a repeatable catalog
npm run typecheck
```

### Between takes

```bash
rm -f data/vyapar.db*    # clears sales, orders, answered questions
npm run serve
```

**Do not delete `data/keys.local.json`.** Regenerating the signing keys makes
every previously signed chain unverifiable, which looks exactly like tampering.

### Payment details for the demo

Use **UPI `success@razorpay`** — no card fields to type on camera.
`failure@razorpay` demonstrates a failed payment.

If you prefer a card, use a **domestic** one: `4100 2800 0000 1007`. The generic
`4111 1111 1111 1111` is classified international and test accounts have that
disabled — it will be rejected, and nothing is wrong when it is.

---

## Quick health check

With the server running:

```bash
curl localhost:3000/health
```

```json
{
  "gateway": "razorpay",          // "simulated" without keys
  "catalog_provider": "groq",     // "fixture" without a live run
  "clarification_channel": "whatsapp",  // "dashboard" without Twilio
  "transcription": "whisper-large-v3-turbo"
}
```

Those four fields are the whole configuration story. Whatever they say is what
the demo will actually do.
