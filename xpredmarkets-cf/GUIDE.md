# X Prediction Markets Bot — Guide

Automated poster for **[@XPredMarkets](https://x.com/XPredMarkets)**
Live site: **https://xpred.aidenhuang.com**

Play-money **binary prediction markets** on the same Worker (credits, constant-product AMM).

---

## Quick start (for someone you invite)

### What you need from Aiden

1. **Site URL:** `https://xpred.aidenhuang.com`
2. **Admin token** (password for posting + creating/resolving markets)

That’s it. You do **not** need X API keys.

For **trading** only: open the site → **Register** → save your user API key (shown once). No admin token required.

### Post from the website

1. Open https://xpred.aidenhuang.com
2. Paste the **admin token** into the Admin token field
3. Write your post (max 280 characters)
4. Optional: put a tweet ID in “Reply to” to thread a reply
5. Click **Post to X**

The token is stored in your browser’s `localStorage` (`xpred_admin_token`) on that device only.

### Trade from the website

1. **Register** with a display name → copy the API key (only shown once)
2. Key is stored as `xpred_user_key` in localStorage
3. **Markets** list loads open markets with YES probability bars
4. **Trade** — paste market id (or click one in the list), buy/sell YES/NO
5. Admins: **Create market** / **Resolve** with the admin token

### Post from the command line

```bash
export ADMIN_TOKEN='paste-token-here'

curl -sS -X POST 'https://xpred.aidenhuang.com/post' \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"text":"Hello from the bot"}'
```

**Reply to a tweet:**

```bash
curl -sS -X POST 'https://xpred.aidenhuang.com/post' \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"text":"following up","reply_to":"1234567890123456789"}'
```

**Success response:**

```json
{
  "ok": true,
  "id": "2086169359274397759",
  "text": "Hello from the bot",
  "url": "https://x.com/XPredMarkets/status/2086169359274397759"
}
```

### Read mentions

```bash
export ADMIN_TOKEN='paste-token-here'

# Live mentions of @XPredMarkets
curl -sS "https://xpred.aidenhuang.com/mentions?limit=10" \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# Live + save to cache
curl -sS "https://xpred.aidenhuang.com/mentions?limit=20&persist=1" \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# Cached only (no admin token)
curl -sS "https://xpred.aidenhuang.com/mentions/cached?limit=50"
```

### Mention → market (create or redirect)

When someone @mentions the bot, call the **wrapper** so a market is either **created** or **redirected** to an existing one.

| Route | What it does |
|-------|----------------|
| `POST /markets/from-mention` | One mention text → create **or** redirect |
| `POST /mentions/process` | Pull live X mentions, run wrapper on each |
| `GET /mentions/markets` | History of tweet → market links |

**Matching rules**

1. Same `tweet_id` already processed → always redirect to that market
2. Text contains `mkt_…` or `xpred.aidenhuang.com/markets/mkt_…` → redirect to that id
3. Open/locked market with same normalized question → redirect
4. Else → **create** new open market

Self-@ from the bot and bare `@bot` with no question are **skipped**.

```bash
export ADMIN_TOKEN='paste-token-here'

# Single mention → market
curl -sS -X POST "$BASE/markets/from-mention" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "text": "@XPredMarkets will BTC be above 100k by Friday?",
    "tweet_id": "1234567890",
    "author_username": "alice",
    "announce": false
  }'

# Poll X mentions and process (persist to D1 cache; optional reply on X)
curl -sS -X POST "$BASE/mentions/process" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"limit": 20, "persist": true, "announce": false}'

# History
curl -sS "$BASE/mentions/markets?limit=20" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

**Success shape** (`from-mention` / each `results[]` item):

```json
{
  "ok": true,
  "action": "created",
  "market_id": "mkt_…",
  "question": "will BTC be above 100k by Friday?",
  "url": "https://xpred.aidenhuang.com/markets/mkt_…",
  "og_image": "https://xpred.aidenhuang.com/markets/mkt_…/og.png",
  "reason": "new market from mention"
}
```

`action` is `created` | `redirected` | `skipped`.
Set `"announce": true` to reply on X with the market + OG links (needs a real `tweet_id`).

---

## Prediction markets (play-money)

### Credits model

| Concept | Detail |
|---------|--------|
| Currency | **Credits** — not real money |
| Signup bonus | New users get **1000 credits** |
| Engine | Constant-product AMM: `k = yes_pool × no_pool` |
| Price | `p_yes = no_pool / (yes_pool + no_pool)` |
| Buy | Spend credits → receive YES or NO shares; pool moves against you |
| Sell | Return shares → receive credits |
| Resolve YES/NO | Winning shares pay **1 credit each**; losers → 0 |
| Void | Refund **0.5 × shares** held (YES + NO), then clear positions |
| Default liquidity | `yes_pool = no_pool = 100` on create (min 10 each) |

Statuses: `open` → (optional `locked`) → `resolved` or `voided`.

### Auth

| Actor | Header |
|-------|--------|
| **Admin** | `Authorization: Bearer <ADMIN_TOKEN>` |
| **User** | `Authorization: Bearer <user_api_key>` **or** `X-Api-Key: <user_api_key>` |

- User keys look like `xpm_…` and are returned **only once** at `POST /users`. Server stores a SHA-256 hash.
- Admin creates/resolves markets and can credit users; does not need a user account (`created_by = 'admin'`).
- Existing X bot routes (`/post`, `/mentions`, …) still use the **admin token** only.

---

## Market API (curl examples)

Base URL: `https://xpred.aidenhuang.com`
All JSON. Errors: `{ "ok": false, "error": "message" }` with 4xx/5xx.

Set placeholders (never commit real values):

```bash
export BASE='https://xpred.aidenhuang.com'
export ADMIN_TOKEN='your-admin-token'
export USER_KEY='xpm_your_user_api_key'
```

### Register (create user)

```bash
curl -sS -X POST "$BASE/users" \
  -H 'Content-Type: application/json' \
  -d '{"display_name":"alice"}'
```

Response includes `user.api_key` **once**, `balance: 1000`, `id`, `api_key_prefix`.

### Me / positions

```bash
curl -sS "$BASE/me" \
  -H "Authorization: Bearer $USER_KEY"

curl -sS "$BASE/me/positions" \
  -H "X-Api-Key: $USER_KEY"
```

### List markets

```bash
curl -sS "$BASE/markets"
curl -sS "$BASE/markets?status=open&limit=20"
```

### Market detail + trades

```bash
curl -sS "$BASE/markets/mkt_EXAMPLE"
curl -sS "$BASE/markets/mkt_EXAMPLE/trades?limit=20"

# OG share image (PNG 1200×630)
open "$BASE/markets/mkt_EXAMPLE/og.png"
# curl -sS "$BASE/markets/mkt_EXAMPLE/og.png" -o market.png
```

### Create market (admin)

```bash
curl -sS -X POST "$BASE/markets" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "question": "Will X happen by Friday?",
    "description": "optional",
    "rules": "optional",
    "liquidity": 100
  }'
```

Starts `open` with `p_yes ≈ 0.5`. Optional fields: `description`, `rules`, `liquidity`, `resolve_by` (unix seconds).

### Quote (user)

```bash
# Buy quote
curl -sS -X POST "$BASE/markets/mkt_EXAMPLE/quote" \
  -H "Authorization: Bearer $USER_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"side":"yes","action":"buy","amount":10}'

# Sell quote
curl -sS -X POST "$BASE/markets/mkt_EXAMPLE/quote" \
  -H "Authorization: Bearer $USER_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"side":"yes","action":"sell","shares":5}'
```

### Buy (user)

```bash
curl -sS -X POST "$BASE/markets/mkt_EXAMPLE/buy" \
  -H "Authorization: Bearer $USER_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"side":"yes","amount":10}'
```

Body: `{ "side": "yes"|"no", "amount": number }`.
Returns trade, position, new balance, updated market pools/prices.

### Sell (user)

```bash
curl -sS -X POST "$BASE/markets/mkt_EXAMPLE/sell" \
  -H "Authorization: Bearer $USER_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"side":"no","shares":3.5}'
```

Body: `{ "side": "yes"|"no", "shares": number }`.

### Lock market (admin)

```bash
curl -sS -X POST "$BASE/markets/mkt_EXAMPLE/lock" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

Stops further trading (`status → locked`).

### Resolve (admin)

```bash
curl -sS -X POST "$BASE/markets/mkt_EXAMPLE/resolve" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"outcome":"yes"}'
```

`outcome`: `yes` | `no` | `void`. Response includes `payouts` count.

### Credit user (admin)

```bash
curl -sS -X POST "$BASE/users/usr_EXAMPLE/credit" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"amount":500}'
```

### Manual smoke test

1. `POST /users` → key + balance 1000
2. `POST /markets` (admin) → market id, `p_yes ≈ 0.5`
3. `POST /markets/:id/buy` side yes amount 10 → shares > 0, balance < 1000, `p_yes` rises
4. `GET /markets` shows updated price
5. `POST /markets/:id/resolve` outcome yes → winner balance increases
6. Existing `GET /status` still works

---

## API reference

Base URL: `https://xpred.aidenhuang.com`

### X bot (unchanged)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/` | No | Dashboard (HTML) |
| `GET` | `/health` | No | Liveness check |
| `GET` | `/status` | No | Bot identity (`@XPredMarkets`) + post count |
| `GET` | `/whoami` | No | Same as `/status` |
| `GET` | `/posts?limit=20` | No | Posts made **through this API** (D1 log) |
| `POST` | `/post` | **Admin** | Create a post as `@XPredMarkets` |
| `GET` | `/mentions?limit=10` | **Admin** | Live mentions of the bot from X API |
| `GET` | `/mentions/cached?limit=50` | No | Mentions previously stored in D1 |
| `POST` | `/mentions/process` | **Admin** | Fetch mentions → create or redirect markets |
| `GET` | `/mentions/markets` | **Admin** | Mention → market link history |
| `POST` | `/markets/from-mention` | **Admin** | Single mention text → create or redirect |

### Prediction markets

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/users` | No | Register; returns `api_key` once + 1000 credits |
| `GET` | `/me` | **User** | Profile + balance |
| `GET` | `/me/positions` | **User** | Open positions |
| `GET` | `/markets` | No | List markets (`status`, `limit`) |
| `GET` | `/markets/:id` | No | Detail + recent trades + `og_image` URL |
| `GET` | `/markets/:id/og` | No | OG image **PNG** 1200×630 |
| `GET` | `/markets/:id/og.png` | No | Same as `/og` |
| `GET` | `/markets/:id/og.svg` | No | SVG source (debug) |
| `GET` | `/markets/:id/trades` | No | Trade history |
| `POST` | `/markets` | **Admin** | Create market |
| `POST` | `/markets/:id/quote` | **User** | Preview buy/sell |
| `POST` | `/markets/:id/buy` | **User** | Buy YES/NO with credits |
| `POST` | `/markets/:id/sell` | **User** | Sell shares for credits |
| `POST` | `/markets/:id/lock` | **Admin** | Lock trading |
| `POST` | `/markets/:id/resolve` | **Admin** | Resolve yes/no/void |
| `POST` | `/users/:id/credit` | **Admin** | Add credits to a user |

### Mentions

Pull tweets that **@mention** the bot account:

```bash
export ADMIN_TOKEN='paste-token-here'

# Live from X (last N mentions)
curl -sS "https://xpred.aidenhuang.com/mentions?limit=10" \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# Live + save into D1 for later
curl -sS "https://xpred.aidenhuang.com/mentions?limit=20&persist=1" \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# Only new mentions after a tweet id
curl -sS "https://xpred.aidenhuang.com/mentions?since_id=2086169359274397759" \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# Read cached mentions (no X call, no admin token)
curl -sS "https://xpred.aidenhuang.com/mentions/cached?limit=50"
```

Query params for `/mentions`:

| Param | Description |
|-------|-------------|
| `limit` | 5–100 (default 10) |
| `since_id` | Only mentions newer than this tweet id |
| `pagination_token` | Next page from prior `meta.next_token` |
| `persist` | `1` / `true` → upsert into D1 |

Each mention includes `id`, `text`, `author_id`, `author_username`, `author_name`, `created_at`, `conversation_id`, `url`.

**Example success response:**

```json
{
  "ok": true,
  "user": { "id": "1966780828966334465", "username": "XPredMarkets" },
  "count": 2,
  "mentions": [
    {
      "id": "2086189907610058953",
      "text": "@XPredMarkets",
      "author_id": "2086189398593515520",
      "author_username": "aideniwnl",
      "author_name": "aiden huang",
      "created_at": "2026-08-08T20:36:48.000Z",
      "url": "https://x.com/aideniwnl/status/2086189907610058953"
    }
  ],
  "meta": {
    "result_count": 2,
    "newest_id": "2086189907610058953",
    "oldest_id": "...",
    "next_token": "..."
  },
  "persisted": 2
}
```

**Poll for new mentions only** (store last `newest_id`, pass as `since_id`):

```bash
curl -sS "https://xpred.aidenhuang.com/mentions?since_id=$LAST_ID&persist=1" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

### Auth for `POST /post`

Send the admin token as a Bearer header:

```http
Authorization: Bearer <ADMIN_TOKEN>
```

Body (JSON):

```json
{
  "text": "required, max 280 chars",
  "reply_to": "optional tweet id string"
}
```

### Public status (no token)

```bash
curl -sS https://xpred.aidenhuang.com/status
curl -sS https://xpred.aidenhuang.com/posts?limit=10
curl -sS https://xpred.aidenhuang.com/markets
```

---

## For the owner (Aiden)

### Where things live

| What | Where |
|------|--------|
| Worker code | `~/Downloads/utilities/xpredmarkets-cf/` |
| Local CLI poster | `~/Downloads/utilities/x_bot/x_post.py` |
| Secrets (local) | `~/.env` |
| Live site | https://xpred.aidenhuang.com |
| Cloudflare Worker | `xpredmarkets-cf` |
| D1 database | `xpredmarkets-db` (posts + mentions + markets) |
| X account | [@XPredMarkets](https://x.com/XPredMarkets) |

### Admin token

Stored as:

```bash
# in ~/.env
XPRED_ADMIN_TOKEN=...
```

View it:

```bash
grep XPRED_ADMIN_TOKEN ~/.env
```

Same value is set on the Worker as secret `ADMIN_TOKEN`.

**Give collaborators:** site URL + this token only.
**Do not give:** X API keys / access tokens (unless you want them to bypass your site entirely).

### Rotate the admin token

```bash
# 1. Generate a new token and put it in ~/.env as XPRED_ADMIN_TOKEN
# 2. Push to Cloudflare:
cd ~/Downloads/utilities/xpredmarkets-cf
npx wrangler secret put ADMIN_TOKEN
# paste the new value when prompted
```

Old tokens stop working immediately. Tell collaborators the new one.

### X credentials (owner only)

In `~/.env` and as Worker secrets:

| Env var | Role |
|---------|------|
| `X_API_KEY` | OAuth 1.0a Consumer Key |
| `X_API_SECRET` | OAuth 1.0a Consumer Secret |
| `X_ACCESS_TOKEN` | User access token for @XPredMarkets |
| `X_ACCESS_TOKEN_SECRET` | User access secret |

Also stored locally (optional / secondary):

| Env var | Role |
|---------|------|
| `X_BEARER_TOKEN` | App bearer (read-oriented) |
| `X_OAUTH2_CLIENT_ID` | OAuth 2.0 client id |
| `X_OAUTH2_CLIENT_SECRET` | OAuth 2.0 client secret |
| `X_OAUTH2_ACCESS_TOKEN` | Short-lived (~2h) |
| `X_OAUTH2_REFRESH_TOKEN` | Long-lived (~6 months) |

The **Worker posts with OAuth 1.0a**, not OAuth 2.0. After changing Access Token + Secret in the X developer portal, update `~/.env` and:

```bash
cd ~/Downloads/utilities/xpredmarkets-cf
# put each secret, or use secret bulk from a local secrets.json (never commit it)
echo -n "$X_ACCESS_TOKEN" | npx wrangler secret put X_ACCESS_TOKEN
echo -n "$X_ACCESS_TOKEN_SECRET" | npx wrangler secret put X_ACCESS_TOKEN_SECRET
```

### X developer portal checklist

If posting returns **403 oauth1-permissions**:

1. [developer.x.com](https://developer.x.com) → Project **X Prediction Markets** → App
2. User authentication settings:
   - **App permissions:** Read and write
   - **Type of App:** Web App, Automated App or Bot
   - **Callback URI:** `https://xpred.aidenhuang.com/callback`
   - **Website URL:** `https://xpred.aidenhuang.com`
3. Save
4. **Regenerate Access Token and Secret** (required after permission changes)
5. Update `~/.env` + Worker secrets
6. Test:

```bash
set -a; . ~/.env; set +a
python3 ~/Downloads/utilities/x_bot/x_post.py --whoami
python3 ~/Downloads/utilities/x_bot/x_post.py "test post"
```

### Deploy / ops

```bash
cd ~/Downloads/utilities/xpredmarkets-cf

npm install
npx wrangler deploy          # ship code
npx wrangler tail            # live logs
npx wrangler d1 migrations apply xpredmarkets-db --remote
```

Route: `xpred.aidenhuang.com/*` (see `wrangler.jsonc`)

Markets schema: `migrations/0003_markets.sql` (users, markets, positions, trades, ledger).

### Local CLI (bypasses the website)

Uses OAuth 1.0a from `~/.env` directly:

```bash
set -a; . ~/.env; set +a

python3 ~/Downloads/utilities/x_bot/x_post.py --whoami
python3 ~/Downloads/utilities/x_bot/x_post.py "hello"
python3 ~/Downloads/utilities/x_bot/x_post.py --reply-to TWEET_ID "reply"
python3 ~/Downloads/utilities/x_bot/x_post.py --media ./image.png "caption"
python3 ~/Downloads/utilities/x_bot/x_post.py --dry-run "would post this"
```

---

## Sharing the bot safely

| You want them to… | Give them |
|-------------------|-----------|
| Post or read live mentions via the website / API | URL + **admin token only** |
| Trade on prediction markets | They self-register on the site (user API key) |
| Create / resolve markets | URL + **admin token** |
| Run their own scripts against X | OAuth 1.0a four-pack (high risk — full bot control) |
| Maintain the Cloudflare Worker | CF access + code + all secrets |

**Recommended default:** admin token only for operators; traders register themselves. You can revoke the admin token anytime without regenerating X keys. Lost user keys cannot be recovered — register a new user.

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `401 unauthorized` on `/post` | Wrong or missing admin token |
| `403` + `oauth1-permissions` | App is Read-only; set Read and write, regenerate Access Token + Secret, update secrets |
| `/status` shows wrong user | Access tokens are for a different X account — regenerate while logged into @XPredMarkets |
| Site 404 / old behavior | `npx wrangler deploy` from `xpredmarkets-cf` |
| Post works via CLI but not site | Worker secrets out of date — re-run `wrangler secret put` for the X tokens |
| `401` on `/mentions` | Admin token required (same as `/post`) |
| `/mentions` empty | No @mentions yet, or `since_id` is past the newest mention |
| Cached mentions stale | Call `/mentions?persist=1` to refresh D1 from X |
| `401` on buy/sell | Missing/wrong user API key (`Authorization` or `X-Api-Key`) |
| Buy fails insufficient balance | Register fresh user (1000 credits) or ask admin to `POST /users/:id/credit` |
| Trade rejected market not open | Market is locked/resolved — only `open` accepts trades |
| Markets list empty | Apply migration `0003_markets.sql`, create a market with admin token |

---

## Architecture (short)

```
You / collaborator / trader
       │
       │  Bearer ADMIN_TOKEN  or  user api key (xpm_…)
       ▼
https://xpred.aidenhuang.com  (Cloudflare Worker)
       │
       ├─ OAuth 1.0a (X_* secrets) → api.x.com → @XPredMarkets
       │
       └─ D1 xpredmarkets-db
            posts + cached mentions
            users / markets / positions / trades / ledger
```

Trading engine: pure AMM helpers in `src/market.ts`; routes in `src/index.ts`; dashboard in `src/html.ts`.

---

## Security notes

- Treat **admin token**, **user API keys**, and **all X secrets** like passwords.
- Never commit `~/.env`, `.dev.vars`, or `secrets.json`.
- Do not put real tokens in this guide or in chat.
- If tokens were pasted into chat/email, regenerate them in the X developer portal and rotate `ADMIN_TOKEN`.
- User API keys are shown once at registration; only a hash is stored.
- OAuth 2 access tokens expire (~2h); refresh tokens last longer — the live poster path does **not** depend on them today.
- Credits are play-money only; nothing here settles real funds.
