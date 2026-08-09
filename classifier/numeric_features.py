from __future__ import annotations

import math

from .config import ClassifierConfig
from .models import CandidateTopic, NumericFeatures, clamp01


def _sat(value: float | None, k: float) -> float | None:
    """Saturating normalization value/(value+k) in [0,1); None if value absent."""
    if value is None:
        return None
    v = max(0.0, float(value))
    if k <= 0:
        return 1.0
    return v / (v + k)


def _mean(parts: list[float]) -> float:
    return sum(parts) / len(parts)


def _attention(c: CandidateTopic, cfg: ClassifierConfig) -> float:
    posts = _sat(c.post_count, cfg.attention_saturation_posts)
    impr = _sat(c.impression_count, cfg.impression_saturation)
    parts = [p for p in (posts, impr) if p is not None]
    return clamp01(_mean(parts)) if parts else cfg.missing_feature_value


def _velocity(c: CandidateTopic, cfg: ClassifierConfig) -> float:
    vel = _sat(c.volume_velocity, cfg.velocity_saturation)
    grow = _sat(c.volume_growth, cfg.growth_saturation)
    if vel is not None and grow is not None:
        return clamp01(0.7 * vel + 0.3 * grow)
    if vel is not None:
        return clamp01(vel)
    if grow is not None:
        return clamp01(grow)
    return cfg.missing_feature_value


def _engagement(c: CandidateTopic, cfg: ClassifierConfig) -> float:
    e = _sat(c.engagement_count, cfg.engagement_saturation)
    return clamp01(e) if e is not None else cfg.missing_feature_value


def _diversity(c: CandidateTopic, cfg: ClassifierConfig) -> float:
    if c.unique_author_count is None:
        return cfg.missing_feature_value
    if c.post_count and c.post_count > 0:
        return clamp01(c.unique_author_count / c.post_count)
    sat = _sat(c.unique_author_count, cfg.attention_saturation_posts)
    return clamp01(sat) if sat is not None else cfg.missing_feature_value


def _freshness(c: CandidateTopic, cfg: ClassifierConfig) -> float:
    if c.topic_age_minutes is None:
        return cfg.missing_feature_value
    age = max(0.0, float(c.topic_age_minutes))
    if cfg.freshness_halflife_minutes <= 0:
        return cfg.missing_feature_value
    return clamp01(math.exp(-age / cfg.freshness_halflife_minutes))


def extract_numeric_features(
    candidate: CandidateTopic, config: ClassifierConfig | None = None
) -> NumericFeatures:
    """Convert deterministic X-derived signals into normalized 0..1 features.

    Every field is optional; a missing field normalizes to
    ``config.missing_feature_value`` rather than raising.
    """
    cfg = config or ClassifierConfig()
    return NumericFeatures(
        attention=_attention(candidate, cfg),
        velocity=_velocity(candidate, cfg),
        engagement=_engagement(candidate, cfg),
        diversity=_diversity(candidate, cfg),
        freshness=_freshness(candidate, cfg),
    )
