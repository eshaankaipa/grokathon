from __future__ import annotations

from app.llm import LLMError
from app.models import Market, Outcome
from app.resolver import LLMOutcomeSource, ManualOutcomeSource, Resolver
from app.store import VectorStore, new_market_id
from tests.conftest import FakeLLM


async def seed(
    store: VectorStore, embedder, *, date: str | None, status: str = "open", tag: str = ""
) -> Market:
    # `tag` keeps otherwise-identical fixtures distinct: markets that normalize to
    # the same canonical key ARE the same market, and the store rejects the second.
    m = Market(
        id=new_market_id(),
        question="Will the Warriors defeat the Lakers on August 8, 2026?",
        event=f"Warriors vs Lakers {date} {tag}".strip(),
        query="Warriors Lakers",
        category="sports",
        resolution_date=date,
        resolution_criteria="Resolves YES if the Warriors win per the official box score.",
        resolution_source="NBA box score",
        status=status,
    )
    store.upsert(m, await embedder.embed_one(m.event))
    return m


# -- due selection ---------------------------------------------------------- #


async def test_only_past_due_open_markets_are_swept(store, embedder):
    past = await seed(store, embedder, date="2026-08-01")
    await seed(store, embedder, date="2027-01-01")                              # future
    await seed(store, embedder, date=None)                                      # no date
    await seed(store, embedder, date="2026-08-01", status="resolved", tag="b")  # already settled

    due = store.due_for_resolution(on_date="2026-08-08")

    assert [m.id for m in due] == [past.id]


# -- settlement ------------------------------------------------------------- #


async def test_confident_verdict_settles_the_market(store, embedder):
    m = await seed(store, embedder, date="2026-08-01")
    llm = FakeLLM([{"outcome": "YES", "confidence": 0.97, "evidence": "Final score 118-112."}])
    resolver = Resolver(store, LLMOutcomeSource(llm, min_confidence=0.9))

    result = await resolver.sweep(on_date="2026-08-08")

    assert result.checked == 1 and result.settled == 1 and result.pending_review == 0
    settled = store.get(m.id)
    assert settled.status == "resolved"
    assert settled.outcome == "YES"
    assert settled.resolved_at
    assert "118-112" in settled.resolution_evidence


async def test_low_confidence_never_settles(store, embedder):
    m = await seed(store, embedder, date="2026-08-01")
    llm = FakeLLM([{"outcome": "YES", "confidence": 0.6, "evidence": "I think they won."}])
    resolver = Resolver(store, LLMOutcomeSource(llm, min_confidence=0.9))

    result = await resolver.sweep(on_date="2026-08-08")

    assert result.settled == 0 and result.pending_review == 1
    market = store.get(m.id)
    assert market.status == "pending_resolution"
    assert market.outcome is None, "a guess must never be recorded as an outcome"


async def test_unknown_routes_to_human(store, embedder):
    m = await seed(store, embedder, date="2026-08-01")
    llm = FakeLLM([{"outcome": "UNKNOWN", "confidence": 0.0, "evidence": "After my cutoff."}])
    resolver = Resolver(store, LLMOutcomeSource(llm, min_confidence=0.9))

    await resolver.sweep(on_date="2026-08-08")

    assert store.get(m.id).status == "pending_resolution"


async def test_void_cancels_rather_than_resolving(store, embedder):
    m = await seed(store, embedder, date="2026-08-01")
    llm = FakeLLM([{"outcome": "VOID", "confidence": 0.99, "evidence": "Game postponed indefinitely."}])
    resolver = Resolver(store, LLMOutcomeSource(llm, min_confidence=0.9))

    await resolver.sweep(on_date="2026-08-08")

    market = store.get(m.id)
    assert market.status == "cancelled"
    assert market.outcome == "VOID"


async def test_llm_failure_routes_to_human(store, embedder):
    m = await seed(store, embedder, date="2026-08-01")
    resolver = Resolver(store, LLMOutcomeSource(FakeLLM([LLMError("boom")]), min_confidence=0.9))

    await resolver.sweep(on_date="2026-08-08")

    assert store.get(m.id).status == "pending_resolution"


async def test_garbage_outcome_is_treated_as_unknown(store, embedder):
    m = await seed(store, embedder, date="2026-08-01")
    llm = FakeLLM([{"outcome": "PROBABLY", "confidence": 0.99, "evidence": ""}])
    resolver = Resolver(store, LLMOutcomeSource(llm, min_confidence=0.9))

    await resolver.sweep(on_date="2026-08-08")

    assert store.get(m.id).status == "pending_resolution"


async def test_manual_source_settles_nothing(store, embedder):
    m = await seed(store, embedder, date="2026-08-01")
    result = await Resolver(store, ManualOutcomeSource()).sweep(on_date="2026-08-08")

    assert result.settled == 0 and result.pending_review == 1
    assert store.get(m.id).status == "pending_resolution"


async def test_manual_settlement(store, embedder):
    m = await seed(store, embedder, date="2026-08-01")
    resolver = Resolver(store, ManualOutcomeSource())

    settled = resolver.settle_manually(m.id, outcome="NO", evidence="Lakers won 105-99.")

    assert settled.status == "resolved"
    assert settled.outcome == "NO"
    assert settled.resolution_evidence == "Lakers won 105-99."


async def test_settled_markets_stop_blocking_duplicates(store, embedder):
    """The whole point of settlement for dedup: last season stops blocking this one."""
    m = await seed(store, embedder, date="2026-08-01")
    query = await embedder.embed_one(m.event)
    assert len(store.search(query)) == 1

    Resolver(store, ManualOutcomeSource()).settle_manually(m.id, outcome="YES")

    assert store.search(query) == [], "a resolved market must not block a new one"


async def test_pending_resolution_still_blocks_duplicates(store, embedder):
    m = await seed(store, embedder, date="2026-08-01")
    llm = FakeLLM([{"outcome": "UNKNOWN", "confidence": 0.0, "evidence": ""}])
    await Resolver(store, LLMOutcomeSource(llm)).sweep(on_date="2026-08-08")

    assert len(store.search(await embedder.embed_one(m.event))) == 1
