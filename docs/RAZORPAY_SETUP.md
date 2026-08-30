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

## 4 · If you want a real payment ID in the video

This needs a Checkout step in the frontend, which is **not built yet** — the
current UI creates the order and the mandate in one call. The change is:

1. **Split the transaction endpoint.** `POST /transactions` stops at the order:
   verify the cart mandate, create the Razorpay order, return `order_id` with
   status `awaiting_payment`. No payment mandate yet — nothing has been paid.

2. **Open Checkout in the browser** with the returned `order_id`:

   ```html
   <script src="https://checkout.razorpay.com/v1/checkout.js"></script>
   ```
   ```js
   new window.Razorpay({
     key: RAZORPAY_KEY_ID,        // publishable; serve it from an endpoint
     order_id: orderId,
     amount: amountPaise,
     currency: "INR",
     name: "Vyapar-to-Agent",
     handler: (res) => settle(res),  // res has razorpay_payment_id,
                                     // razorpay_order_id, razorpay_signature
   }).open();
   ```

3. **Settle server-side.** A new `POST /transactions/:id/settle-payment` takes
   those three fields, verifies the signature *before* trusting any of it, and
   only then builds the Payment Mandate:

   ```ts
   import { validatePaymentVerification } from "razorpay/dist/utils/razorpay-utils.js";

   const genuine = validatePaymentVerification(
     { order_id, payment_id },
     razorpay_signature,
     process.env.RAZORPAY_KEY_SECRET!,
   );
   if (!genuine) throw new PaymentRefused(["Razorpay signature did not verify"]);
   ```

   That check matters more here than in an ordinary integration: the Payment
   Mandate is evidence. Signing one from an unverified browser callback would put
   the platform's signature on a claim it never confirmed.

4. **Pay with a test instrument** in the Checkout window:
   - Card `4111 1111 1111 1111`, any future expiry, any CVV, any name.
   - Or UPI, using the test VPA `success@razorpay` (and `failure@razorpay` to
     demo the failure path).

   Razorpay publishes the current list under Docs → Payments → Test Card Details;
   check it if one of the above is rejected.

## 5 · What to say in the video

Test mode is not a weaker version of the claim — it is the correct mode for a
demo, and saying so plainly is better than letting a judge wonder. "Razorpay test
mode, real API, real order ID" is a complete sentence. What you should not do is
show a `sim_` ID while narrating that a payment happened.
