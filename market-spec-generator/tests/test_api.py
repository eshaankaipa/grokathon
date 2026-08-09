from __future__ import annotations

import dataclasses

import pytest
from fastapi.testclient import TestClient

from app import deps
from app.classifier import Classifier
from app.config import get_settings
from app.dedup import Deduplicator
from app.main import app
from app.pipeline import Pipeline
from app.question import QuestionGenerator
from app.resolver import LLMOutcomeSource, Resolver
from tests.conftest import FakeLLM
from tests.test_pipeline import CLASSIFY_CREATE, FUTURE_DATE, GENERATE

CLUSTER_BODY = {
    "cluster_id": "c1",
    "topic": "#NBA",
    "tweets": [{"id": "1", "text": "Lakers at Warriors August 8 2026", "likes": 9000, "reposts": 2000}],
}


@pytest.fixture
def client(store, embedder):
    llm = FakeLLM()
    services = deps.Services(
        # These exercise functionality, not auth; test_auth.py covers the gate.
        settings=dataclasses.replace(
            get_settings(), admin_token='', allow_unauthenticated=True
        ),
        store=store,
        embedder=embedder,
        resolver=Resolver(store, LLMOutcomeSource(llm, min_confidence=0.9)),
        pipeline=Pipeline(
            classifier=Classifier(llm, min_engagement=500),
            deduplicator=Deduplicator(store, embedder, llm),
            generator=QuestionGenerator(llm),
            store=store,
            embedder=embedder,
            embedding_model="fake",
        ),
    )
    app.state.services = services
    with TestClient(app) as c:
        c.llm = llm  # tests queue responses through this
        yield c
    app.state.services = None


def test_health(client):
    body = client.get("/health").json()
    assert body["ok"] is True
    assert body["markets"] == 0


def test_ingest_then_duplicate(client):
    client.llm.queue(CLASSIFY_CREATE)
    client.llm.queue(GENERATE)

    first = client.post("/ingest", json={"cluster": CLUSTER_BODY}).json()
    assert first["decision"] == "CREATE"
    market_id = first["market"]["id"]

    client.llm.queue(CLASSIFY_CREATE)
    second = client.post("/ingest", json={"cluster": CLUSTER_BODY}).json()
    assert second["decision"] == "DUPLICATE"
    assert second["duplicate_of"]["market_id"] == market_id
    assert client.get("/health").json()["markets"] == 1


def test_check_endpoint_reports_candidates(client):
    client.llm.queue(CLASSIFY_CREATE)
    client.llm.queue(GENERATE)
    client.post("/ingest", json={"cluster": CLUSTER_BODY})

    resp = client.post("/markets/check", json={
        "event": CLASSIFY_CREATE["event"],
        "query": CLASSIFY_CREATE["query"],
        "entities": CLASSIFY_CREATE["entities"],
        "category": "sports",
        "resolution_date": FUTURE_DATE,
    })
    body = resp.json()
    assert body["is_duplicate"] is True
    assert body["candidates"]


def test_market_crud(client):
    created = client.post("/markets", json={
        "id": "mkt_manual",
        "question": "Will Bitcoin close above $150,000 on December 31, 2026?",
        "event": "Bitcoin year-end close 2026",
        "query": "Bitcoin 150000 December 2026",
        "category": "crypto",
    })
    assert created.status_code == 201

    assert client.get("/markets/mkt_manual").json()["question"].startswith("Will Bitcoin")
    assert len(client.get("/markets").json()) == 1

    hits = client.post("/markets/search", json={"query": "Bitcoin 150000 December 2026", "k": 3}).json()
    assert hits[0]["market"]["id"] == "mkt_manual"
    assert hits[0]["similarity"] > 0.5

    patched = client.patch("/markets/mkt_manual/status", json={"status": "resolved"})
    assert patched.json()["status"] == "resolved"

    assert client.delete("/markets/mkt_manual").status_code == 204
    assert client.get("/markets/mkt_manual").status_code == 404


def test_missing_market_is_404(client):
    assert client.get("/markets/nope").status_code == 404
    assert client.delete("/markets/nope").status_code == 404


# --------------------------------------------------------------------------- #
# EventSpec JSON -> MarketSpec JSON: the upstream integration boundary
# --------------------------------------------------------------------------- #

SPEC_EVENT = {
    "canonical_event": "Golden State Warriors vs Los Angeles Lakers on August 8, 2026",
    "query": "Golden State Warriors Los Angeles Lakers August 8 2026",
    "category": "sports",
    "context_summary": "Users are discussing the scheduled game.",
    "entities": ["Golden State Warriors", "Los Angeles Lakers"],
    "key_developments": ["The game is scheduled for August 8, 2026"],
    "unresolved_events": ["game winner"],
}


def test_spec_endpoint_returns_a_market_spec(client):
    client.llm.queue(GENERATE)
    body = client.post("/spec", json=SPEC_EVENT).json()

    assert body["outcomes"] == ["YES", "NO"]
    assert body["canonical_event"] == SPEC_EVENT["canonical_event"]
    assert body["source_query"] == SPEC_EVENT["query"]
    assert body["resolution_sources"] == ["Official NBA game results"]
    assert body["closes_at"] is None


def test_spec_endpoint_rejects_an_unfixable_draft(client):
    bad = {**GENERATE, "question": "Will GPT-6 be amazing?"}
    client.llm.queue(bad)   # draft
    client.llm.queue(bad)   # repair pass returns the same thing

    resp = client.post("/spec", json=SPEC_EVENT)

    assert resp.status_code == 422
    assert any("subjective" in i for i in resp.json()["detail"]["issues"])


def test_spec_validate_endpoint_reports_issues(client):
    resp = client.post("/spec/validate", json={
        "question": "Will GPT-6 be amazing?",
        "outcomes": ["YES", "NO", "VOID"],
        "resolution_criteria": "Resolve YES if it is good. If cancelled, resolve NO.",
        "resolution_sources": ["https://openai.com/gpt6"],
        "canonical_event": "GPT-6 release",
    })
    body = resp.json()

    assert body["valid"] is False
    codes = {i["code"] for i in body["issues"]}
    assert {"subjective", "void_not_tradeable", "cancellation_as_no",
            "fabricated_url"} <= codes


def test_spec_validate_accepts_a_good_spec(client):
    resp = client.post("/spec/validate", json={
        "question": "Will the Golden State Warriors defeat the Los Angeles Lakers on August 8, 2026?",
        "outcomes": ["YES", "NO"],
        "resolution_date": FUTURE_DATE,
        "resolution_criteria": GENERATE["resolution_criteria"],
        "resolution_sources": ["Official NBA game results"],
        "canonical_event": "Golden State Warriors vs Los Angeles Lakers on August 8, 2026",
    })
    assert resp.json()["valid"] is True
