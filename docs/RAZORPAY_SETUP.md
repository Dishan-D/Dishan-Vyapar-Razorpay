# Razorpay test mode — getting real order and payment IDs

Right now the pipeline runs on a simulated gateway: everything else is real, but
order and payment IDs are prefixed `sim_`. This is how to replace them with real
test-mode ones.

Nothing here costs money and nothing here needs KYC. Test mode is available on a
fresh Razorpay account before business activation.

## 1 · Get the keys

1. Sign up or log in at **dashboard.razorpay.com**.
2. Switch the dashboard into **Test Mode** — there is a test/live toggle in the
   dashboard chrome. Every screen and every key is scoped to whichever mode you
   are in, so confirm it says Test before generating anything.
3. Go to **Account & Settings → API Keys** (older layouts: *Settings → API Keys*)
   and click **Generate Test Key**.
4. You get two values:
   - **Key ID** — looks like `rzp_test_ABC123xyz`. Not secret; the browser sees it.
   - **Key Secret** — shown **once**. Download or copy it now; if you lose it you
     regenerate the pair, you cannot re-read it.

## 2 · Put them in `.env`

```bash
cp .env.example .env
```

```
RAZORPAY_KEY_ID=rzp_test_ABC123xyz
RAZORPAY_KEY_SECRET=your_secret_here
```

That is the whole change. `gatewayFromEnv()` in [src/payments/gateway.ts](../src/payments/gateway.ts)
picks the real gateway up automatically, and refuses to start on a key that does
not begin `rzp_test_` — a live key on a demo path would move real money.

Check it took:

```bash
npm run serve
# → Vyapar-to-Agent listening on http://localhost:3000  (gateway: razorpay)
```

## 3 · What works immediately, and what doesn't

**Orders are real right away.** `npm run demo` and the UI will create genuine
test-mode orders and show genuine `order_...` IDs. That is a real API call to
Razorpay, authenticated with your key, and you can see each one appear in the
dashboard under Transactions → Orders.

**Payments are not**, and this is worth understanding before you record. A
`payment_id` is created when someone actually pays — through Razorpay Checkout,
in a browser. Server-side code cannot conjure one, because there is nothing to
conjure: no card was entered and no UPI collect request was approved. So with
keys set but no Checkout step, you get a real order and then the capture call has
nothing to capture.

## 4 · Getting a real payment ID in the video

This is **built** — it just needs your keys to come alive. With
`RAZORPAY_KEY_ID`/`RAZORPAY_KEY_SECRET` set, the flow becomes two phases:

1. `POST /transactions` verifies the cart mandate, creates the order, and stops
   at `status: "awaiting_payment"`. No Payment Mandate yet — nothing has been
   paid, and signing one here would assert a capture that never happened.
2. The UI opens **Razorpay Checkout** with that order.
3. Checkout's callback goes to `POST /transactions/:id/settle-payment`, which
   verifies `razorpay_signature` — HMAC-SHA256 of `<order_id>|<payment_id>` under
   your key secret — against the order *this server* authorized, before believing
   any of it. Only then is the Payment Mandate signed.

That last check matters more here than in an ordinary integration: the Payment
Mandate is evidence. Signing one from an unverified browser callback would put
the platform's signature on a claim it never confirmed. `npm run milestone-d`
exercises the boundary against a stand-in gateway with the same signature
scheme — a missing signature, a forged one, and a valid signature reused for a
different payment id are all refused; only the genuine callback settles.

**Pay with a test instrument** in the Checkout window:

- Card `4111 1111 1111 1111`, any future expiry, any CVV, any name.
- Or UPI, using the test VPA `success@razorpay` (and `failure@razorpay` to
  demo the failure path).

Razorpay publishes the current list under Docs → Payments → Test Card Details;
check there if one of the above is rejected.

**One caveat, stated plainly:** the Razorpay half of this has never run against
the live test-mode API, because this machine has no keys. The order-creation and
signature-verification code is written against the SDK's own
`validatePaymentVerification`, and the verification logic is covered by the
milestone-d tests above — but the first end-to-end run with real keys is yours.
Budget ten minutes for it before you record, not two.

The CLI walkthrough (`npm run demo`) stops at `awaiting_payment` when real keys
are set, and says so, rather than pretending to produce a payment id it cannot.

## 5 · What to say in the video

Test mode is not a weaker version of the claim — it is the correct mode for a
demo, and saying so plainly is better than letting a judge wonder. "Razorpay test
mode, real API, real order ID" is a complete sentence. What you should not do is
show a `sim_` ID while narrating that a payment happened.
