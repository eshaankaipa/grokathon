from __future__ import annotations

from classifier import CandidateTopic

from .models import TopicContext


class FakeContextBuilder:
    """Deterministic context builder for tests and offline demos."""

    def __init__(
        self,
        by_topic_id: dict[str, TopicContext] | None = None,
        default: TopicContext | None = None,
    ) -> None:
        self._by_id = by_topic_id or {}
        self._default = default

    async def build(self, candidate: CandidateTopic) -> TopicContext:
        if candidate.topic_id in self._by_id:
            return self._by_id[candidate.topic_id]
        if self._default is not None:
            return self._default
        posts = tuple(candidate.representative_posts)
        return TopicContext(
            summary=f"Discussion about {candidate.topic_name}",
            entities=(candidate.topic_name,),
            key_developments=posts[:3],
            unresolved_events=(),
            source_post_ids=(),
        )
