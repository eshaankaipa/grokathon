from __future__ import annotations

import numpy as np
import pytest

from app.models import Market
from app.store import VectorStore, new_market_id
from tests.conftest import DIM


def _market(**kw) -> Market:
    base = dict(
        id=new_market_id(),
        question="Will X happen?",
        event="X happening",
        query="x happening",
        category="other",
    )
    base.update(kw)
    return Market(**base)


async def test_upsert_and_get(store: VectorStore, embedder):
    m = _market(question="Will the Warriors beat the Lakers on August 8, 2026?")
    store.upsert(m, await embedder.embed_one(m.question))

    got = store.get(m.id)
    assert got is not None
    assert got.question == m.question
    assert store.count() == 1


def test_upsert_rejects_wrong_dim(store: VectorStore):
    with pytest.raises(ValueError, match="expects"):
        store.upsert(_market(), np.zeros(DIM + 1, dtype=np.float32))


async def test_search_ranks_by_similarity(store: VectorStore, embedder):
    warriors = _market(event="Warriors vs Lakers August 8 2026")
    bitcoin = _market(event="Bitcoin above 150000 December 2026")
    for m in (warriors, bitcoin):
        store.upsert(m, await embedder.embed_one(m.event))

    hits = store.search(await embedder.embed_one("Warriors Lakers August 8 2026"), k=2)

    assert [h.market.id for h in hits] == [warriors.id, bitcoin.id]
    assert hits[0].similarity > hits[1].similarity


async def test_search_excludes_non_open_markets(store: VectorStore, embedder):
    m = _market(event="Warriors vs Lakers August 8 2026")
    store.upsert(m, await embedder.embed_one(m.event))
    store.set_status(m.id, "resolved")

    query = await embedder.embed_one("Warriors Lakers August 8 2026")
    assert store.search(query) == []
    assert len(store.search(query, statuses=("open", "resolved"))) == 1


async def test_min_similarity_filters(store: VectorStore, embedder):
    m = _market(event="Bitcoin above 150000 December 2026")
    store.upsert(m, await embedder.embed_one(m.event))

    query = await embedder.embed_one("Warriors Lakers basketball game")
    assert store.search(query, min_similarity=0.9) == []


async def test_index_refreshes_after_write(store: VectorStore, embedder):
    """The in-memory matrix is cached; a write must invalidate it."""
    first = _market(event="Warriors vs Lakers August 8 2026")
    store.upsert(first, await embedder.embed_one(first.event))
    assert len(store.search(await embedder.embed_one("Warriors Lakers"), k=5)) == 1

    second = _market(event="Warriors vs Lakers August 9 2026")
    store.upsert(second, await embedder.embed_one(second.event))
    assert len(store.search(await embedder.embed_one("Warriors Lakers"), k=5)) == 2

    store.delete(first.id)
    assert len(store.search(await embedder.embed_one("Warriors Lakers"), k=5)) == 1


async def test_upsert_overwrites_same_id(store: VectorStore, embedder):
    m = _market(question="v1")
    store.upsert(m, await embedder.embed_one("v1"))
    m.question = "v2"
    store.upsert(m, await embedder.embed_one("v2"))

    assert store.count() == 1
    assert store.get(m.id).question == "v2"


def test_search_on_empty_store(store: VectorStore):
    assert store.search(np.zeros(DIM, dtype=np.float32)) == []


async def test_persists_across_reopen(tmp_path, embedder):
    path = tmp_path / "persist.db"
    s1 = VectorStore(path, dim=DIM)
    m = _market(event="Warriors vs Lakers August 8 2026")
    s1.upsert(m, await embedder.embed_one(m.event))
    s1.close()

    s2 = VectorStore(path, dim=DIM)
    try:
        hits = s2.search(await embedder.embed_one("Warriors Lakers August 8 2026"))
        assert [h.market.id for h in hits] == [m.id]
    finally:
        s2.close()
