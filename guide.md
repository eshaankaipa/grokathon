# xmarket Bot — Guide

Automated poster for **[@xmarket](https://x.com/xmarket)**  
Live site: **https://xpred.aidenhuang.com**

---

## Quick start (for someone you invite)

### What you need from Aiden

1. **Site URL:** `https://xpred.aidenhuang.com`
2. **Admin token** 2B4wGkrPhcyXeQ1h0uP0RqHaiYXLMKVqvmNfLe0Ckic

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
  "url": "https://x.com/xmarket/status/2086169359274397759"
}
```

---

## API reference

Base URL: `https://xpred.aidenhuang.com`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/` | No | Dashboard (HTML) |
| `GET` | `/health` | No | Liveness check |
| `GET` | `/status` | No | Bot identity (`@xmarket`) + post count |
| `GET` | `/whoami` | No | Same as `/status` |
| `GET` | `/posts?limit=20` | No | Posts made **through this API** (D1 log) |
| `POST` | `/post` | **Yes** | Create a post as `@xmarket` |

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
| X account | [@xmarket](https://x.com/xmarket) |

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
| `X_ACCESS_TOKEN` | User access token for @xmarket |
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

1. [developer.x.com](https://developer.x.com) → Project **xmarket** → App  
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
| Post via the website / API | URL + **admin token only** |
| Run their own scripts against X | OAuth 1.0a four-pack (high risk — full bot control) |
| Maintain the Cloudflare Worker | CF access + code + all secrets |

**Recommended default:** admin token only. You can revoke it anytime without regenerating X keys.

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `401 unauthorized` on `/post` | Wrong or missing admin token |
| `403` + `oauth1-permissions` | App is Read-only; set Read and write, regenerate Access Token + Secret, update secrets |
| `/status` shows wrong user | Access tokens are for a different X account — regenerate while logged into @xmarket |
| Site 404 / old behavior | `npx wrangler deploy` from `xpredmarkets-cf` |
| Post works via CLI but not site | Worker secrets out of date — re-run `wrangler secret put` for the X tokens |

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
   api.x.com  →  @xmarket
       │
       ▼
   D1 xpredmarkets-db  (log of posts made through the API)
```

---

## Security notes

- Treat **admin token** and **all X secrets** like passwords.  
- Never commit `~/.env`, `.dev.vars`, or `secrets.json`.  
- If tokens were pasted into chat/email, regenerate them in the X developer portal and rotate `ADMIN_TOKEN`.  
- OAuth 2 access tokens expire (~2h); refresh tokens last longer — the live poster path does **not** depend on them today.
