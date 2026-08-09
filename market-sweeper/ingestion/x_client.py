from __future__ import annotations

import os
import time
from collections.abc import Callable
from datetime import datetime
from typing import Any

from classifier import CandidateTopic

from .budget import RequestBudget

_BASE_URL = "https://api.x.com"
_SEARCH_RECENT = "tweets/search/recent"
_COUNTS_RECENT = "tweets/counts/recent"
_TRENDS_BY_WOEID = "trends/by/woeid"


def _parse_iso(ts: str) -> datetime:
    # X returns e.g. "2026-08-08T19:06:00.000Z"; normalize 'Z' for fromisoformat.
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))


class XIngestionClient:
    """Read-only X ingestion (app-only bearer). Builds CandidateTopic from live data.

    Enforces a hard RequestBudget and honors x-rate-limit headers. Only touches
    read endpoints (search/recent, counts/recent); never writes and never calls
    search/all.
    """

    def __init__(
        self,
        *,
        budget: RequestBudget,
        bearer_token: str | None = None,
        session: Any | None = None,
        base_url: str = _BASE_URL,
        sleep: Callable[[float], None] = time.sleep,
        now: Callable[[], float] = time.time,
        min_rate_limit_remaining: int = 2,
    ) -> None:
        self._budget = budget
        self._bearer = bearer_token or os.environ.get("X_BEARER_TOKEN")
        self._session = session
        self._base_url = base_url.rstrip("/")
        self._sleep = sleep
        self._now = now
        self._min_remaining = min_rate_limit_remaining

    # --- transport ---

    def _get_session(self) -> Any:
        if self._session is None:
            import requests  # lazy, optional [ingest] dependency

            self._session = requests.Session()
        return self._session

    def _get(self, path: str, params: dict[str, Any], endpoint: str) -> dict:
        if not self._bearer:
            raise RuntimeError("X_BEARER_TOKEN not set")
        self._budget.spend(endpoint)
        resp = self._get_session().get(
            f"{self._base_url}/2/{path}",
            headers={"Authorization": f"Bearer {self._bearer}"},
            params=params,
        )
        self._respect_rate_limit(resp.headers)
        if resp.status_code != 200:
            raise RuntimeError(
                f"X API {endpoint} returned {resp.status_code}: {resp.text[:300]}"
            )
        return resp.json()

    def _respect_rate_limit(self, headers: Any) -> None:
        try:
            remaining = int(headers.get("x-rate-limit-remaining", "1"))
            reset = int(headers.get("x-rate-limit-reset", "0"))
        except (TypeError, ValueError):
            return
        if remaining <= self._min_remaining and reset:
            wait = min(max(0.0, reset - self._now()), 900.0)
            if wait > 0:
                self._sleep(wait)

    # --- endpoints ---

    def fetch_counts(self, query: str) -> tuple[int, list[int]]:
        """Return (total_tweet_count, hourly counts oldest->newest) for a query."""
        data = self._get(_COUNTS_RECENT, {"query": query, "granularity": "hour"}, "counts/recent")
        total = int(data.get("meta", {}).get("total_tweet_count", 0))
        buckets = sorted(data.get("data", []), key=lambda b: b.get("start", ""))
        series = [int(b.get("tweet_count", 0)) for b in buckets]
        return total, series

    def search_recent(self, query: str, max_results: int = 100) -> list[dict]:
        """Search recent tweets, paginating until ``max_results`` or budget/limits."""
        target = max(0, max_results)
        per_page = 100
        tweets: list[dict] = []
        next_token: str | None = None
        while len(tweets) < target:
            params: dict[str, Any] = {
                "query": query,
                "max_results": max(10, min(per_page, target - len(tweets))),
                "tweet.fields": "created_at,public_metrics,author_id",
                "sort_order": "relevancy",
            }
            if next_token:
                params["next_token"] = next_token
            data = self._get(_SEARCH_RECENT, params, "search/recent")
            batch = list(data.get("data", []))
            if not batch:
                break
            tweets.extend(batch)
            next_token = (data.get("meta") or {}).get("next_token")
            if not next_token:
                break
        return tweets

    def fetch_trends(self, woeid: int = 1) -> list[dict]:
        """Return the raw trend objects for a WOEID (1 = global). Spends 1 budget unit."""
        data = self._get(
            f"{_TRENDS_BY_WOEID}/{woeid}",
            {"trend.fields": "trend_name,tweet_count"},
            "trends",
        )
        return list(data.get("data", []))

    # --- orchestration ---

    def build_candidate_topic(
        self,
        *,
        topic_id: str,
        topic_name: str,
        query: str,
        max_posts: int = 100,
        min_volume: int = 0,
        representative_count: int = 5,
    ) -> CandidateTopic | None:
        """counts/recent (cheap pre-filter) -> search/recent -> derived CandidateTopic.

        Returns None when total volume is below ``min_volume`` (skips the more
        expensive search). Never raises on missing post fields.
        """
        total, series = self.fetch_counts(query)
        if total < min_volume:
            return None
        posts = self.search_recent(query, max_posts)

        authors: set[str] = set()
        engagement_total = 0
        impression_total = 0
        has_impressions = False
        scored: list[tuple[int, str]] = []
        oldest: float | None = None

        for p in posts:
            pm = p.get("public_metrics") or {}
            eng = sum(
                int(v) for k, v in pm.items()
                if k != "impression_count" and isinstance(v, (int, float))
            )
            engagement_total += eng
            if "impression_count" in pm:
                imp = int(pm.get("impression_count") or 0)
                impression_total += imp
                has_impressions = has_impressions or imp > 0
            author = p.get("author_id")
            if author:
                authors.add(str(author))
            text = p.get("text", "")
            if text:
                scored.append((eng, text))
            created = p.get("created_at")
            if created:
                try:
                    ts = _parse_iso(created).timestamp()
                    oldest = ts if oldest is None else min(oldest, ts)
                except ValueError:
                    pass

        scored.sort(key=lambda t: t[0], reverse=True)
        representative_posts = [text for _, text in scored[:representative_count]]

        velocity = float(series[-1]) if series else None
        growth: float | None = None
        if len(series) >= 2:
            prior = series[:-1]
            avg_prior = sum(prior) / len(prior)
            if avg_prior > 0:
                growth = series[-1] / avg_prior

        age_minutes: float | None = None
        if oldest is not None:
            age_minutes = max(0.0, (self._now() - oldest) / 60.0)

        return CandidateTopic(
            topic_id=topic_id,
            topic_name=topic_name,
            representative_posts=representative_posts,
            post_count=total,
            unique_author_count=len(authors),
            engagement_count=engagement_total,
            impression_count=impression_total if has_impressions else None,
            volume_velocity=velocity,
            volume_growth=growth,
            topic_age_minutes=age_minutes,
            metadata={
                "query": query,
                "sampled_posts": len(posts),
                "budget_spent": self._budget.spent,
            },
        )
