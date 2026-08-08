# Prediction Markets — Schema & API Contract

Play-money binary prediction markets on the existing Worker (`xpred.aidenhuang.com`).
Currency: **credits** (not real money). Trading engine: **constant-product AMM** on YES/NO pools.

---

## 1. D1 schema (`migrations/0003_markets.sql`)

### `users`
| Column | Type | Notes |
|--------|------|--------|
| id | TEXT PK | `usr_` + random |
| display_name | TEXT NOT NULL | |
| api_key_hash | TEXT NOT NULL UNIQUE | SHA-256 hex of raw api key |
| api_key_prefix | TEXT NOT NULL | first 8 chars for display |
| balance | REAL NOT NULL DEFAULT 1000 | credits |
| created_at | INTEGER NOT NULL | unix seconds |

### `markets`
| Column | Type | Notes |
|--------|------|--------|
| id | TEXT PK | `mkt_` + random |
| question | TEXT NOT NULL | |
| description | TEXT | |
| status | TEXT NOT NULL | `open` \| `locked` \| `resolved` \| `voided` |
| yes_pool | REAL NOT NULL | AMM reserve |
| no_pool | REAL NOT NULL | AMM reserve |
| resolution | TEXT | `yes` \| `no` \| `void` \| NULL |
| resolve_by | INTEGER | optional unix deadline |
| created_by | TEXT | user id or `admin` |
| created_at | INTEGER NOT NULL |
| resolved_at | INTEGER | |
| rules | TEXT | free text |

Default liquidity on create: `yes_pool = no_pool = 100` (unless overridden, min 10 each).

### `positions`
| Column | Type |
|--------|------|
| user_id | TEXT |
| market_id | TEXT |
| shares_yes | REAL NOT NULL DEFAULT 0 |
| shares_no | REAL NOT NULL DEFAULT 0 |
| updated_at | INTEGER |
| PRIMARY KEY (user_id, market_id) |

### `trades`
| Column | Type |
|--------|------|
| id | TEXT PK | `trd_` + random |
| market_id | TEXT NOT NULL |
| user_id | TEXT NOT NULL |
| side | TEXT NOT NULL | `buy_yes` \| `buy_no` \| `sell_yes` \| `sell_no` |
| shares | REAL NOT NULL |
| cost | REAL NOT NULL | credits paid (buy) or received (sell) |
| price | REAL NOT NULL | avg credit per share for this trade |
| p_yes_after | REAL NOT NULL | implied prob after trade |
| created_at | INTEGER NOT NULL |

### `ledger`
| Column | Type |
|--------|------|
| id | INTEGER PK AUTOINCREMENT |
| user_id | TEXT NOT NULL |
| amount | REAL NOT NULL | signed delta |
| balance_after | REAL NOT NULL |
| reason | TEXT NOT NULL | `signup_bonus` \| `buy` \| `sell` \| `payout` \| `credit` \| `void_refund` |
| ref_type | TEXT | `trade` \| `market` \| `admin` |
| ref_id | TEXT | |
| created_at | INTEGER NOT NULL |

Indexes: markets(status, created_at), trades(market_id, created_at), ledger(user_id, created_at).

---

## 2. AMM math (pure functions in `src/market.ts`)

Constant product: `k = yes_pool * no_pool`.

**Implied probability**
- `p_yes = no_pool / (yes_pool + no_pool)`
- `p_no = 1 - p_yes`

**Buy YES with `amount` credits**
```
k = yes_pool * no_pool
new_no = no_pool + amount
new_yes = k / new_no
shares_out = yes_pool - new_yes
// update pools to new_yes, new_no
```

**Buy NO with `amount` credits** — symmetric (swap yes/no).

**Sell YES `shares` back**
```
k = yes_pool * no_pool
new_yes = yes_pool + shares
new_no = k / new_yes
credits_out = no_pool - new_no
```

**Sell NO** — symmetric.

Reject if: amount/shares <= 0, market not `open`, insufficient balance/shares, shares_out <= 0, pools would go non-positive.

Round to 8 decimal places for storage; never go below pool floor 1e-8.

---

## 3. Auth

| Actor | Header |
|-------|--------|
| Admin | `Authorization: Bearer <ADMIN_TOKEN>` (existing) |
| User | `Authorization: Bearer <user_api_key>` **or** `X-Api-Key: <user_api_key>` |

User api keys shown **once** at creation as `xpm_` + random 32 bytes hex. Store only SHA-256 hash.

Admin may act as system for create/resolve without a user id (`created_by = 'admin'`).

---

## 4. API routes — inputs / outputs

All JSON. Errors: `{ "ok": false, "error": "message" }` with 4xx/5xx.

### Public

#### `GET /markets`
Query: `status` (optional), `limit` (default 50, max 100)
Output:
```json
{
  "ok": true,
  "markets": [
    {
      "id": "mkt_…",
      "question": "…",
      "description": "…",
      "status": "open",
      "p_yes": 0.52,
      "p_no": 0.48,
      "yes_pool": 100,
      "no_pool": 95,
      "volume": 123.4,
      "resolve_by": null,
      "resolution": null,
      "created_at": 0
    }
  ]
}
```
`volume` = SUM(cost) for buys on that market (or abs cost of all trades).

#### `GET /markets/:id`
Output: market detail + last 20 trades + top positions optional.

#### `GET /markets/:id/trades`
Query: `limit`
Output: `{ ok, trades: [...] }`

### User (api key)

#### `POST /users`
Body: `{ "display_name": "alice" }`
Output:
```json
{
  "ok": true,
  "user": {
    "id": "usr_…",
    "display_name": "alice",
    "balance": 1000,
    "api_key": "xpm_…",
    "api_key_prefix": "xpm_abcd"
  }
}
```
`api_key` only returned here.

#### `GET /me`
Output: `{ ok, user: { id, display_name, balance, api_key_prefix, created_at } }`

#### `GET /me/positions`
Output: `{ ok, positions: [{ market_id, question, status, shares_yes, shares_no, p_yes }] }`

#### `POST /markets/:id/quote`
Body: `{ "side": "yes"|"no", "action": "buy"|"sell", "amount"?: number, "shares"?: number }`
- buy: require `amount`
- sell: require `shares`
Output: `{ ok, side, action, amount, shares, avg_price, p_yes_after, p_yes_before }`

#### `POST /markets/:id/buy`
Body: `{ "side": "yes"|"no", "amount": number }`
Output: `{ ok, trade: {...}, position: {...}, balance, market: { p_yes, p_no, yes_pool, no_pool } }`

#### `POST /markets/:id/sell`
Body: `{ "side": "yes"|"no", "shares": number }`
Output: same shape as buy.

### Admin

#### `POST /markets`
Body:
```json
{
  "question": "Will X happen by Friday?",
  "description": "optional",
  "rules": "optional",
  "liquidity": 100,
  "resolve_by": 1730000000
}
```
Output: `{ ok, market: {...} }`
Status always starts `open`.

#### `POST /markets/:id/lock`
Output: `{ ok, market }` — status → `locked` (no more trades)

#### `POST /markets/:id/resolve`
Body: `{ "outcome": "yes"|"no"|"void" }`
- yes/no: pay each holder of winning shares **1 credit per share**; losing shares → 0; clear positions
- void: refund cost basis is hard; MVP: refund **shares * 0.5** credits per share held (YES+NO), then clear positions
Output: `{ ok, market, payouts: number }`

#### `POST /users/:id/credit`
Body: `{ "amount": number }`
Output: `{ ok, balance }`

---

## 5. Module layout

| File | Responsibility |
|------|----------------|
| `migrations/0003_markets.sql` | schema only |
| `src/market.ts` | AMM pure math + DB helpers (create user, market, quote, buy, sell, resolve, list) |
| `src/index.ts` | route wiring only; keep existing X bot routes |
| `src/html.ts` | dashboard: markets list, create, trade, register user, resolve |
| `GUIDE.md` | document new routes |

Do **not** remove existing routes: `/`, `/health`, `/status`, `/whoami`, `/posts`, `/post`, `/mentions`, `/mentions/cached`.

---

## 6. UI requirements (`html.ts`)

Same dark theme. Add sections:

1. **Markets** — list open markets with p_yes bar, link/detail
2. **Create market** — admin token + question (and optional liquidity)
3. **Trade** — user api key + market id + buy yes/no amount
4. **Register** — display name → show api key once
5. **Resolve** — admin token + market id + outcome

Keep existing compose-post + mentions docs at bottom of API pre block.

---

## 7. Acceptance tests (manual curl)

1. `POST /users` → key + balance 1000  
2. `POST /markets` (admin) → market id, p_yes ≈ 0.5  
3. `POST /markets/:id/buy` side yes amount 10 → shares > 0, balance < 1000, p_yes rises  
4. `GET /markets` shows updated price  
5. `POST /markets/:id/resolve` outcome yes → winner balance increases  
6. Existing `GET /status` still works  

---

## 8. Implementation order for agents

1. **Agent A**: migration + `src/market.ts` (math + all DB operations, exported functions)  
2. **Agent B**: wire routes in `src/index.ts` using Agent A exports  
3. **Agent C**: update `src/html.ts` + `GUIDE.md`  

Agents B and C must not invent alternate schemas; follow this document exactly.
