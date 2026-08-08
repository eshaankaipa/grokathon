# xmarket

Prediction markets built directly into conversations on X.

## Repository structure

```text
apps/
  web/       Market discovery, LMSR trading, wallet, and portfolio
  extension/ Chrome extension for inline markets on X
supabase/
  migrations/ Shared database schema and Row Level Security policies
guide.md     Existing X posting bot operations guide
```

The bot and Chrome extension will live in their own project folders as they are added. Market state will ultimately come from one shared backend rather than being duplicated across applications.

Supabase is the canonical backend. Browser clients use only the publishable key and are constrained by Row Level Security. Secret keys belong only in protected server environments and must never be committed or shipped to the browser.

## Stripe Sandbox credit purchases

Stripe Sandbox purchases add demo credits to the authenticated user's wallet. Stripe never creates market positions. A signed webhook credits the wallet atomically, and the unique Checkout Session ID prevents webhook retries from adding credits twice. YES/NO positions are purchased separately with those credits through the LMSR database function.

Required Supabase Edge Function secrets:

```text
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
SITE_URL=http://localhost:5175
```

Deploy in this order:

```bash
npx supabase login
npx supabase link --project-ref fxoiyujqvfnclobriker
npx supabase db push
npx supabase secrets set STRIPE_SECRET_KEY=sk_test_... SITE_URL=http://localhost:5175
npx supabase functions deploy create-checkout-session
npx supabase functions deploy stripe-webhook --no-verify-jwt
```

Create a Stripe Sandbox webhook destination pointing to:

```text
https://fxoiyujqvfnclobriker.supabase.co/functions/v1/stripe-webhook
```

Subscribe it to `checkout.session.completed` and `checkout.session.async_payment_succeeded`, then store the generated signing secret:

```bash
npx supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_...
```

Do not put either Stripe secret in `apps/web/.env.local`; all Vite environment variables are exposed to the browser.

## Market trading

Markets use a binary LMSR automated market maker. Authenticated users spend only their `profiles.demo_balance` credits. One security-definer Postgres function locks the market and wallet, calculates shares, writes the trade and position, adjusts the probability and volume, records price history, and deducts the balance atomically. A client order UUID prevents duplicate orders.

Market resolution is service-role-only. Winning shares pay one demo credit each into the user's wallet.

## Market website

```bash
cd apps/web
npm install
npm run dev
```
