from __future__ import annotations

from datetime import datetime, timezone
from typing import Protocol

from .llm import JSONLLM, LLMError
from .models import Market, Outcome, Settlement, SweepResult, Verdict, utcnow_iso
from .prompts import RESOLVER_SYSTEM, RESOLVER_USER
from .store import VectorStore


class OutcomeSource(Protocol):
    """Anything that can say how a market actually turned out."""

    name: str

    async def resolve(self, market: Market) -> Verdict: ...


class ManualOutcomeSource:
    """Never decides anything — every due market goes to a human.

    The correct default. Settling markets by guess is worse than settling them
    late, because money has already changed hands on the answer.
    """

    name = "manual"

    async def resolve(self, market: Market) -> Verdict:
        return Verdict(outcome=Outcome.UNKNOWN, confidence=0.0, source=self.name,
                       evidence="No automated outcome source is configured.")


class LLMOutcomeSource:
    """Asks the model how a market resolved.

    A plain chat model has a training cutoff and no live data, so for anything
    that happened after that cutoff it should — and mostly does — answer UNKNOWN.
    That is the useful behaviour, not a failure: the model's job here is to
    settle only the cases it genuinely knows and hand everything else to review.

    Point this at a model with live retrieval (Grok with X search, or a chat
    model wired to a real scores/markets feed) and the auto-settle rate climbs.
    Until then expect most sweeps to produce pending_resolution, which is honest.
    """

    name = "llm"

    def __init__(self, llm: JSONLLM, *, min_confidence: float = 0.9) -> None:
        self._llm = llm
        self._min_confidence = min_confidence

    async def resolve(self, market: Market) -> Verdict:
        today = datetime.now(timezone.utc).date().isoformat()
        try:
            raw = await self._llm.json(
                system=RESOLVER_SYSTEM,
                user=RESOLVER_USER.format(
                    today=today,
                    question=market.question,
                    event=market.event,
                    criteria=market.resolution_criteria or "(none recorded)",
                    source=market.resolution_source or "(none recorded)",
                    resolution_date=market.resolution_date or "unknown",
                ),
            )
        except LLMError as exc:
            return Verdict(outcome=Outcome.UNKNOWN, confidence=0.0, source=self.name,
                           evidence=f"Outcome lookup failed: {exc}")

        raw_outcome = str(raw.get("outcome", "")).strip().upper()
        outcome = Outcome(raw_outcome) if raw_outcome in Outcome.__members__ else Outcome.UNKNOWN
        try:
            confidence = min(1.0, max(0.0, float(raw.get("confidence", 0.0))))
        except (TypeError, ValueError):
            confidence = 0.0

        # Below the bar, downgrade to UNKNOWN so it routes to a human rather than
        # settling on a hunch.
        if outcome is not Outcome.UNKNOWN and confidence < self._min_confidence:
            return Verdict(
                outcome=Outcome.UNKNOWN, confidence=confidence, source=self.name,
                evidence=(
                    f"Model said {outcome.value} at confidence {confidence:.2f}, below the "
                    f"{self._min_confidence:.2f} auto-settle bar. {raw.get('evidence', '')}".strip()
                ),
            )

        return Verdict(outcome=outcome, confidence=confidence, source=self.name,
                       evidence=str(raw.get("evidence") or "").strip())


class Resolver:
    """Stage 4: settle markets whose resolution date has arrived.

    Finding due markets is deterministic. Deciding the outcome is delegated to an
    OutcomeSource, and anything it can't answer confidently becomes
    `pending_resolution` for a human to settle via `POST /markets/{id}/settle`.
    Nothing auto-settles on a guess.
    """

    def __init__(self, store: VectorStore, source: OutcomeSource) -> None:
        self._store = store
        self._source = source

    async def sweep(self, *, on_date: str | None = None, limit: int = 100) -> SweepResult:
        on_date = on_date or datetime.now(timezone.utc).date().isoformat()
        due = self._store.due_for_resolution(on_date=on_date, limit=limit)

        result = SweepResult(checked=len(due))
        for market in due:
            verdict = await self._source.resolve(market)

            if verdict.outcome is Outcome.UNKNOWN:
                self._store.set_status(market.id, "pending_resolution")
                result.pending_review += 1
                result.settlements.append(Settlement(
                    market_id=market.id, question=market.question,
                    status="pending_resolution", confidence=verdict.confidence,
                    evidence=verdict.evidence, note="Needs manual settlement.",
                ))
                continue

            settled = self._store.settle(
                market.id, outcome=verdict.outcome.value,
                evidence=f"[{verdict.source}] {verdict.evidence}".strip(),
                resolved_at=utcnow_iso(),
            )
            result.settled += 1
            result.settlements.append(Settlement(
                market_id=market.id, question=market.question,
                status=settled.status if settled else "resolved",
                outcome=verdict.outcome.value, confidence=verdict.confidence,
                evidence=verdict.evidence, note=f"Settled by {verdict.source}.",
            ))

        return result

    def settle_manually(
        self, market_id: str, *, outcome: str, evidence: str = ""
    ) -> Market | None:
        return self._store.settle(
            market_id, outcome=outcome, evidence=evidence or "Settled manually.",
            resolved_at=utcnow_iso(),
        )
