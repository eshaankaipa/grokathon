from __future__ import annotations

from datetime import date, datetime, timezone

from .llm import JSONLLM
from .models import Classification, Decision, TweetCluster
from .prompts import CLASSIFIER_SYSTEM, CLASSIFIER_USER

VALID_CATEGORIES = {
    "sports", "politics", "crypto", "markets", "tech",
    "entertainment", "science", "weather", "other",
}


class Classifier:
    """Stage 1: a cluster of tweets -> CREATE / WAIT / REJECT + a canonical event."""

    def __init__(self, llm: JSONLLM, *, min_engagement: int = 500) -> None:
        self._llm = llm
        self._min_engagement = min_engagement

    async def classify(self, cluster: TweetCluster) -> Classification:
        today = datetime.now(timezone.utc).date().isoformat()
        raw = await self._llm.json(
            system=CLASSIFIER_SYSTEM,
            user=CLASSIFIER_USER.format(today=today, digest=cluster.digest()),
        )
        result = _coerce(raw)

        # Deterministic guards the model does not get a vote on.
        if result.decision is Decision.CREATE:
            if cluster.total_engagement < self._min_engagement:
                return result.model_copy(
                    update={
                        "decision": Decision.WAIT,
                        "reason": (
                            f"Tradeable, but the cluster only has {cluster.total_engagement} "
                            f"weighted engagement (floor is {self._min_engagement})."
                        ),
                    }
                )
            if not result.event.strip() or not result.query.strip():
                return result.model_copy(
                    update={
                        "decision": Decision.WAIT,
                        "reason": "No canonical event could be extracted from the cluster.",
                    }
                )
            if _is_past(result.resolution_date, today):
                return result.model_copy(
                    update={
                        "decision": Decision.REJECT,
                        "reason": f"Resolution date {result.resolution_date} is already in the past.",
                    }
                )
        return result


def _coerce(raw: dict) -> Classification:
    """Normalize whatever the model returned into a Classification."""
    decision_raw = str(raw.get("decision", "")).strip().upper()
    decision = Decision(decision_raw) if decision_raw in Decision.__members__ else Decision.WAIT

    category = str(raw.get("category") or "other").strip().lower()
    if category not in VALID_CATEGORIES:
        category = "other"

    entities_raw = raw.get("entities") or []
    entities = [str(e).strip() for e in entities_raw if str(e).strip()] if isinstance(entities_raw, list) else []

    try:
        confidence = min(1.0, max(0.0, float(raw.get("confidence", 0.0))))
    except (TypeError, ValueError):
        confidence = 0.0

    return Classification(
        decision=decision,
        event=str(raw.get("event") or "").strip(),
        query=str(raw.get("query") or "").strip(),
        category=category,
        entities=entities,
        resolution_date=_clean_date(raw.get("resolution_date")),
        confidence=confidence,
        reason=str(raw.get("reason") or "").strip()
        or ("model returned an unrecognized decision; defaulted to WAIT" if decision_raw not in Decision.__members__ else ""),
    )


def _clean_date(value: object) -> str | None:
    if not value:
        return None
    text = str(value).strip()[:10]
    try:
        return date.fromisoformat(text).isoformat()
    except ValueError:
        return None


def _is_past(resolution_date: str | None, today: str) -> bool:
    return bool(resolution_date) and resolution_date < today  # type: ignore[operator]
