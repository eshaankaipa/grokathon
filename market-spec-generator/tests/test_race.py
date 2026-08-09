"""The create race: dedup checks, then an LLM call takes seconds, then the write.

Two identical clusters ingested concurrently both pass the check. Only one may
end up in the store.
"""

from __future__ import annotations

import asyncio

import pytest

from app.classifier import Classifier
from app.dedup import Deduplicator
from app.models import Market
from app.pipeline import Pipeline
from app.question import QuestionGenerator
from app.store import DuplicateMarketError, VectorStore, canonical_key, new_market_id
from tests.conftest import RoutingLLM
from tests.test_pipeline import CLASSIFY_CREATE, CLUSTER, GENERATE


class SlowLLM(RoutingLLM):
    """Yields control on every call so concurrent runs actually interleave —
    which is the whole point: it puts a real suspension point between the dedup
    check and the write."""

    async def json(self, *, system: str, user: str, temperature: float = 0.1):
        await asyncio.sleep(0.01)
        return await super().json(system=system, user=user, temperature=temperature)


def slow_llm() -> SlowLLM:
    return SlowLLM(classify=CLASSIFY_CREATE, question=GENERATE,
                   judge={"duplicate_of": None, "confidence": 0.9, "reason": "new"})


def build(store, embedder, llm) -> Pipeline:
    return Pipeline(
        classifier=Classifier(llm, min_engagement=500),
        deduplicator=Deduplicator(store, embedder, llm),
        generator=QuestionGenerator(llm),
        store=store,
        embedder=embedder,
        embedding_model="fake",
    )


async def test_concurrent_identical_ingests_create_one_market(store, embedder):
    pipeline = build(store, embedder, slow_llm())

    first, second = await asyncio.gather(pipeline.run(CLUSTER), pipeline.run(CLUSTER))

    decisions = sorted([first.decision, second.decision])
    assert decisions == ["CREATE", "DUPLICATE"], f"got {decisions}"
    assert store.count() == 1, "the race must not produce two markets"

    loser = first if first.decision == "DUPLICATE" else second
    winner = second if first.decision == "DUPLICATE" else first
    assert loser.duplicate_of.market_id == winner.market.id


async def test_many_concurrent_ingests_create_one_market(store, embedder):
    n = 6
    pipeline = build(store, embedder, slow_llm())

    results = await asyncio.gather(*(pipeline.run(CLUSTER) for _ in range(n)))

    assert [r.decision for r in results].count("CREATE") == 1
    assert store.count() == 1


async def test_unique_key_blocks_a_cross_process_write(store, embedder):
    """The lock only covers one process; the UNIQUE index is the real backstop."""
    assert store.unique_key_enforced

    base = dict(event="Warriors vs Lakers Aug 8 2026", query="warriors lakers",
                category="sports", entities=["Warriors", "Lakers"],
                resolution_date="2026-08-08")
    first = Market(id=new_market_id(), question="Will the Warriors win?", **base)
    second = Market(id=new_market_id(), question="Will the Lakers lose?", **base)

    vec = await embedder.embed_one("x")
    store.upsert(first, vec)

    with pytest.raises(DuplicateMarketError) as exc:
        store.upsert(second, vec)

    assert exc.value.existing_id == first.id
    assert store.count() == 1


async def test_updating_an_existing_market_is_not_a_conflict(store, embedder):
    m = Market(id=new_market_id(), question="v1", event="E", query="q",
               resolution_date="2026-08-08")
    vec = await embedder.embed_one("x")
    store.upsert(m, vec)

    m.question = "v2"
    store.upsert(m, vec)  # same id, same key — must not raise

    assert store.count() == 1
    assert store.get(m.id).question == "v2"


def test_canonical_key_ignores_wording_and_entity_order():
    a = Market(id="a", question="Will the Warriors win?", event="Warriors vs Lakers",
               query="x", entities=["Warriors", "Lakers"], resolution_date="2026-08-08")
    b = Market(id="b", question="Will the Lakers lose?", event="warriors  vs   lakers",
               query="y", entities=["lakers", "Warriors"], resolution_date="2026-08-08")
    assert canonical_key(a) == canonical_key(b)


def test_canonical_key_separates_dates():
    a = Market(id="a", question="q", event="Warriors vs Lakers", query="x",
               resolution_date="2026-08-08")
    b = Market(id="b", question="q", event="Warriors vs Lakers", query="x",
               resolution_date="2026-08-09")
    assert canonical_key(a) != canonical_key(b)


async def test_migration_adds_columns_to_an_existing_db(tmp_path, embedder):
    """A markets.db written before settlement existed must still open."""
    import sqlite3

    from app.store import SCHEMA

    path = tmp_path / "legacy.db"
    conn = sqlite3.connect(path)
    conn.executescript(SCHEMA)
    conn.execute(
        "INSERT INTO markets (id, question, event, query, category, entities, "
        "resolution_criteria, resolution_date, resolution_source, status, created_at, "
        "source_tweet_ids, metadata, embedding, embedding_model, dim) "
        "VALUES ('mkt_legacy','Q','E','q','sports','[]','','2026-08-08','','open',"
        "'2026-08-01T00:00:00+00:00','[]','{}',?,'',?)",
        ((await embedder.embed_one("E")).tobytes(), embedder.dim),
    )
    conn.commit()
    conn.close()

    store = VectorStore(path, dim=embedder.dim)
    try:
        market = store.get("mkt_legacy")
        assert market is not None
        assert market.outcome is None
        assert store.get_by_canonical_key(canonical_key(market)).id == "mkt_legacy"
    finally:
        store.close()


async def test_a_second_process_sees_writes_immediately(tmp_path, embedder):
    """Two VectorStore instances on one file model two uvicorn workers.

    The in-memory matrix only invalidates on writes made through the same
    instance, so without a cross-connection check worker B would keep searching a
    stale snapshot and silently miss duplicates that worker A had just created.
    """
    path = tmp_path / "workers.db"
    a = VectorStore(path, dim=embedder.dim)
    b = VectorStore(path, dim=embedder.dim)
    try:
        query = await embedder.embed_one("Warriors vs Lakers August 8 2026")
        assert b.search(query, k=5) == []          # B warms its cache while empty

        a.upsert(Market(id="m1", question="Will the Warriors win?",
                        event="Warriors vs Lakers August 8 2026", query="warriors lakers",
                        resolution_date="2026-08-08"), query)

        assert len(a.search(query, k=5)) == 1
        assert len(b.search(query, k=5)) == 1, "worker B is serving a stale index"

        a.delete("m1")
        assert b.search(query, k=5) == [], "worker B missed a delete"
    finally:
        a.close()
        b.close()


async def test_status_change_in_another_process_is_visible(tmp_path, embedder):
    path = tmp_path / "workers2.db"
    a = VectorStore(path, dim=embedder.dim)
    b = VectorStore(path, dim=embedder.dim)
    try:
        query = await embedder.embed_one("Warriors vs Lakers")
        a.upsert(Market(id="m1", question="q", event="Warriors vs Lakers", query="q",
                        resolution_date="2026-08-08"), query)
        assert len(b.search(query, k=5)) == 1

        a.set_status("m1", "resolved")
        assert b.search(query, k=5) == [], "a settled market must stop blocking in every worker"
    finally:
        a.close()
        b.close()
