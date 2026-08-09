from __future__ import annotations

from typing import Any

from ._slug import slug
from .base import TopicSeed


class XTrendDiscovery:
    """Discovers trend seeds via the X trends endpoint. Raw parsing stays here.

    ``client`` is any object exposing ``fetch_trends(woeid) -> list[dict]``
    (the shared XIngestionClient), so trend requests spend the same budget.
    """

    def __init__(self, client: Any, *, woeid: int = 1, limit: int = 20) -> None:
        self._client = client
        self._woeid = woeid
        self._limit = limit

    async def discover(self) -> list[TopicSeed]:
        raw = self._client.fetch_trends(self._woeid)
        ranked: list[tuple[int, str, dict]] = []
        for t in raw:
            name = t.get("trend_name") or t.get("name")
            if not name:
                continue
            try:
                total, _ = self._client.fetch_counts(name)
            except Exception:
                total = 0
            ranked.append((total, name, t))

        ranked.sort(key=lambda x: x[0], reverse=True)

        seeds: list[TopicSeed] = []
        for total, name, _ in ranked[: self._limit]:
            seeds.append(TopicSeed(
                topic_id=slug(name),
                name=name,
                source="trend",
                metadata={"query": name, "tweet_count": total,
                          "woeid": self._woeid},
            ))
        return seeds
