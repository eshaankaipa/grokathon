from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class ContextConfig:
    """Tunables for hierarchical context construction."""

    max_posts: int = 40
    chunk_size: int = 10
    max_synthesis_inputs: int = 8
    max_grok_calls_per_topic: int = 6
    model: str = "grok-4-latest"

    def __post_init__(self) -> None:
        if self.chunk_size < 1:
            raise ValueError("chunk_size must be >= 1")
        if self.max_synthesis_inputs < 2:
            raise ValueError("max_synthesis_inputs must be >= 2 (reduce tree must shrink)")
        if self.max_grok_calls_per_topic < 1:
            raise ValueError("max_grok_calls_per_topic must be >= 1")
        if self.max_posts < 1:
            raise ValueError("max_posts must be >= 1")
