from __future__ import annotations

import re

from .config import ClassifierConfig
from .models import CandidateTopic, NumericFeatures, SemanticFeatures, clamp01

_STOPWORDS = {
    "the", "a", "an", "will", "is", "are", "be", "to", "of", "on", "in",
    "at", "vs", "versus", "and", "or", "game", "match", "for",
}


def marketability_score(
    numeric: NumericFeatures,
    semantic: SemanticFeatures,
    config: ClassifierConfig | None = None,
) -> float:
    """Weighted, subjectivity-penalized marketability score in [0, 1]."""
    cfg = config or ClassifierConfig()
    raw = (
        cfg.attention_weight * numeric.attention
        + cfg.velocity_weight * numeric.velocity
        + cfg.engagement_weight * numeric.engagement
        + cfg.eventness_weight * semantic.eventness
        + cfg.resolvability_weight * semantic.resolvability
        + cfg.unresolvedness_weight * semantic.unresolvedness
        + cfg.specificity_weight * semantic.specificity
    )
    positive_weight_sum = (
        cfg.attention_weight + cfg.velocity_weight + cfg.engagement_weight
        + cfg.eventness_weight + cfg.resolvability_weight
        + cfg.unresolvedness_weight + cfg.specificity_weight
    )
    normalized = raw / positive_weight_sum if positive_weight_sum > 0 else 0.0
    penalty = cfg.subjectivity_penalty * semantic.subjectivity
    return clamp01(normalized - penalty)


def build_query(semantic: SemanticFeatures, candidate: CandidateTopic) -> str | None:
    """Concise canonical search query (never a question) for the downstream layer."""
    source = semantic.canonical_event or candidate.topic_name
    if not source:
        return None
    tokens = re.findall(r"[A-Za-z0-9]+", source)
    kept = [t for t in tokens if t.lower() not in _STOPWORDS]
    query = " ".join(kept) if kept else " ".join(tokens)
    return query or None
