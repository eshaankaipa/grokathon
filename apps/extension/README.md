# xmarket Browser Extension

Manifest V3 Chrome extension that recognizes canonical xmarket URLs on X and renders a prediction-market card inline.

## Current behavior

- Watches X's dynamically rendered timeline and conversation pages
- Detects canonical URLs in both links and raw tweet text
- Recognizes `https://xpred.aidenhuang.com/market/{marketId}`
- Fetches canonical market data from the Supabase `markets` table through a background worker
- Displays an explicit error when a slug is missing or Supabase is unavailable
- Injects UI inside Shadow DOM to isolate it from X's styles
- Supports authenticated YES/NO purchases using the user's shared demo-credit wallet
- Stores the configured market origin using Chrome sync storage
- Connects the extension to the website's active Supabase account with a single-use token
- Keeps email/password authentication as a fallback
- Stores the Supabase session in extension-local storage and exposes only public user details to cards

Authenticated YES/NO purchases execute through the same atomic Supabase LMSR function used by the website.

## Build and load

```bash
cd apps/extension
npm run build
```

Then open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select `apps/extension/dist`.

The canonical market origin and Supabase publishable configuration live in `src/config.js`. The default market origin is `https://xpred.aidenhuang.com`.

## Account setup

The extension opens the xmarket website through `chrome.identity.launchWebAuthFlow`. After explicit confirmation, the signed-in website creates a short-lived, single-use token that the extension exchanges for its own Supabase session.

1. Set the Supabase project URL, publishable key, and market website in `src/config.js`, then rebuild the extension.
2. Click **Continue on website** and approve the connection.

Email/password authentication remains available in the popup as a fallback.

Only the publishable key is stored in Chrome sync settings. The session is stored in Chrome local extension storage. Never put a Supabase secret key in the extension.

## Test tweet

The public test tweet is:

https://x.com/xmarket/status/2086203820150034713

Market data always comes from Supabase. There are no extension-local market fixtures.
