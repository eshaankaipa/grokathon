from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

Decision = Literal["CREATE", "WAIT", "REJECT"]


def clamp01(x: float) -> float:
    """Clamp a value into the inclusive range [0.0, 1.0]."""
    x = float(x)
    if x < 0.0:
        return 0.0
    if x > 1.0:
        return 1.0
    return x


@dataclass(frozen=True)
class CandidateTopic:
    """Normalized, X-agnostic description of a topic to be classified."""

    topic_id: str
    topic_name: str
    representative_posts: list[str] = field(default_factory=list)
    post_count: int | None = None
    unique_author_count: int | None = None
    engagement_count: int | None = None
    impression_count: int | None = None
    volume_velocity: float | None = None
    volume_growth: float | None = None
    topic_age_minutes: float | None = None
    metadata: dict = field(default_factory=dict)


@dataclass(frozen=True)
class SemanticFeatures:
    """Semantic judgments about a topic; the five scores are clamped to 0..1."""

    eventness: float
    resolvability: float
    unresolvedness: float
    subjectivity: float
    specificity: float
    canonical_event: str | None = None
    reasoning_summary: str | None = None

    def __post_init__(self) -> None:
        for name in ("eventness", "resolvability", "unresolvedness",
                     "subjectivity", "specificity"):
            object.__setattr__(self, name, clamp01(getattr(self, name)))


@dataclass(frozen=True)
class NumericFeatures:
    """Normalized deterministic signals; all values clamped to 0..1."""

    attention: float
    velocity: float
    engagement: float
    diversity: float
    freshness: float

    def __post_init__(self) -> None:
        for name in ("attention", "velocity", "engagement", "diversity", "freshness"):
            object.__setattr__(self, name, clamp01(getattr(self, name)))


@dataclass(frozen=True)
class ClassificationResult:
    """Structured output of the classifier."""

    decision: Decision
    score: float
    canonical_event: str | None
    query: str | None
    semantic_features: SemanticFeatures
    numeric_features: NumericFeatures
    reasons: list[str] = field(default_factory=list)
