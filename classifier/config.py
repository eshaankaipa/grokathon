from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class ClassifierConfig:
    """All tunables for the classifier. Nothing is hardcoded elsewhere."""

    # --- scoring weights (positive terms sum to 1.0) ---
    attention_weight: float = 0.10
    velocity_weight: float = 0.15
    engagement_weight: float = 0.10
    eventness_weight: float = 0.20
    resolvability_weight: float = 0.20
    unresolvedness_weight: float = 0.15
    specificity_weight: float = 0.10
    subjectivity_penalty: float = 0.25

    # --- decision thresholds (applied to the normalized 0..1 score) ---
    create_threshold: float = 0.62
    wait_threshold: float = 0.40

    # --- hard gates (a failure forces REJECT regardless of popularity) ---
    min_eventness: float = 0.50
    min_resolvability: float = 0.50
    min_unresolvedness: float = 0.35
    # specificity below this downgrades an otherwise-CREATE candidate to WAIT
    min_specificity_for_create: float = 0.45

    # --- normalization saturation constants (feature value that maps to ~0.5) ---
    attention_saturation_posts: float = 5000.0
    velocity_saturation: float = 200.0
    growth_saturation: float = 3.0
    engagement_saturation: float = 50000.0
    freshness_halflife_minutes: float = 720.0
    impression_saturation: float = 1_000_000.0

    # --- how a missing (None) deterministic feature normalizes ---
    missing_feature_value: float = 0.0
