from __future__ import annotations

import json
from datetime import date, datetime, timezone
from typing import Any

from .llm import JSONLLM
from .models import DEFAULT_OUTCOMES, Classification, EventSpec, MarketSpec, TweetCluster
from .prompts import QUESTION_SYSTEM, QUESTION_USER, REPAIR_USER
from .spec_validation import (
    MAX_QUESTION_CHARS,
    ValidationIssue,
    is_valid,
    raise_for_issues,
    validate_market_spec,
)


class QuestionGenerator:
    """Approved canonical event -> a validated, self-contained MarketSpec.

    The boundary with the upstream sweeper: it takes an `EventSpec` (plain JSON,
    no classifier types, no tweets) and returns a `MarketSpec` that fully defines
    the market. Whether the event deserves a market was decided upstream — this
    stage only defines it precisely.

    The LLM drafts; `spec_validation` decides. An invalid draft gets exactly one
    repair pass seeded with the validator's issues, then the spec is rejected
    outright rather than quietly persisted.
    """

    def __init__(self, llm: JSONLLM, *, repair: bool = True) -> None:
        self._llm = llm
        self._repair = repair

    async def generate(
        self,
        event: EventSpec | Classification,
        cluster: TweetCluster | None = None,
    ) -> MarketSpec:
        """Preferred signature is `generate(EventSpec)`.

        A `Classification` is still accepted and adapted, so existing in-repo
        callers keep working — but the generator itself never depends on
        classifier internals or tweet objects.
        """
        if isinstance(event, Classification):
            event = EventSpec.from_classification(event, cluster)

        raw = await self._llm.json(
            system=QUESTION_SYSTEM, user=self._render(event), temperature=0.2
        )
        spec = self._coerce(raw, event)
        issues = validate_market_spec(spec)

        if is_valid(issues):
            return spec

        if not self._repair:
            raise_for_issues(issues)

        # One repair pass, never a loop: hand the validator's own complaints back.
        repaired_raw = await self._llm.json(
            system=QUESTION_SYSTEM,
            user=self._render(event) + "\n\n" + REPAIR_USER.format(
                issues="\n".join(f"- {i}" for i in issues)
            ),
            temperature=0.0,
        )
        repaired = self._coerce(repaired_raw, event)
        raise_for_issues(validate_market_spec(repaired))
        return repaired

    async def validate_only(self, spec: MarketSpec) -> list[ValidationIssue]:
        return validate_market_spec(spec)

    # -- internals ---------------------------------------------------------- #

    @staticmethod
    def _render(event: EventSpec) -> str:
        return QUESTION_USER.format(
            today=datetime.now(timezone.utc).date().isoformat(),
            canonical_event=event.canonical_event,
            category=event.category or "(unspecified)",
            entities=json.dumps(event.entities),
            query=event.query or "(none)",
            context_summary=event.context_summary or "(none)",
            key_developments=json.dumps(event.key_developments),
            unresolved_events=json.dumps(event.unresolved_events),
        )

    @staticmethod
    def _coerce(raw: dict[str, Any], event: EventSpec) -> MarketSpec:
        """Normalize model output into a MarketSpec.

        Repairs only what is unambiguous — trailing punctuation, whitespace,
        a source returned as a bare string. Anything requiring judgement is left
        alone for the validator to catch.
        """
        question = " ".join(str(raw.get("question") or "").split())
        if question and not question.endswith("?"):
            question = question.rstrip(".!") + "?"
        question = question[:MAX_QUESTION_CHARS]

        outcomes = _string_list(raw.get("outcomes")) or list(DEFAULT_OUTCOMES)
        # Accept a single legacy `resolution_source` as well as the list.
        sources = _string_list(raw.get("resolution_sources"))
        if not sources and raw.get("resolution_source"):
            sources = [str(raw["resolution_source"]).strip()]

        return MarketSpec(
            question=question,
            outcomes=outcomes,
            closes_at=_clean_datetime(raw.get("closes_at")),
            resolution_date=_clean_date(raw.get("resolution_date")),
            resolution_criteria=str(raw.get("resolution_criteria") or "").strip(),
            resolution_sources=sources,
            # A category the upstream system supplied is trusted over a re-guess.
            category=event.category or (str(raw["category"]).strip()
                                        if raw.get("category") else None),
            # Preserved verbatim: later dedup and market matching key off it.
            canonical_event=event.canonical_event,
            source_query=event.query,
        )


def _string_list(value: object) -> list[str]:
    if isinstance(value, str):
        return [value.strip()] if value.strip() else []
    if isinstance(value, list):
        return [str(v).strip() for v in value if str(v).strip()]
    return []


def _clean_date(value: object) -> date | None:
    if not value:
        return None
    try:
        return date.fromisoformat(str(value).strip()[:10])
    except ValueError:
        return None


def _clean_datetime(value: object) -> datetime | None:
    """Parse an ISO timestamp, or return None. Never fabricates a time."""
    if not value:
        return None
    text = str(value).strip().replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    # A bare date is not a closing *time* — treat it as absent rather than
    # silently inventing midnight.
    if len(text) <= 10:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
