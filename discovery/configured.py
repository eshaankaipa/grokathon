from __future__ import annotations

from ._slug import slug
from .base import TopicSeed


class ConfiguredDiscovery:
    """Turns a static list of query strings into configured TopicSeeds (no API)."""

    def __init__(self, queries: list[str]) -> None:
        self._queries = list(queries)

    async def discover(self) -> list[TopicSeed]:
        return [
            TopicSeed(topic_id=slug(q), name=q, source="configured",
                      metadata={"query": q})
            for q in self._queries
        ]
