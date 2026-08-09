# X API Access — Handoff Reference

**Verified live on 2026-08-08.** Every "✅" below was confirmed with an actual HTTP 200,
not inferred from docs. Re-probe before trusting this if it's more than a few days old.

---

## 1. Credentials

**All secrets live in `/Users/yash/Documents/grokathon/.env`** (gitignored). Read them from
there — do not hardcode, do not paste into chat, do not commit.

| Env var | Purpose |
|---|---|
| `X_API_KEY` / `X_API_SECRET` | App identity (OAuth 1.0a consumer pair) |
| `X_ACCESS_TOKEN` / `X_ACCESS_SECRET` | @XPredMarkets delegated auth — **can post** |
| `X_BEARER_TOKEN` | App-only, read-only. **Use this for ingestion.** |
| `X_OAUTH2_*` | Unused. OAuth 1.0a already covers everything. |

⚠️ These credentials were exposed in a chat transcript and **should be rotated** at
console.x.com. Rotating changes the OAuth 1.0a pair and the bearer token; `.env` is the only
place to update.

### Account identity

| Field | Value |
|---|---|
| Account | `@XPredMarkets` ("X Prediction Markets") |
| User ID | `1966780828966334465` |
| App ID | `33290917` ✅ *confirmed — API reports it as `client_app_id`* |
| Project ID | `2086167241402339328` (created 2026-08-08 19:06 UTC) |
| Followers | 0 — this is a fresh bot account |

---

## 2. Billing model — READ THIS BEFORE WRITING INGEST LOOPS

The account is on **X API Pay-Per-Use** (X's default since 2026-02-06; there is no free tier
and no Basic/Pro signup for new customers). Billing is **per request at endpoint-specific
unit prices**, with **no monthly cap to protect you**.

- Post-pull usage as of handoff: **20 / 2,000,000**.
- Credit balance is **not exposed via any API**. Confirmed against X's OpenAPI spec: of 149
  documented paths, `/2/usage/tweets` is the only usage endpoint and it reports post counts,
  not currency. Check console.x.com → Billing for the balance.
- Request `usage.fields=daily_client_app_usage,daily_project_usage` on `/2/usage/tweets` for
  a per-app, per-day consumption breakdown — the best in-code spend signal available.
- Since every billable endpoint returns 200, billing is currently functional (credits loaded
  or card attached). The balance itself is unknown.

**The failure mode is not a rate limit — it's a backfill loop quietly burning credits.**
Full-archive search is priced well above recent search. Put a hard request-count budget in
the ingest client and check unit prices in the console before pointing anything at
`/2/tweets/search/all`.

---

## 3. Verified entitlements

### ✅ Available (app-only Bearer)

| Endpoint | Notes |
|---|---|
| `GET /2/tweets/search/recent` | Last 7 days. **Primary live ingestion path.** |
| `GET /2/tweets/search/all` | **FULL ARCHIVE back to 2006.** Formerly Enterprise-only. |
| `GET /2/tweets/counts/recent` | Volume histogram, 7 days |
| `GET /2/tweets/counts/all` | Volume histogram, full archive — cheap way to size a topic |
| `GET /2/tweets/search/stream/rules` | Filtered stream. **0 rules currently set.** |
| `GET /2/trends/by/woeid/:id` | 20 trends returned for WOEID 1 (global) |
| `GET /2/spaces/search` | Live/scheduled Spaces |
| `GET /2/users/by/username/:name` | User lookup |
| `GET /2/usage/tweets` | Project cap + consumption |

### ✅ Available (OAuth 1.0a user context)

`GET /2/users/me` · `/2/users/:id/tweets` · `/2/users/:id/mentions` ·
`/2/users/:id/timelines/reverse_chronological` · `/2/users/:id/followers` ·
`/2/users/:id/bookmarks` · `/2/users/:id/liked_tweets` · `/2/users/:id/owned_lists`

**`POST /2/tweets` — write access is CONFIRMED.** The app has Read+Write permission
(verified via a scope probe that returned 400 "include text or media" rather than 403).
Nothing has been posted from this session.

### ❌ Not available

| Endpoint | Status | Fix |
|---|---|---|
| `GET /2/dm_events` | 403 — app lacks DM scope | Change app perms to Read+Write+DM in console, **then regenerate access tokens** |
| `GET /2/users/personalized_trends` | 401 — needs X Premium | Subscribe @XPredMarkets to Premium. Regular trends already work; skip this. |

---

## 4. Observed rate limits

Read `x-rate-limit-remaining` / `x-rate-limit-reset` headers at runtime and back off — do not
hardcode these, they change.

| Endpoint | Limit / 15 min |
|---|---|
| `/2/tweets/search/recent` | 450 |
| `/2/users/by/username/:name` | 300 |
| `/2/users/me` | 75 |

---

## 5. Working client setup

```python
import os, requests
from requests_oauthlib import OAuth1Session   # already installed

# App-only — use for ALL ingestion (search, counts, streams, trends)
BEARER_HEADERS = {"Authorization": f"Bearer {os.environ['X_BEARER_TOKEN']}"}

# User context — only for posting / account-scoped reads
oauth = OAuth1Session(
    os.environ["X_API_KEY"],
    client_secret=os.environ["X_API_SECRET"],
    resource_owner_key=os.environ["X_ACCESS_TOKEN"],
    resource_owner_secret=os.environ["X_ACCESS_SECRET"],
)

resp = requests.get(
    "https://api.x.com/2/tweets/search/recent",
    headers=BEARER_HEADERS,
    params={
        "query": "prediction market -is:retweet lang:en",
        "max_results": 10,
        "tweet.fields": "created_at,public_metrics,author_id",
    },
)
```

Base URL is `https://api.x.com` (not `api.twitter.com`). Media upload still uses the v1.1
endpoint `https://upload.twitter.com/1.1/media/upload.json` with the OAuth 1.0a session.

---

## 6. Relevance to the market candidate classifier

Per `docs/superpowers/plans/2026-08-08-market-candidate-classifier.md`, the classifier sits
between ingestion and market creation. Mapping to what's actually available:

- **Live candidate detection** → `filtered stream` (persistent rules, currently empty) or
  polled `search/recent`. Stream is cheaper per-post at volume; polling is simpler to build.
- **Backfill + historical validation** → `search/all`. This is the capability that lets you
  test whether a candidate market would actually have been *objectively resolvable*, by
  pulling how the narrative actually played out. Budget-guard it.
- **Topic sizing / triage before expensive LLM classification** → `counts/all` and
  `counts/recent` are a cheap pre-filter: skip topics with no meaningful volume.
- **Trend seeding** → `trends/by/woeid` for candidate topic discovery.
- **Publishing resolved markets** → `POST /2/tweets` via the OAuth 1.0a session.

**Separation of concerns:** use the **Bearer token for the read/ingest path** and reserve the
**OAuth 1.0a session for the publish path**, so a bug in ingestion can never post to the
timeline.
