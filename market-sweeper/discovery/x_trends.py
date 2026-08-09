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
        seeds: list[TopicSeed] = []
        for t in raw[: self._limit]:
            name = t.get("trend_name") or t.get("name")
            if not name:
                continue
            seeds.append(TopicSeed(
                topic_id=slug(name),
                name=name,
                source="trend",
                metadata={"query": name, "tweet_count": t.get("tweet_count"),
                          "woeid": self._woeid},
            ))
        return seeds
