from __future__ import annotations

from .config import ClassifierConfig
from .models import SemanticFeatures


def check_hard_gates(
    semantic: SemanticFeatures, config: ClassifierConfig | None = None
) -> list[str]:
    """Return reasons any hard gate failed. Empty list means all gates pass.

    A non-empty result forces REJECT regardless of attention/engagement.
    """
    cfg = config or ClassifierConfig()
    failures: list[str] = []
    if semantic.eventness < cfg.min_eventness:
        failures.append(
            f"eventness {semantic.eventness:.2f} < min {cfg.min_eventness:.2f} "
            "(not a concrete real-world event)"
        )
    if semantic.resolvability < cfg.min_resolvability:
        failures.append(
            f"resolvability {semantic.resolvability:.2f} < min {cfg.min_resolvability:.2f} "
            "(outcome not objectively determinable)"
        )
    if semantic.unresolvedness < cfg.min_unresolvedness:
        failures.append(
            f"unresolvedness {semantic.unresolvedness:.2f} < min {cfg.min_unresolvedness:.2f} "
            "(outcome already known/resolved)"
        )
    return failures
