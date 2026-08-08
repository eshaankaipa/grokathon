# xmarket

An X-native prediction-market experience built for the xAI Hackathon. The website is the canonical surface for discovering markets, understanding their rules, and building YES/NO positions.

## Run locally

```bash
npm install
npm run dev
```

The development server opens on `http://localhost:5175` by default to match the Chrome extension's local market origin.

Copy `.env.example` to `.env.local`, then set the Supabase project URL and publishable key. Never place a Supabase secret key in this app: Vite environment variables are compiled into the browser bundle.

### Authentication setup

The app supports email magic links through Supabase Auth and can securely connect the browser extension to the same account.

1. Enable email authentication in Supabase.
2. Under **Authentication → URL Configuration**, set the deployed website as the Site URL and allow the local development URL (normally `http://localhost:5175`) as a redirect URL.
3. Apply the root-level Supabase migration so new users receive a profile and demo balance.
4. Deploy the `extension-auth-token` Edge Function for website-to-extension authentication.

## Current scope

- Market discovery with trending, recent, and closing-soon views
- Canonical market pages at `/market/{marketId}`
- Authenticated YES/NO purchases through the LMSR automated market maker
- Stripe Sandbox wallet top-ups for demo credits
- Live balance, positions, execution prices, and price history from Supabase
- Demo portfolio and open-position view
- Responsive desktop and mobile layouts

Market purchases spend demo credits only. Stripe purchases add demo credits to the wallet and never create positions directly.
