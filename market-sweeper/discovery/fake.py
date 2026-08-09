from __future__ import annotations

from .base import TopicSeed


class FakeTopicDiscovery:
    """Deterministic discovery for tests/offline demos."""

    def __init__(self, seeds: list[TopicSeed]) -> None:
        self._seeds = list(seeds)

    async def discover(self) -> list[TopicSeed]:
        return list(self._seeds)
