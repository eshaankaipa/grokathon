# X Prediction Markets API — Definitions

**Base URL:** `https://xpred.aidenhuang.com`  
**Service:** Cloudflare Worker `xpredmarkets-cf`  
**Bot:** [@XPredMarkets](https://x.com/XPredMarkets)

This document is the contract for every HTTP route: auth, request/response shapes, and domain types.

---

## 1. Conventions

### Content types

| Direction | Type |
|-----------|------|
| JSON APIs | `Content-Type: application/json` |
| OG image | `image/png` (or `image/svg+xml` for `/og.svg`) |
| Dashboard | `text/html` |

### Response envelope

**Success (most routes):**
```json
{ "ok": true, ... }
```

**Error:**
```json
{ "ok": false, "error": "human-readable message" }
```
Some older X bot routes use `{ "error": "..." }` without `ok` (e.g. bare `401 unauthorized`).

### Status codes

| Code | Meaning |
|------|---------|
| `200` | Success |
| `400` | Bad input / business rule (insufficient balance, market not open, …) |
| `401` | Missing/invalid admin token or user API key |
| `404` | Resource not found |
| `500` | Server / misconfiguration (secrets missing, render failure) |

### IDs

| Prefix | Entity |
|--------|--------|
| `usr_` | User |
| `mkt_` | Market |
| `trd_` | Trade |
| `xpm_` | User API key (raw; shown once at registration) |

Tweet IDs are X snowflake strings (digits).

---

## 2. Authentication

### Admin

```http
Authorization: Bearer <ADMIN_TOKEN>
```
Optional alias: `?token=<ADMIN_TOKEN>`

Used for: posting, mentions, create/lock/resolve markets, credits, mention→market wrapper.

Env secret on Worker: `ADMIN_TOKEN`  
Local: `XPRED_ADMIN_TOKEN` in `~/.env`

### User (trading)

```http
Authorization: Bearer <xpm_…>
```
or
```http
X-Api-Key: <xpm_…>
```

**Admin token must not be used on user routes** → `401`.

### X API (server-side only)

Worker secrets (never expose to clients):

| Secret | Role |
|--------|------|
| `X_API_KEY` | OAuth 1.0a consumer key |
| `X_API_SECRET` | OAuth 1.0a consumer secret |
| `X_ACCESS_TOKEN` | User access token (@XPredMarkets) |
| `X_ACCESS_TOKEN_SECRET` | User access secret |

---

## 3. Domain types

### MarketStatus
```ts
type MarketStatus = "open" | "locked" | "resolved" | "voided"
```

### Resolution
```ts
type Resolution = "yes" | "no" | "void" | null
```

### Market
```ts
interface Market {
  id: string                 // mkt_…
  question: string
  description: string | null
  status: MarketStatus
  yes_pool: number
  no_pool: number
  resolution: Resolution
  resolve_by: number | null  // unix seconds
  created_by: string | null
  created_at: number         // unix seconds
  resolved_at: number | null
  rules: string | null
  p_yes: number              // no_pool / (yes_pool + no_pool)
  p_no: number
  volume: number             // sum of buy costs
}
```

### User (public)
```ts
interface UserPublic {
  id: string
  display_name: string
  balance: number
  api_key_prefix: string     // e.g. xpm_34da
  created_at: number
}
```

Registration also returns `api_key` **once** (full `xpm_…`).

### Position
```ts
interface PositionView {
  market_id: string
  question: string
  status: MarketStatus
  shares_yes: number
  shares_no: number
  p_yes: number
}
```

### Trade
```ts
interface Trade {
  id: string
  market_id: string
  user_id: string
  side: "buy_yes" | "buy_no" | "sell_yes" | "sell_no"
  shares: number
  cost: number               // credits paid (buy) or received (sell)
  price: number              // avg credit per share
  p_yes_after: number
  created_at: number
}
```

### X mention (live)
```ts
interface XMention {
  id: string
  text: string
  author_id?: string
  author_username?: string
  author_name?: string
  created_at?: string
  conversation_id?: string
  in_reply_to_user_id?: string
  url: string
}
```

### Mention → market result
```ts
type MentionAction = "created" | "redirected" | "skipped"

interface MentionMarketResult {
  action: MentionAction
  reason?: string
  tweet_id?: string
  author_username?: string | null
  question?: string
  market?: Market
  market_id?: string
  url?: string               // https://xpred.aidenhuang.com/markets/{id}
  og_image?: string          // …/og.png
  already_processed?: boolean
}
```

### Currency / AMM (play-money)

| Concept | Definition |
|---------|------------|
| Credits | Play-money unit (not real currency) |
| Signup bonus | `1000` credits |
| Default liquidity | `yes_pool = no_pool = 100` (min `10`) |
| Constant product | `k = yes_pool × no_pool` |
| Implied prob | `p_yes = no_pool / (yes_pool + no_pool)` |
| Buy YES with `amount` | add to `no_pool`, shrink `yes_pool`, user receives Δ shares |
| Resolve YES/NO | winning shares pay **1 credit** each |
| Void | refund **0.5 × (shares_yes + shares_no)** |

---

## 4. Route catalog

### 4.1 Health & dashboard

#### `GET /health`
No auth.

```json
{ "ok": true, "service": "xpredmarkets-cf" }
```

#### `GET /`
- `Accept: text/html` → dashboard UI  
- `Accept: application/json` → `{ ok, service, routes: string[] }`

---

### 4.2 X bot

#### `GET /status` · `GET /whoami`
No auth. OAuth as bot user.

```json
{
  "ok": true,
  "service": "xpredmarkets-cf",
  "user": {
    "id": "1966780828966334465",
    "username": "XPredMarkets",
    "name": "X Prediction Markets",
    "description": "",
    "public_metrics": { "...": "..." }
  },
  "posts_logged": 0
}
```

#### `GET /posts?limit=20`
No auth. Posts made via this API (D1).

#### `POST /post`
**Admin.** Body:
```json
{ "text": "string (required, ≤280)", "reply_to": "tweet_id optional" }
```
```json
{ "ok": true, "id": "…", "text": "…", "url": "https://x.com/XPredMarkets/status/…" }
```

#### `GET /mentions?limit=10&since_id=&pagination_token=&persist=0|1`
**Admin.** Live mentions from X. `persist=1` upserts into D1.

#### `GET /mentions/cached?limit=50&since_id=`
No auth. Cached mentions from D1.

---

### 4.3 Mention → market wrapper

#### `POST /markets/from-mention`
**Admin.** Single mention → create or redirect.

**Body:**
```json
{
  "text": "required — mention body including optional @handle",
  "tweet_id": "optional — for idempotency + announce reply",
  "author_id": "optional",
  "author_username": "optional",
  "liquidity": 100,
  "force_create": false,
  "announce": false
}
```

**Matching order:**
1. `tweet_id` already in `mention_markets` → `redirected` (`already_processed: true`)
2. Text contains `mkt_…` or `xpred.aidenhuang.com/markets/mkt_…` → `redirected`
3. Open/locked market with same normalized question → `redirected`
4. Else extract question (strip @mentions / “create market”) → `created`
5. Empty / self-bot / &lt;8 chars after strip → `skipped`

**Response:**
```json
{
  "ok": true,
  "action": "created",
  "market_id": "mkt_…",
  "question": "…",
  "url": "https://xpred.aidenhuang.com/markets/mkt_…",
  "og_image": "https://xpred.aidenhuang.com/markets/mkt_…/og.png",
  "market": { /* Market */ },
  "reason": "new market from mention",
  "tweet_id": "…",
  "author_username": "…",
  "announcement": null
}
```

If `announce: true` and `tweet_id` set, bot replies on X with market + OG links; `announcement` holds post result.

#### `POST /mentions/process`
**Admin.** Fetch live mentions, run wrapper on each.

**Body / query:**
```json
{
  "limit": 10,
  "since_id": "optional",
  "pagination_token": "optional",
  "persist": true,
  "announce": false,
  "liquidity": 100
}
```

**Response:**
```json
{
  "ok": true,
  "fetched": 3,
  "created": 1,
  "redirected": 1,
  "skipped": 1,
  "results": [ /* MentionMarketResult[] */ ],
  "meta": { "newest_id": "…", "oldest_id": "…", "next_token": "…", "result_count": 3 },
  "announcements": [ /* if announce */ ]
}
```

#### `GET /mentions/markets?limit=50`
**Admin.** History table `mention_markets`.

```json
{
  "ok": true,
  "links": [
    {
      "tweet_id": "…",
      "market_id": "mkt_…",
      "action": "created",
      "question": "…",
      "author_username": "…",
      "processed_at": 0
    }
  ]
}
```

---

### 4.4 Users & portfolio

#### `POST /users`
No auth.

```json
{ "display_name": "alice" }
```
```json
{
  "ok": true,
  "user": {
    "id": "usr_…",
    "display_name": "alice",
    "balance": 1000,
    "api_key": "xpm_…",
    "api_key_prefix": "xpm_abcd",
    "created_at": 0
  }
}
```

#### `GET /me`
**User.** Public profile (no raw key).

#### `GET /me/positions`
**User.** All positions with market metadata.

#### `POST /users/:id/credit`
**Admin.**
```json
{ "amount": 50 }
```
```json
{ "ok": true, "balance": 1050 }
```

---

### 4.5 Markets

#### `GET /markets?status=&limit=50`
No auth. List markets (optional `status` filter).

```json
{ "ok": true, "markets": [ /* Market[] */ ] }
```

#### `GET /markets/:id`
No auth. Detail + last trades + OG URL.

```json
{
  "ok": true,
  "market": { /* Market */ },
  "trades": [ /* Trade[] */ ],
  "og_image": "https://xpred.aidenhuang.com/markets/{id}/og.png"
}
```

#### `GET /markets/:id/trades?limit=20`
No auth.

#### `GET /markets/:id/og` · `GET /markets/:id/og.png`
No auth. **PNG** 1200×630 Open Graph card  
(title + YES/NO odds + payouts).

#### `GET /markets/:id/og.svg`
No auth. SVG source (debug).

#### `POST /markets`
**Admin.** Create open market.

```json
{
  "question": "Will X happen?",
  "description": "optional",
  "rules": "optional",
  "liquidity": 100,
  "resolve_by": null
}
```
```json
{ "ok": true, "market": { /* Market, p_yes ≈ 0.5 */ } }
```

#### `POST /markets/:id/lock`
**Admin.** `open` → `locked` (no more trades).

#### `POST /markets/:id/resolve`
**Admin.**
```json
{ "outcome": "yes" | "no" | "void" }
```
```json
{ "ok": true, "market": { /* resolved */ }, "payouts": 12.5 }
```

---

### 4.6 Trading

#### `POST /markets/:id/quote`
**User.** Preview without executing.

```json
{
  "side": "yes" | "no",
  "action": "buy" | "sell",
  "amount": 10,
  "shares": 5
}
```
- Buy requires `amount`  
- Sell requires `shares`

```json
{
  "ok": true,
  "side": "yes",
  "action": "buy",
  "amount": 10,
  "shares": 9.09,
  "avg_price": 1.1,
  "p_yes_before": 0.5,
  "p_yes_after": 0.55
}
```

#### `POST /markets/:id/buy`
**User.**
```json
{ "side": "yes" | "no", "amount": 10 }
```
```json
{
  "ok": true,
  "trade": { /* Trade */ },
  "position": { "user_id", "market_id", "shares_yes", "shares_no", "updated_at" },
  "balance": 990,
  "market": { "p_yes", "p_no", "yes_pool", "no_pool" }
}
```

#### `POST /markets/:id/sell`
**User.**
```json
{ "side": "yes" | "no", "shares": 5 }
```
Same response shape as buy.

**Rejects:** market not `open`, amount/shares ≤ 0, insufficient balance/shares, invalid side.

---

## 5. D1 tables (persistence)

| Table | Purpose |
|-------|---------|
| `posts` | Tweets sent via `/post` |
| `events` | Operational log |
| `mentions` | Cached X mentions (`persist=1`) |
| `users` | Traders + hashed API keys |
| `markets` | Binary markets + pools |
| `positions` | Per-user share balances |
| `trades` | Fill history |
| `ledger` | Credit deltas |
| `mention_markets` | `tweet_id` → `market_id` idempotency |

---

## 6. Public URLs (client-facing)

| Resource | URL |
|----------|-----|
| Site | `https://xpred.aidenhuang.com` |
| Market JSON | `https://xpred.aidenhuang.com/markets/{mkt_id}` |
| Market OG image | `https://xpred.aidenhuang.com/markets/{mkt_id}/og.png` |
| X account | `https://x.com/XPredMarkets` |

---

## 7. Quick reference matrix

| Method | Path | Auth |
|--------|------|------|
| GET | `/` | — |
| GET | `/health` | — |
| GET | `/status`, `/whoami` | — |
| GET | `/posts` | — |
| POST | `/post` | Admin |
| GET | `/mentions` | Admin |
| GET | `/mentions/cached` | — |
| POST | `/mentions/process` | Admin |
| GET | `/mentions/markets` | Admin |
| POST | `/markets/from-mention` | Admin |
| GET | `/markets` | — |
| GET | `/markets/:id` | — |
| GET | `/markets/:id/trades` | — |
| GET | `/markets/:id/og[.png\|.svg]` | — |
| POST | `/markets` | Admin |
| POST | `/markets/:id/lock` | Admin |
| POST | `/markets/:id/resolve` | Admin |
| POST | `/markets/:id/quote` | User |
| POST | `/markets/:id/buy` | User |
| POST | `/markets/:id/sell` | User |
| POST | `/users` | — |
| GET | `/me` | User |
| GET | `/me/positions` | User |
| POST | `/users/:id/credit` | Admin |

---

## 8. Env / secrets checklist

| Name | Where | Notes |
|------|--------|------|
| `ADMIN_TOKEN` | Worker secret | Site admin |
| `X_API_KEY` | Worker secret | OAuth1 |
| `X_API_SECRET` | Worker secret | OAuth1 |
| `X_ACCESS_TOKEN` | Worker secret | OAuth1 user |
| `X_ACCESS_TOKEN_SECRET` | Worker secret | OAuth1 user |
| `BOT_USERNAME` | Worker var | default `XPredMarkets` |
| `BOT_NAME` | Worker var | default `X Prediction Markets` |
| `DB` | D1 binding | `xpredmarkets-db` |

---

*Generated for Grokathon · Worker `xpredmarkets-cf` · base `https://xpred.aidenhuang.com`*
