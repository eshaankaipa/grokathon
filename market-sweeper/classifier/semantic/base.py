from __future__ import annotations

from abc import ABC, abstractmethod
from typing import TYPE_CHECKING

from ..models import CandidateTopic, SemanticFeatures

if TYPE_CHECKING:
    from context.models import TopicContext


class SemanticClassifier(ABC):
    """Interface the classifier depends on for semantic judgments.

    Implementations must not leak transport/SDK details to callers.
    """

    @abstractmethod
    async def classify(
        self, candidate: CandidateTopic, context: "TopicContext | None" = None
    ) -> SemanticFeatures:
        """Return semantic features for the candidate, optionally enriched by context."""
        raise NotImplementedError
