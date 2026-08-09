# X API -> CandidateTopic ingestion

The `ingestion` package builds a normalized `CandidateTopic` from live X API v2
data. It is separate from `classifier`, which never calls X. Read-only, app-only
bearer token; the OAuth 1.0a session (publishing) is intentionally not used here.

## Billing safety (pay-per-use, no monthly cap)

`XIngestionClient` takes a `RequestBudget` that raises `BudgetExceeded` before the
request count is exceeded. It reads `x-rate-limit-remaining` / `x-rate-limit-reset`
at runtime and backs off. It only calls read endpoints and never `/2/tweets/search/all`.
Full-archive search is priced well above recent search — keep it off the default path.

## Endpoint mapping

| CandidateTopic field | X API v2 source | Derivation |
|---|---|---|
| post_count | GET /2/tweets/counts/recent | meta.total_tweet_count |
| volume_velocity | counts/recent (granularity=hour) | most recent hourly bucket |
| volume_growth | counts/recent buckets | last bucket / mean(prior buckets) |
| representative_posts | GET /2/tweets/search/recent | top posts by per-post engagement |
| engagement_count | search public_metrics | sum of all public metrics except impression_count |
| unique_author_count | search author_id | count of distinct author_id |
| topic_age_minutes | search created_at | now - oldest sampled post |
| impression_count | public_metrics.impression_count | OPTIONAL; None when absent/all-zero |

- `volume_velocity`/`volume_growth` use the most recent hourly bucket from `counts/recent`, which is typically still in progress (the current hour hasn't finished accumulating), so both slightly understate current momentum — an inherent counts/recent approximation, like `topic_age_minutes`.

Base URL: `https://api.x.com`. Credentials come from `.env` (gitignored).

## Usage

    from ingestion.budget import RequestBudget
    from ingestion.x_client import XIngestionClient

    client = XIngestionClient(budget=RequestBudget(max_requests=4))  # bearer from env
    candidate = client.build_candidate_topic(
        topic_id="t1", topic_name="Warriors vs Lakers",
        query="warriors lakers -is:retweet lang:en", min_volume=50)
