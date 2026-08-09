from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app.classifier import Classifier
from app.dedup import Deduplicator
from app.pipeline import Pipeline
from app.question import QuestionGenerator
from app.models import Tweet, TweetCluster
from tests.conftest import FakeLLM

CLUSTER = TweetCluster(
    cluster_id="c1",
    topic="#NBA",
    tweets=[
        Tweet(id="1", text="Lakers at Warriors on August 8 2026", likes=9000, reposts=2000),
        Tweet(id="2", text="Chase Center Aug 8, Dubs vs Lakers", likes=3000, reposts=500),
    ],
)

# Relative, not hardcoded: the classifier rejects past resolution dates, so a
# fixed date silently turns every CREATE into a REJECT once that day passes.
FUTURE_DATE = (datetime.now(timezone.utc) + timedelta(days=30)).date().isoformat()

CLASSIFY_CREATE = {
    "decision": "CREATE",
    "event": "Golden State Warriors vs Los Angeles Lakers, Aug 8 2026",
    "query": "Warriors Lakers August 8 2026",
    "category": "sports",
    "entities": ["Golden State Warriors", "Los Angeles Lakers"],
    "resolution_date": FUTURE_DATE,
    "confidence": 0.92,
    "reason": "Scheduled NBA game.",
}

# A complete MarketSpec draft, as the upgraded generator prompt now asks for.
GENERATE = {
    "question": "Will the Golden State Warriors defeat the Los Angeles Lakers on August 8, 2026",
    "outcomes": ["YES", "NO"],
    "closes_at": None,
    "resolution_date": FUTURE_DATE,
    "resolution_criteria": (
        "Resolve YES if official NBA records list the Golden State Warriors as the winner "
        "of the August 8, 2026 game. Resolve NO if official NBA records list the Los Angeles "
        "Lakers as the winner. If the game is permanently cancelled and not replayed, "
        "resolve VOID."
    ),
    "resolution_sources": ["Official NBA game results"],
    "category": "sports",
    "canonical_event": "Golden State Warriors vs Los Angeles Lakers, Aug 8 2026",
}


def build(store, embedder, llm: FakeLLM) -> Pipeline:
    return Pipeline(
        classifier=Classifier(llm, min_engagement=500),
        deduplicator=Deduplicator(store, embedder, llm),
        generator=QuestionGenerator(llm),
        store=store,
        embedder=embedder,
        embedding_model="fake",
    )


async def test_create_path_persists_a_market(store, embedder):
    llm = FakeLLM([CLASSIFY_CREATE, GENERATE])
    result = await build(store, embedder, llm).run(CLUSTER)

    assert result.decision == "CREATE"
    assert result.market is not None
    assert result.market.question.endswith("?")  # generator forgot it; we fix it
    assert result.market.resolution_date == FUTURE_DATE
    assert result.market.source_tweet_ids == ["1", "2"]
    assert store.count() == 1

    stored = store.get(result.market.id)
    assert stored.question == result.market.question
    assert stored.metadata["cluster_id"] == "c1"


async def test_second_identical_cluster_is_a_duplicate(store, embedder):
    pipeline = build(store, embedder, FakeLLM([CLASSIFY_CREATE, GENERATE]))
    first = await pipeline.run(CLUSTER)
    assert first.decision == "CREATE"

    # Same classification -> identical vector -> threshold short-circuit, no judge call.
    pipeline2 = build(store, embedder, FakeLLM([CLASSIFY_CREATE]))
    second = await pipeline2.run(CLUSTER)

    assert second.decision == "DUPLICATE"
    assert second.duplicate_of.market_id == first.market.id
    assert store.count() == 1


async def test_reject_costs_one_llm_call(store, embedder):
    llm = FakeLLM([{"decision": "REJECT", "reason": "Subjective opinion.", "event": "", "query": ""}])
    result = await build(store, embedder, llm).run(CLUSTER)

    assert result.decision == "REJECT"
    assert result.market is None
    assert len(llm.calls) == 1
    assert store.count() == 0


async def test_wait_does_not_touch_the_vector_store(store, embedder):
    llm = FakeLLM([{"decision": "WAIT", "reason": "Date unknown.", "event": "Some fight", "query": "fight"}])
    result = await build(store, embedder, llm).run(CLUSTER)

    assert result.decision == "WAIT"
    assert result.event == "Some fight"
    assert embedder.calls == []
    assert store.count() == 0


async def test_dry_run_skips_persistence(store, embedder):
    llm = FakeLLM([CLASSIFY_CREATE, GENERATE])
    result = await build(store, embedder, llm).run(CLUSTER, dry_run=True)

    assert result.decision == "CREATE"
    assert result.market is not None
    assert store.count() == 0


async def test_market_is_built_from_the_spec_not_reassembled(store, embedder):
    """The MarketSpec is the authoritative definition of the market.

    Note the behavioural change: EventSpec carries no resolution_date field, so
    the generator's date is now authoritative rather than being overridden by the
    classifier's. The classifier's date reaches the model as context only.
    """
    other_date = (datetime.now(timezone.utc) + timedelta(days=31)).date().isoformat()
    llm = FakeLLM([CLASSIFY_CREATE, {**GENERATE, "resolution_date": other_date}])
    result = await build(store, embedder, llm).run(CLUSTER)

    assert result.market.resolution_date == other_date
    assert result.spec is not None
    assert result.spec.canonical_event == CLASSIFY_CREATE["event"]
    assert result.market.outcomes == ["YES", "NO"]
    assert result.market.resolution_sources == ["Official NBA game results"]
    assert result.market.closes_at is None
