from __future__ import annotations

from typing import Any, Protocol, runtime_checkable

from classifier import CandidateTopic
from discovery.base import TopicSeed

from .config import SweeperConfig


@runtime_checkable
class SeedIngestion(Protocol):
    async def ingest(self, seed: TopicSeed) -> CandidateTopic | None: ...


class XSeedIngestion:
    """Adapts a TopicSeed to the existing XIngestionClient.build_candidate_topic."""

    def __init__(self, client: Any, config: SweeperConfig) -> None:
        self._client = client
        self._config = config

    async def ingest(self, seed: TopicSeed) -> CandidateTopic | None:
        cfg = self._config
        query = seed.metadata.get("query") or seed.name
        # representative_count == max_posts_per_topic so the context builder has material.
        return self._client.build_candidate_topic(
            topic_id=seed.topic_id,
            topic_name=seed.name,
            query=query,
            max_posts=cfg.max_posts_per_topic,
            min_volume=cfg.min_volume,
            representative_count=cfg.max_posts_per_topic,
        )


class FakeSeedIngestion:
    """Deterministic ingestion for tests/offline demos (None == below min-volume)."""

    def __init__(self, by_topic_id: dict[str, CandidateTopic | None]) -> None:
        self._by_id = by_topic_id

    async def ingest(self, seed: TopicSeed) -> CandidateTopic | None:
        return self._by_id.get(seed.topic_id)
