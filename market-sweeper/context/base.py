from __future__ import annotations

from typing import Protocol, runtime_checkable

from classifier import CandidateTopic

from .models import TopicContext


@runtime_checkable
class ContextBuilder(Protocol):
    """Builds an event-level TopicContext from a CandidateTopic. Understand, don't decide."""

    async def build(self, candidate: CandidateTopic) -> TopicContext: ...
