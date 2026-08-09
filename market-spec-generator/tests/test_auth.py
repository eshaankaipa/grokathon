from __future__ import annotations

import dataclasses

import pytest
from fastapi.testclient import TestClient

from app import deps
from app.auth import MisconfiguredAuth, verify_configuration
from app.classifier import Classifier
from app.config import get_settings
from app.dedup import Deduplicator
from app.main import app
from app.pipeline import Pipeline
from app.question import QuestionGenerator
from app.resolver import ManualOutcomeSource, Resolver
from tests.conftest import RoutingLLM

TOKEN = "test-token-abc123"


def _services(store, embedder, **overrides) -> deps.Services:
    llm = RoutingLLM()
    settings = dataclasses.replace(get_settings(), **overrides)
    return deps.Services(
        settings=settings,
        store=store,
        embedder=embedder,
        resolver=Resolver(store, ManualOutcomeSource()),
        pipeline=Pipeline(
            classifier=Classifier(llm, min_engagement=500),
            deduplicator=Deduplicator(store, embedder, llm),
            generator=QuestionGenerator(llm),
            store=store,
            embedder=embedder,
            embedding_model="fake",
        ),
    )


@pytest.fixture
def secured(store, embedder):
    app.state.services = _services(store, embedder, admin_token=TOKEN)
    with TestClient(app) as c:
        yield c
    app.state.services = None


@pytest.fixture
def open_service(store, embedder):
    app.state.services = _services(
        store, embedder, admin_token="", allow_unauthenticated=True
    )
    with TestClient(app) as c:
        yield c
    app.state.services = None


# -- startup guard ----------------------------------------------------------- #


def test_refuses_to_start_without_a_token():
    settings = dataclasses.replace(get_settings(), admin_token="", allow_unauthenticated=False)
    with pytest.raises(MisconfiguredAuth, match="ADMIN_TOKEN"):
        verify_configuration(settings)


def test_opt_in_allows_running_without_auth():
    settings = dataclasses.replace(get_settings(), admin_token="", allow_unauthenticated=True)
    verify_configuration(settings)  # must not raise


def test_token_alone_is_enough():
    settings = dataclasses.replace(get_settings(), admin_token=TOKEN, allow_unauthenticated=False)
    verify_configuration(settings)


# -- enforcement ------------------------------------------------------------- #


def test_health_stays_public(secured):
    """Load balancers and uptime checks must not need the admin token."""
    assert secured.get("/health").status_code == 200


PROTECTED = [
    ("get", "/markets"),
    ("get", "/markets/anything"),
    ("get", "/resolve/due"),
    ("get", "/resolve/pending"),
    ("post", "/ingest"),
    ("post", "/classify"),
    ("post", "/markets"),
    ("post", "/markets/check"),
    ("post", "/markets/search"),
    ("post", "/resolve/sweep"),
    ("post", "/markets/x/settle"),
    ("patch", "/markets/x/status"),
    ("delete", "/markets/x"),
]


@pytest.mark.parametrize("method,path", PROTECTED)
def test_every_other_endpoint_rejects_anonymous(secured, method, path):
    # .request() rather than .get()/.delete(): httpx refuses a json body on those.
    resp = secured.request(method.upper(), path, json={})
    assert resp.status_code == 401, f"{method.upper()} {path} was reachable without a token"
    assert resp.headers.get("www-authenticate") == "Bearer"


@pytest.mark.parametrize("method,path", PROTECTED)
def test_auth_runs_before_validation(secured, method, path):
    """An anonymous caller must not be able to probe the schema with bad bodies."""
    resp = secured.request(method.upper(), path, json={"nonsense": True})
    assert resp.status_code == 401


def test_wrong_token_rejected(secured):
    resp = secured.get("/markets", headers={"Authorization": f"Bearer {TOKEN}-wrong"})
    assert resp.status_code == 401


def test_token_prefix_is_not_accepted(secured):
    resp = secured.get("/markets", headers={"Authorization": "Bearer test-token"})
    assert resp.status_code == 401


def test_malformed_header_rejected(secured):
    for header in ("", "Bearer", f"Basic {TOKEN}", TOKEN):
        resp = secured.get("/markets", headers={"Authorization": header})
        assert resp.status_code == 401, f"accepted {header!r}"


def test_correct_token_allowed(secured):
    resp = secured.get("/markets", headers={"Authorization": f"Bearer {TOKEN}"})
    assert resp.status_code == 200
    assert resp.json() == []


def test_authorised_write_then_read(secured):
    headers = {"Authorization": f"Bearer {TOKEN}"}
    created = secured.post("/markets", headers=headers, json={
        "id": "mkt_auth", "question": "Will it rain?", "event": "Rain on Aug 8 2026",
        "query": "rain", "category": "weather", "resolution_date": "2026-08-08",
    })
    assert created.status_code == 201
    assert secured.get("/markets/mkt_auth", headers=headers).status_code == 200
    assert secured.delete("/markets/mkt_auth", headers=headers).status_code == 204


def test_unauthenticated_mode_lets_everything_through(open_service):
    assert open_service.get("/markets").status_code == 200
    assert open_service.get("/health").status_code == 200
