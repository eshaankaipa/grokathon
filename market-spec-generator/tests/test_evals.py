from __future__ import annotations

import json

import pytest

from app.classifier import Classifier
from app.dedup import Deduplicator
from evals.runner import (
    EVAL_DIR,
    Score,
    eval_classifier,
    eval_dedup,
    load,
    seed_corpus,
    sweep_thresholds,
)
from tests.conftest import RoutingLLM


# -- scoring maths ---------------------------------------------------------- #


def test_score_counts_each_quadrant():
    s = Score()
    s.add(predicted=True, actual=True)     # tp
    s.add(predicted=True, actual=False)    # fp
    s.add(predicted=False, actual=True)    # fn
    s.add(predicted=False, actual=False)   # tn

    assert (s.tp, s.fp, s.fn, s.tn) == (1, 1, 1, 1)
    assert s.precision == 0.5
    assert s.recall == 0.5
    assert s.f1 == 0.5
    assert s.accuracy == 0.5


def test_perfect_score():
    s = Score()
    for _ in range(3):
        s.add(predicted=True, actual=True)
    for _ in range(2):
        s.add(predicted=False, actual=False)
    assert s.precision == s.recall == s.f1 == s.accuracy == 1.0


def test_empty_score_does_not_divide_by_zero():
    s = Score()
    assert s.precision == 1.0 and s.recall == 1.0 and s.accuracy == 0.0


# -- corpus integrity ------------------------------------------------------- #


def test_dedup_corpus_is_well_formed():
    data = load("cases_dedup.json")
    ids = {m["id"] for m in data["markets"]}
    assert len(ids) == len(data["markets"]), "duplicate market ids in the corpus"

    names = set()
    for case in data["cases"]:
        assert case["name"] not in names, f"duplicate case name: {case['name']}"
        names.add(case["name"])
        target = case.get("duplicate_of")
        assert target is None or target in ids, f"{case['name']} points at unknown {target}"
        assert case["proposal"].get("event"), f"{case['name']} has no event"


def test_dedup_corpus_has_both_labels():
    """A corpus of only positives or only negatives scores nothing useful."""
    cases = load("cases_dedup.json")["cases"]
    positives = [c for c in cases if c.get("duplicate_of")]
    negatives = [c for c in cases if not c.get("duplicate_of")]
    assert len(positives) >= 5 and len(negatives) >= 5


def test_classify_corpus_covers_every_decision():
    cases = load("cases_classify.json")["cases"]
    expected = {c["expect"] for c in cases}
    assert expected == {"CREATE", "WAIT", "REJECT"}
    for c in cases:
        assert c["cluster"]["tweets"], f"{c['name']} has no tweets"


@pytest.mark.parametrize("name", ["cases_dedup.json", "cases_classify.json"])
def test_corpus_files_parse(name):
    json.loads((EVAL_DIR / name).read_text())


# -- runner behaviour ------------------------------------------------------- #

CORPUS = {
    "markets": [
        {"id": "m1", "question": "Will the Warriors beat the Lakers?",
         "event": "Warriors vs Lakers Aug 8 2026", "query": "warriors lakers",
         "category": "sports", "entities": ["Warriors", "Lakers"],
         "resolution_date": "2026-08-08"},
    ],
    "cases": [
        {"name": "true dup", "duplicate_of": "m1",
         "proposal": {"event": "Lakers lose to Warriors Aug 8 2026", "query": "lakers warriors",
                      "category": "sports", "entities": ["Lakers", "Warriors"],
                      "resolution_date": "2026-08-08"}},
        {"name": "true new", "duplicate_of": None,
         "proposal": {"event": "Bitcoin above 150k Dec 2026", "query": "bitcoin",
                      "category": "crypto", "entities": ["Bitcoin"],
                      "resolution_date": "2026-12-31"}},
    ],
}


async def test_eval_dedup_scores_a_perfect_run(store, embedder):
    await seed_corpus(store, embedder, CORPUS["markets"])
    llm = RoutingLLM(judge={"duplicate_of": "m1", "confidence": 0.95, "reason": "same game"})
    report = await eval_dedup(Deduplicator(store, embedder, llm), CORPUS["cases"])

    assert report.score.tp == 1 and report.score.tn == 1
    assert report.score.fp == 0 and report.score.fn == 0
    assert report.retrieval_recall == 1.0
    assert report.failures == []


async def test_eval_dedup_catches_a_wrong_verdict(store, embedder):
    """A judge that blocks everything must score as a false positive, not a pass."""
    await seed_corpus(store, embedder, CORPUS["markets"])
    llm = RoutingLLM(judge={"duplicate_of": "m1", "confidence": 0.99, "reason": "blocks everything"})

    # Force both cases through the judge by making the vector stage generous.
    dedup = Deduplicator(store, embedder, llm, candidate_floor=-1.0, auto_duplicate_threshold=2.0)
    report = await eval_dedup(dedup, CORPUS["cases"])

    assert report.score.fp == 1, "blocking a legitimate market must count against precision"
    assert report.score.precision == 0.5
    assert [c.name for c in report.failures] == ["true new"]


async def test_eval_dedup_reports_a_retrieval_miss(store, embedder):
    await seed_corpus(store, embedder, CORPUS["markets"])
    # An impossible floor means nothing is ever retrieved.
    dedup = Deduplicator(store, embedder, RoutingLLM(), candidate_floor=1.1)
    report = await eval_dedup(dedup, CORPUS["cases"])

    assert report.retrieval_recall == 0.0
    assert report.score.fn == 1, "a missed duplicate is a false negative"


async def test_sweep_shows_recall_falling_as_the_floor_rises(store, embedder):
    await seed_corpus(store, embedder, CORPUS["markets"])
    rows = await sweep_thresholds(
        store, embedder, CORPUS["cases"], floors=[0.0, 1.1], auto_threshold=0.97
    )

    assert rows[0].retrieval_recall == 1.0
    assert rows[1].retrieval_recall == 0.0
    assert rows[0].mean_candidates > rows[1].mean_candidates


async def test_eval_classifier_scores_and_confuses():
    cases = [
        {"name": "a", "expect": "CREATE",
         "cluster": {"tweets": [{"id": "1", "text": "game on august 8", "likes": 9000}]}},
        {"name": "b", "expect": "REJECT",
         "cluster": {"tweets": [{"id": "2", "text": "hot take", "likes": 9000}]}},
    ]
    llm = RoutingLLM(classify={
        "decision": "CREATE", "event": "E", "query": "q", "category": "sports",
        "resolution_date": "2027-01-01", "confidence": 0.9, "reason": "always create",
    })
    report = await eval_classifier(Classifier(llm, min_engagement=0), cases)

    assert report.total == 2 and report.correct == 1
    assert report.accuracy == 0.5
    assert report.confusion["REJECT"]["CREATE"] == 1
    assert [c.name for c in report.failures] == ["b"]


async def test_classifier_date_mismatch_fails_the_case():
    cases = [{
        "name": "date", "expect": "CREATE", "expect_date": "2026-08-08",
        "cluster": {"tweets": [{"id": "1", "text": "game", "likes": 9000}]},
    }]
    llm = RoutingLLM(classify={
        "decision": "CREATE", "event": "E", "query": "q", "category": "sports",
        "resolution_date": "2026-08-09", "confidence": 0.9, "reason": "wrong date",
    })
    report = await eval_classifier(Classifier(llm, min_engagement=0), cases)

    assert report.correct == 1, "the decision itself was right"
    assert report.date_correct == 0
    assert report.failures, "a wrong date must still fail the case"
