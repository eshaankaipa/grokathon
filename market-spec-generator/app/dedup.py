from __future__ import annotations

import json

import numpy as np

from .embeddings import Embedder, canonical_text
from .llm import JSONLLM, LLMError
from .models import Candidate, Classification, DuplicateCheck
from .prompts import JUDGE_SYSTEM, JUDGE_USER
from .store import VectorStore


class Deduplicator:
    """Stage 2: does this market already exist?

    Two passes. The vector store does recall — cheap, high-recall, no LLM. Then an
    LLM judge does precision on whatever came back, because cosine similarity
    cannot tell "Warriors beat Lakers" (same market, inverted) from "Warriors vs
    Lakers next Tuesday" (different market, nearly identical text).
    """

    def __init__(
        self,
        store: VectorStore,
        embedder: Embedder,
        llm: JSONLLM | None = None,
        *,
        recall_k: int = 8,
        candidate_floor: float = 0.55,
        auto_duplicate_threshold: float = 0.97,
    ) -> None:
        self._store = store
        self._embedder = embedder
        self._llm = llm
        self._recall_k = recall_k
        self._floor = candidate_floor
        self._auto = auto_duplicate_threshold

    async def check(self, classification: Classification) -> tuple[DuplicateCheck, np.ndarray]:
        """Returns the verdict plus the embedding, so callers don't re-embed to store."""
        text = canonical_text(
            event=classification.event,
            query=classification.query,
            entities=classification.entities,
            category=classification.category,
            resolution_date=classification.resolution_date,
        )
        vector = await self._embedder.embed_one(text)

        hits = self._store.search(vector, k=self._recall_k, min_similarity=self._floor)
        candidates = [
            Candidate(
                market_id=h.market.id,
                question=h.market.question,
                event=h.market.event,
                resolution_date=h.market.resolution_date,
                status=h.market.status,
                similarity=h.similarity,
            )
            for h in hits
        ]

        if not candidates:
            return DuplicateCheck(is_duplicate=False, method="none",
                                  reason="No existing market is semantically close."), vector

        # Near-identical vectors can skip the judge — but ONLY when the resolution
        # dates also agree. Measured against text-embedding-3-small, the same
        # fixture one day apart scores 0.984 while a genuine inverted-phrasing
        # duplicate scores 0.901: similarity alone ranks the false duplicate above
        # the true one, so an unguarded threshold blocks legitimate markets.
        top = candidates[0]
        if top.similarity >= self._auto and _dates_agree(classification.resolution_date, top.resolution_date):
            return DuplicateCheck(
                is_duplicate=True,
                duplicate_of=top,
                method="threshold",
                confidence=top.similarity,
                reason=(
                    f"Cosine similarity {top.similarity:.3f} exceeds the auto-duplicate "
                    f"threshold and the resolution dates match."
                ),
                candidates=candidates,
            ), vector

        if self._llm is None:
            return DuplicateCheck(
                is_duplicate=False, method="threshold", confidence=1.0 - top.similarity,
                reason=(
                    f"Closest market is {top.similarity:.3f} similar but did not clear the "
                    f"auto-duplicate gate; judge disabled, so allowing creation."
                ),
                candidates=candidates,
            ), vector

        verdict = await self._judge(classification, candidates)
        return verdict, vector

    async def _judge(self, classification: Classification, candidates: list[Candidate]) -> DuplicateCheck:
        rendered = "\n".join(
            f'- id={c.market_id} | similarity={c.similarity:.3f} | resolves={c.resolution_date or "unknown"}\n'
            f"  question: {c.question}\n"
            f"  event: {c.event}"
            for c in candidates
        )
        try:
            raw = await self._llm.json(  # type: ignore[union-attr]
                system=JUDGE_SYSTEM,
                user=JUDGE_USER.format(
                    event=classification.event,
                    query=classification.query,
                    entities=json.dumps(classification.entities),
                    resolution_date=classification.resolution_date or "unknown",
                    candidates=rendered,
                ),
            )
        except LLMError as exc:
            # Fail open: a market that slips through is recoverable, a blocked one is not.
            return DuplicateCheck(
                is_duplicate=False, method="judge", confidence=0.0,
                reason=f"Judge failed ({exc}); allowing creation.", candidates=candidates,
            )

        dup_id = raw.get("duplicate_of")
        dup_id = str(dup_id).strip() if dup_id not in (None, "", "null") else None
        match = next((c for c in candidates if c.market_id == dup_id), None)

        try:
            confidence = min(1.0, max(0.0, float(raw.get("confidence", 0.0))))
        except (TypeError, ValueError):
            confidence = 0.0
        reason = str(raw.get("reason") or "").strip()

        if match is None:
            if dup_id:
                reason = f"Judge named unknown market {dup_id!r}; treating as new. {reason}".strip()
            return DuplicateCheck(is_duplicate=False, method="judge", confidence=confidence,
                                  reason=reason or "No existing market settles on the same outcome.",
                                  candidates=candidates)

        return DuplicateCheck(is_duplicate=True, duplicate_of=match, method="judge",
                              confidence=confidence,
                              reason=reason or "An existing market resolves on the same outcome.",
                              candidates=candidates)


def _dates_agree(proposed: str | None, existing: str | None) -> bool:
    """True only when both dates are known and identical, or both are unknown.

    One-sided unknowns go to the judge rather than being assumed equal.
    """
    return proposed == existing
