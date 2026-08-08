# X Prediction Markets Bot — Guide

Automated poster for **[@XPredMarkets](https://x.com/XPredMarkets)**  
Live site: **https://xpred.aidenhuang.com**

---

## Quick start (for someone you invite)

### What you need from Aiden

1. **Site URL:** `https://xpred.aidenhuang.com`
2. **Admin token** (password for posting)

That’s it. You do **not** need X API keys.

### Post from the website

1. Open https://xpred.aidenhuang.com  
2. Paste the **admin token** into the Admin token field  
3. Write your post (max 280 characters)  
4. Optional: put a tweet ID in “Reply to” to thread a reply  
5. Click **Post to X**

The token is stored in your browser’s `localStorage` on that device only.

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

---

## API reference

Base URL: `https://xpred.aidenhuang.com`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/` | No | Dashboard (HTML) |
| `GET` | `/health` | No | Liveness check |
| `GET` | `/status` | No | Bot identity (`@XPredMarkets`) + post count |
| `GET` | `/whoami` | No | Same as `/status` |
| `GET` | `/posts?limit=20` | No | Posts made **through this API** (D1 log) |
| `POST` | `/post` | **Yes** | Create a post as `@XPredMarkets` |
| `GET` | `/mentions?limit=10` | **Yes** | Live mentions of the bot from X API |
| `GET` | `/mentions/cached?limit=50` | No | Mentions previously stored in D1 |

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

Also update the architecture note: D1 now holds posts **and** mentions when `persist=1`.

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
| D1 database | `xpredmarkets-db` (post history) |
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
| Run their own scripts against X | OAuth 1.0a four-pack (high risk — full bot control) |
| Maintain the Cloudflare Worker | CF access + code + all secrets |

**Recommended default:** admin token only. You can revoke it anytime without regenerating X keys.

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

---

## Architecture (short)

```
You / collaborator
       │
       │  Bearer ADMIN_TOKEN
       ▼
https://xpred.aidenhuang.com  (Cloudflare Worker)
       │
       │  OAuth 1.0a (X_* secrets)
       ▼
   api.x.com  →  @XPredMarkets
       │
       ▼
   D1 xpredmarkets-db  (posts + cached mentions)
```

---

## Security notes

- Treat **admin token** and **all X secrets** like passwords.  
- Never commit `~/.env`, `.dev.vars`, or `secrets.json`.  
- If tokens were pasted into chat/email, regenerate them in the X developer portal and rotate `ADMIN_TOKEN`.  
- OAuth 2 access tokens expire (~2h); refresh tokens last longer — the live poster path does **not** depend on them today.
