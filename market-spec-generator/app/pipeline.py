from __future__ import annotations

import asyncio

from .classifier import Classifier
from .dedup import Deduplicator
from .embeddings import Embedder, canonical_text
from .grounding import Grounder
from .models import (
    Candidate,
    Classification,
    EventSpec,
    Decision,
    DuplicateCheck,
    Grounding,
    Market,
    MarketSpec,
    PipelineResult,
    TweetCluster,
    utcnow_iso,
)
from .question import QuestionGenerator
from .spec_validation import MarketSpecValidationError
from .store import DuplicateMarketError, VectorStore, canonical_key, new_market_id


class Pipeline:
    """classify -> dedup against the vector DB -> generate the question -> store.

    Short-circuits at the first stage that says no, so a REJECT costs one LLM call
    and a duplicate costs two, not four.
    """

    def __init__(
        self,
        classifier: Classifier,
        deduplicator: Deduplicator,
        generator: QuestionGenerator,
        store: VectorStore,
        embedder: Embedder,
        grounder: Grounder | None = None,
        *,
        embedding_model: str = "",
    ) -> None:
        self.classifier = classifier  # public: callers may run stage 1 alone
        self._grounder = grounder
        self._dedup = deduplicator
        self.generator = generator  # public: EventSpec -> MarketSpec on its own
        self._store = store
        self._embedder = embedder
        self._embedding_model = embedding_model
        # Serializes only the final write, not the LLM calls before it.
        self._write_lock = asyncio.Lock()

    async def run(self, cluster: TweetCluster, *, dry_run: bool = False) -> PipelineResult:
        classification = await self.classifier.classify(cluster)

        if classification.decision is not Decision.CREATE:
            return PipelineResult(
                decision=classification.decision.value,
                event=classification.event,
                query=classification.query,
                reason=classification.reason,
                classification=classification,
            )

        # Grounding runs before dedup: an unfounded market shouldn't cost an
        # embedding call, and WAIT is the honest answer when the posts don't
        # actually say what the classifier claims they say.
        grounding = None
        if self._grounder is not None:
            grounding = await self._grounder.check(classification, cluster)
            if not grounding.supported:
                return PipelineResult(
                    decision="WAIT",
                    event=classification.event,
                    query=classification.query,
                    reason=grounding.reason,
                    classification=classification,
                    grounding=grounding,
                )

        check, vector = await self._dedup.check(classification)
        if check.is_duplicate:
            return PipelineResult(
                decision="DUPLICATE",
                event=classification.event,
                query=classification.query,
                reason=check.reason,
                duplicate_of=check.duplicate_of,
                classification=classification,
                grounding=grounding,
                candidates=check.candidates,
            )

        # The generator's boundary is EventSpec -> MarketSpec; adapting here keeps
        # classifier types out of it entirely.
        event_spec = EventSpec.from_classification(classification, cluster)
        try:
            spec = await self.generator.generate(event_spec)
        except MarketSpecValidationError as exc:
            # A spec that cannot be validated is not a market. Surface it as WAIT
            # with the reasons rather than persisting something unresolvable.
            return PipelineResult(
                decision="WAIT",
                event=classification.event,
                query=classification.query,
                reason=f"Generated market spec failed validation: {exc}",
                classification=classification,
                grounding=grounding,
                candidates=check.candidates,
            )

        market = build_market_from_spec(
            spec,
            market_id=self._store.new_id(),
            entities=classification.entities,
            source_tweet_ids=[t.id for t in cluster.tweets],
            metadata={
                "cluster_id": cluster.cluster_id,
                "topic": cluster.topic,
                "engagement": cluster.total_engagement,
                "classifier_confidence": classification.confidence,
                "embedding_model": self._embedding_model,
                "nearest_similarity": check.candidates[0].similarity if check.candidates else None,
            },
        )

        if not dry_run:
            # The dedup check above happened before an LLM call that takes
            # seconds. Two identical clusters ingested concurrently would both
            # pass it and both write, so the write re-checks under a lock and the
            # store's UNIQUE canonical_key backstops anything outside this
            # process.
            async with self._write_lock:
                existing = self._store.get_by_canonical_key(canonical_key(market))
                if existing is not None and existing.status in ("open", "pending_resolution"):
                    return _duplicate_result(classification, check, existing)
                try:
                    self._store.upsert(market, vector)
                except DuplicateMarketError as exc:
                    winner = self._store.get(exc.existing_id)
                    if winner is None:
                        raise
                    return _duplicate_result(classification, check, winner)

        return PipelineResult(
            decision="CREATE",
            event=classification.event,
            query=classification.query,
            reason=check.reason,
            market=market,
            spec=spec,
            classification=classification,
            grounding=grounding,
            candidates=check.candidates,
        )

    async def check_only(self, classification: Classification) -> DuplicateCheck:
        """Dedup without creating anything — for a 'does this market exist?' UI."""
        check, _ = await self._dedup.check(classification)
        return check

    async def add_existing(self, market: Market) -> Market:
        """Index a market that was created outside this pipeline (backfill/seed)."""
        vector = await self._embedder.embed_one(
            canonical_text(
                event=market.event,
                query=market.query,
                entities=market.entities,
                category=market.category,
                resolution_date=market.resolution_date,
            )
        )
        market.metadata.setdefault("embedding_model", self._embedding_model)
        return self._store.upsert(market, vector)


def _duplicate_result(
    classification: Classification, check: DuplicateCheck, existing: Market
) -> PipelineResult:
    """A market that lost the create race is reported exactly like any duplicate."""
    return PipelineResult(
        decision="DUPLICATE",
        event=classification.event,
        query=classification.query,
        reason=f"An identical market ({existing.id}) was created concurrently.",
        duplicate_of=Candidate(
            market_id=existing.id,
            question=existing.question,
            event=existing.event,
            resolution_date=existing.resolution_date,
            status=existing.status,
            similarity=1.0,
        ),
        classification=classification,
        candidates=check.candidates,
    )


def build_market_from_spec(
    spec: MarketSpec,
    *,
    entities: list[str] | None = None,
    source_tweet_ids: list[str] | None = None,
    metadata: dict | None = None,
    market_id: str | None = None,
) -> Market:
    """The MarketSpec is the authoritative definition — persistence just mirrors it.

    Nothing here reassembles the market from classifier leftovers; only fields
    the spec deliberately does not own (source tweets, bookkeeping) come from
    outside.
    """
    return Market(
        id=market_id or new_market_id(),
        question=spec.question,
        event=spec.canonical_event,
        query=spec.source_query or "",
        category=spec.category or "other",
        entities=list(entities or []),
        resolution_criteria=spec.resolution_criteria,
        resolution_date=spec.resolution_date.isoformat()[:10] if spec.resolution_date else None,
        resolution_source=spec.resolution_sources[0] if spec.resolution_sources else "",
        resolution_sources=list(spec.resolution_sources),
        outcomes=list(spec.outcomes),
        closes_at=spec.closes_at.isoformat() if spec.closes_at else None,
        status="open",
        created_at=utcnow_iso(),
        source_tweet_ids=list(source_tweet_ids or []),
        metadata=dict(metadata or {}),
    )
