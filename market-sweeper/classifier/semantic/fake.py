from __future__ import annotations

from ..models import CandidateTopic, SemanticFeatures
from .base import SemanticClassifier


class FakeSemanticClassifier(SemanticClassifier):
    """Deterministic semantic classifier for tests and offline demos."""

    def __init__(
        self,
        features_by_topic_id: dict[str, SemanticFeatures] | None = None,
        default: SemanticFeatures | None = None,
    ) -> None:
        self._by_id = features_by_topic_id or {}
        self._default = default or SemanticFeatures(
            eventness=0.5, resolvability=0.5, unresolvedness=0.5,
            subjectivity=0.5, specificity=0.5,
            canonical_event=None, reasoning_summary="fake default",
        )

    async def classify(self, candidate: CandidateTopic, context=None) -> SemanticFeatures:
        return self._by_id.get(candidate.topic_id, self._default)
