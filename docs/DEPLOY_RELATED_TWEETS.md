# Deploy: market related tweets

When this PR merges, the person with Supabase + Cloudflare access should run these steps. **Merging the code alone is not enough** — the migration and worker secret must be applied for tweets to appear on the site.

## What this feature does

1. On every market create (mention, admin API, hourly sweeper), the CF worker searches X for relevant posts.
2. Top posts are stored in Supabase `market_related_tweets`.
3. The website shows them under each market (detail page + home cards).
4. Hourly cron also backfills open markets that still have no tweets.

## Deploy checklist (teammate)

### 1. Apply Supabase migration

From repo root (requires `supabase login` or `SUPABASE_ACCESS_TOKEN`):

```bash
npx supabase db push
```

Migration file:

- `supabase/migrations/20260808070000_market_related_tweets.sql`

Creates table `public.market_related_tweets` with public read RLS for open/closed/resolved markets.

Optional SQL-editor fallback: paste the contents of that migration into the Supabase SQL editor and run it.

### 2. Confirm Worker secret `X_BEARER_TOKEN`

App-only bearer is required for `GET /2/tweets/search/recent`:

```bash
cd xpredmarkets-cf
# if not already set:
echo -n "$X_BEARER_TOKEN" | npx wrangler secret put X_BEARER_TOKEN
```

Also ensure existing secrets remain: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, OAuth1 X keys, `ADMIN_TOKEN`, `XAI_API_KEY`.

### 3. Deploy Cloudflare Worker

```bash
cd xpredmarkets-cf
npm test
npx wrangler deploy
```

### 4. Deploy website

```bash
cd apps/web
npm install
npm run build
# deploy dist/ the usual way (Cloudflare Pages / your host)
```

If Pages auto-builds from `main`, a merge may be enough after the migration is applied.

### 5. Backfill existing markets

After deploy:

```bash
curl -X POST "https://xpred.aidenhuang.com/markets/backfill-tweets?limit=20" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

Refresh one market:

```bash
curl -X POST "https://xpred.aidenhuang.com/markets/<market-id-or-slug>/related-tweets" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

### 6. Verify

- Open any market on the web app → **From the conversation / Most relevant posts**.
- Or: `GET https://xpred.aidenhuang.com/markets/<id>/tweets`
- Create a new market via mention or admin → tweets should attach within a few seconds (`waitUntil`).

## If tweets are empty

| Symptom | Likely cause |
|--------|----------------|
| Empty section forever | Migration not applied, or RLS blocking |
| API 502 on related-tweets | `X_BEARER_TOKEN` missing / invalid / rate limited |
| Home cards have no tweets, detail empty | Backfill not run yet; wait for hourly cron or run step 5 |
| Source pill only | Search returned nothing for that query; still pins source tweet when present |

## New API routes

| Method | Path | Auth |
|--------|------|------|
| `GET` | `/markets/:id/tweets` | public |
| `POST` | `/markets/:id/related-tweets` | admin |
| `POST` | `/markets/backfill-tweets?limit=N` | admin |
