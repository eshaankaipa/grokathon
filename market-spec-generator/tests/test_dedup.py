from __future__ import annotations

from app.dedup import Deduplicator
from app.embeddings import canonical_text
from app.llm import LLMError
from app.models import Classification, Decision, Market
from app.store import new_market_id
from tests.conftest import FakeLLM


async def seed(store, embedder, *, event: str, question: str, date: str | None = None) -> Market:
    m = Market(
        id=new_market_id(), question=question, event=event, query=event,
        category="sports", entities=[], resolution_date=date,
    )
    store.upsert(m, await embedder.embed_one(canonical_text(event=event, query=event, category="sports", resolution_date=date)))
    return m


def proposal(event: str, date: str | None = None) -> Classification:
    return Classification(
        decision=Decision.CREATE, event=event, query=event, category="sports", resolution_date=date,
    )


async def test_empty_store_is_never_a_duplicate(store, embedder):
    dedup = Deduplicator(store, embedder, FakeLLM())
    check, vector = await dedup.check(proposal("Warriors vs Lakers Aug 8 2026"))

    assert check.is_duplicate is False
    assert check.method == "none"
    assert vector.shape == (embedder.dim,)


async def test_identical_market_short_circuits_the_judge(store, embedder):
    event = "Golden State Warriors vs Los Angeles Lakers Aug 8 2026"
    existing = await seed(store, embedder, event=event, question="Will the Warriors beat the Lakers?", date="2026-08-08")

    llm = FakeLLM()  # raises if called
    dedup = Deduplicator(store, embedder, llm)
    check, _ = await dedup.check(proposal(event, date="2026-08-08"))

    assert check.is_duplicate is True
    assert check.method == "threshold"
    assert check.duplicate_of.market_id == existing.id
    assert llm.calls == []


async def test_judge_confirms_a_reworded_duplicate(store, embedder):
    existing = await seed(
        store, embedder,
        event="Golden State Warriors vs Los Angeles Lakers Aug 8 2026",
        question="Will the Golden State Warriors defeat the Los Angeles Lakers on August 8, 2026?",
        date="2026-08-08",
    )
    llm = FakeLLM([{"duplicate_of": existing.id, "confidence": 0.95, "reason": "Inverted phrasing of the same game."}])
    dedup = Deduplicator(store, embedder, llm)

    check, _ = await dedup.check(proposal("Lakers lose to Warriors Aug 8 2026", date="2026-08-08"))

    assert check.is_duplicate is True
    assert check.method == "judge"
    assert check.duplicate_of.market_id == existing.id


async def test_near_identical_text_on_a_different_date_still_reaches_the_judge(store, embedder):
    """Regression: measured against text-embedding-3-small, the same fixture one
    day apart scores 0.984 — above the auto-duplicate threshold — while a genuine
    inverted-phrasing duplicate scores 0.901. Similarity alone would block the
    legitimate market, so the threshold short-circuit is gated on the date."""
    event = "Golden State Warriors vs Los Angeles Lakers Aug 8 2026"
    await seed(store, embedder, event=event, question="Will the Warriors win?", date="2026-08-08")

    llm = FakeLLM([{"duplicate_of": None, "confidence": 0.9, "reason": "Different game date."}])
    dedup = Deduplicator(store, embedder, llm, auto_duplicate_threshold=0.5)

    # Identical event text; only the date differs.
    check, _ = await dedup.check(proposal(event, date="2026-08-09"))

    assert check.is_duplicate is False
    assert check.method == "judge", "must not auto-resolve on similarity alone"
    assert len(llm.calls) == 1


async def test_unknown_date_never_auto_duplicates(store, embedder):
    """A one-sided unknown date is not evidence of sameness — send it to the judge."""
    event = "Golden State Warriors vs Los Angeles Lakers Aug 8 2026"
    await seed(store, embedder, event=event, question="Will the Warriors win?", date="2026-08-08")

    llm = FakeLLM([{"duplicate_of": None, "confidence": 0.5, "reason": "Cannot confirm the date."}])
    dedup = Deduplicator(store, embedder, llm, auto_duplicate_threshold=0.5)

    check, _ = await dedup.check(proposal(event, date=None))

    assert check.method == "judge"


async def test_judge_lets_a_different_date_through(store, embedder):
    await seed(
        store, embedder,
        event="Golden State Warriors vs Los Angeles Lakers Aug 8 2026",
        question="Will the Warriors defeat the Lakers on August 8, 2026?",
        date="2026-08-08",
    )
    llm = FakeLLM([{"duplicate_of": None, "confidence": 0.9, "reason": "Different game date."}])
    dedup = Deduplicator(store, embedder, llm)

    check, _ = await dedup.check(proposal("Golden State Warriors vs Los Angeles Lakers Aug 9 2026", date="2026-08-09"))

    assert check.is_duplicate is False
    assert check.method == "judge"
    assert check.candidates, "the near-miss should still be reported to the caller"


async def test_judge_naming_an_unknown_id_does_not_block(store, embedder):
    await seed(store, embedder, event="Warriors vs Lakers Aug 8 2026", question="Will the Warriors win?", date="2026-08-08")
    llm = FakeLLM([{"duplicate_of": "mkt_hallucinated", "confidence": 0.9, "reason": "made up"}])
    dedup = Deduplicator(store, embedder, llm)

    check, _ = await dedup.check(proposal("Warriors vs Lakers Aug 9 2026", date="2026-08-09"))

    assert check.is_duplicate is False
    assert "unknown market" in check.reason


async def test_judge_failure_fails_open(store, embedder):
    await seed(store, embedder, event="Warriors vs Lakers Aug 8 2026", question="Will the Warriors win?", date="2026-08-08")
    llm = FakeLLM([LLMError("boom")])
    dedup = Deduplicator(store, embedder, llm)

    check, _ = await dedup.check(proposal("Warriors vs Lakers Aug 9 2026", date="2026-08-09"))

    assert check.is_duplicate is False
    assert "Judge failed" in check.reason


async def test_judge_disabled_uses_threshold_only(store, embedder):
    await seed(store, embedder, event="Warriors vs Lakers Aug 8 2026", question="Will the Warriors win?", date="2026-08-08")
    dedup = Deduplicator(store, embedder, None)

    check, _ = await dedup.check(proposal("Warriors vs Lakers Aug 9 2026", date="2026-08-09"))

    assert check.is_duplicate is False
    assert check.method == "threshold"


async def test_resolved_markets_do_not_block_creation(store, embedder):
    event = "Golden State Warriors vs Los Angeles Lakers Aug 8 2026"
    existing = await seed(store, embedder, event=event, question="Will the Warriors win?", date="2026-08-08")
    store.set_status(existing.id, "resolved")

    dedup = Deduplicator(store, embedder, FakeLLM())
    check, _ = await dedup.check(proposal(event, date="2026-08-08"))

    assert check.is_duplicate is False


def test_canonical_text_is_order_independent():
    a = canonical_text(event="E", entities=["Lakers", "Warriors"])
    b = canonical_text(event="E", entities=["warriors", " Lakers "])
    assert a == b
