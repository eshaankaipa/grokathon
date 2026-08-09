from __future__ import annotations

from .config import ClassifierConfig
from .gates import check_hard_gates
from .models import CandidateTopic, ClassificationResult
from .numeric_features import extract_numeric_features
from .scoring import build_query, marketability_score
from .semantic.base import SemanticClassifier

_OPTIONAL_FIELDS = (
    "post_count", "unique_author_count", "engagement_count", "impression_count",
    "volume_velocity", "volume_growth", "topic_age_minutes",
)


class MarketCandidateClassifier:
    """Classify a CandidateTopic as CREATE / WAIT / REJECT.

    Dependencies are injected; this component never calls X or Grok directly.
    """

    def __init__(
        self,
        semantic_classifier: SemanticClassifier,
        config: ClassifierConfig | None = None,
    ) -> None:
        self._semantic = semantic_classifier
        self._config = config or ClassifierConfig()

    async def classify(self, candidate: CandidateTopic, context=None) -> ClassificationResult:
        cfg = self._config
        reasons: list[str] = []

        numeric = extract_numeric_features(candidate, cfg)
        semantic = await self._semantic.classify(candidate, context)
        canonical = semantic.canonical_event

        missing = [f for f in _OPTIONAL_FIELDS if getattr(candidate, f) is None]
        if missing:
            reasons.append(
                "missing X features (treated as low signal): " + ", ".join(missing)
            )

        score = marketability_score(numeric, semantic, cfg)

        gate_failures = check_hard_gates(semantic, cfg)
        if gate_failures:
            reasons.extend(gate_failures)
            reasons.append("hard gate failed -> REJECT regardless of attention")
            return ClassificationResult(
                decision="REJECT", score=score, canonical_event=canonical,
                query=None, semantic_features=semantic, numeric_features=numeric,
                reasons=reasons,
            )

        reasons.append(f"passed hard gates; marketability score {score:.2f}")

        if score >= cfg.create_threshold and semantic.specificity >= cfg.min_specificity_for_create:
            reasons.append(
                f"score >= create_threshold {cfg.create_threshold:.2f} and "
                f"specificity >= {cfg.min_specificity_for_create:.2f} -> CREATE"
            )
            return ClassificationResult(
                decision="CREATE", score=score, canonical_event=canonical,
                query=build_query(semantic, candidate),
                semantic_features=semantic, numeric_features=numeric, reasons=reasons,
            )

        if score >= cfg.wait_threshold:
            if semantic.specificity < cfg.min_specificity_for_create:
                reasons.append(
                    f"specificity {semantic.specificity:.2f} < "
                    f"{cfg.min_specificity_for_create:.2f} -> WAIT (need concrete info)"
                )
            else:
                reasons.append(
                    f"score < create_threshold {cfg.create_threshold:.2f} -> "
                    "WAIT (insufficient activity)"
                )
            return ClassificationResult(
                decision="WAIT", score=score, canonical_event=canonical,
                query=None, semantic_features=semantic, numeric_features=numeric,
                reasons=reasons,
            )

        reasons.append(
            f"score {score:.2f} < wait_threshold {cfg.wait_threshold:.2f} -> "
            "REJECT (extremely weak signal)"
        )
        return ClassificationResult(
            decision="REJECT", score=score, canonical_event=canonical,
            query=None, semantic_features=semantic, numeric_features=numeric,
            reasons=reasons,
        )
