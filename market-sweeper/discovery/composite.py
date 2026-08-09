from __future__ import annotations

from typing import Any

from .base import TopicSeed


class CompositeDiscovery:
    """Runs several discoveries and concatenates their seeds (dedup happens later)."""

    def __init__(self, discoveries: list[Any]) -> None:
        self._discoveries = list(discoveries)

    async def discover(self) -> list[TopicSeed]:
        out: list[TopicSeed] = []
        for d in self._discoveries:
            out.extend(await d.discover())
        return out
