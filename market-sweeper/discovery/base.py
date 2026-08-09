from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal, Protocol, runtime_checkable

SeedSource = Literal["trend", "news", "configured"]


@dataclass(frozen=True)
class TopicSeed:
    """A potentially interesting topic to investigate. Discovery does NOT classify."""

    topic_id: str
    name: str
    source: SeedSource
    metadata: dict = field(default_factory=dict)


@runtime_checkable
class TopicDiscovery(Protocol):
    async def discover(self) -> list[TopicSeed]: ...
