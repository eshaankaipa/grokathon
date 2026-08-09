from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class TopicContext:
    """Event-level understanding of a conversation (factual, not a decision)."""

    summary: str
    entities: tuple[str, ...] = ()
    key_developments: tuple[str, ...] = ()
    unresolved_events: tuple[str, ...] = ()
    source_post_ids: tuple[str, ...] = ()
