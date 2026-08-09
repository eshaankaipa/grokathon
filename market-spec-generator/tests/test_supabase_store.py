"""SupabaseStore against a stubbed PostgREST, so the whole backend is covered
without a network or credentials."""

from __future__ import annotations

import json

import httpx
import numpy as np
import pytest

from app.models import Market
from app.store import DuplicateMarketError, canonical_key
from app.supabase_store import SupabaseStore, slugify

DIM = 4
URL = "https://project.supabase.co"
KEY = "service_role_key"


class FakePostgrest:
    """Minimal in-memory stand-in: two tables, joined on market_id."""

    def __init__(self) -> None:
        self.markets: dict[str, dict] = {}
        self.embeddings: dict[str, dict] = {}
        self.requests: list[tuple[str, str, dict]] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path.removeprefix("/rest/v1")
        params = dict(request.url.params)
        body = json.loads(request.content) if request.content else None
        self.requests.append((request.method, path, params))

        if path == "/rpc/match_markets":
            return httpx.Response(200, json=self._match(body))
        if path == "/markets":
            return self._markets(request.method, params, body)
        if path == "/market_embeddings":
            return self._embeddings(request.method, params, body)
        return httpx.Response(404, json={"message": f"no route {path}"})

    # -- tables ------------------------------------------------------------- #

    def _markets(self, method, params, body):
        if method == "POST":
            for row in body:
                self.markets[row["id"]] = {**self.markets.get(row["id"], {}), **row,
                                           "created_at": "2026-08-09T00:00:00+00:00"}
            return httpx.Response(201, json=[])
        ident = _eq(params.get("id"))
        if method == "GET":
            rows = [self._join(m) for m in self.markets.values()
                    if ident is None or m["id"] == ident]
            if status := _eq(params.get("status")):
                rows = [r for r in rows if r.get("status") == status]
            return httpx.Response(200, json=rows[: int(params.get("limit", 100))])
        if method == "HEAD":
            n = len([m for m in self.markets.values()
                     if not params.get("status") or m.get("status") == _eq(params["status"])])
            return httpx.Response(200, headers={"content-range": f"0-0/{n}"})
        if method == "PATCH":
            if ident not in self.markets:
                return httpx.Response(200, json=[])
            self.markets[ident].update(body)
            return httpx.Response(200, json=[self.markets[ident]])
        if method == "DELETE":
            row = self.markets.pop(ident, None)
            self.embeddings.pop(ident, None)
            return httpx.Response(200, json=[row] if row else [])
        return httpx.Response(405, json={})

    def _embeddings(self, method, params, body):
        if method == "POST":
            for row in body:
                key = row["canonical_key"]
                clash = next((e for e in self.embeddings.values()
                              if e["canonical_key"] == key and e["market_id"] != row["market_id"]),
                             None)
                if clash:
                    return httpx.Response(409, text='{"code":"23505","message":"duplicate key"}')
                self.embeddings[row["market_id"]] = row
            return httpx.Response(201, json=[])
        if method == "GET":
            rows = list(self.embeddings.values())
            if key := _eq(params.get("canonical_key")):
                rows = [r for r in rows if r["canonical_key"] == key]
            if mid := _eq(params.get("market_id")):
                rows = [r for r in rows if r["market_id"] == mid]
            if due := params.get("resolution_date", "").removeprefix("lte."):
                rows = [r for r in rows if r.get("resolution_date") and r["resolution_date"] <= due]
            if params.get("markets.status"):
                want = _eq(params["markets.status"])
                rows = [r for r in rows
                        if self.markets.get(r["market_id"], {}).get("status") == want]
            return httpx.Response(200, json=rows)
        if method == "PATCH":
            mid = _eq(params.get("market_id"))
            if mid in self.embeddings:
                self.embeddings[mid].update(body)
            return httpx.Response(200, json=[])
        return httpx.Response(405, json={})

    def _join(self, market: dict) -> dict:
        return {**market, "market_embeddings": self.embeddings.get(market["id"])}

    def _match(self, body):
        q = np.array(body["query_embedding"], dtype=np.float32)
        allowed = set(body["allowed_statuses"])
        out = []
        for mid, e in self.embeddings.items():
            m = self.markets.get(mid, {})
            if m.get("status") not in allowed:
                continue
            sim = float(np.dot(np.array(e["embedding"], dtype=np.float32), q))
            if sim >= body["min_similarity"]:
                out.append({"market_id": mid, "question": m.get("question"),
                            "canonical_event": e["canonical_event"],
                            "resolution_date": e.get("resolution_date"),
                            "status": m.get("status"), "similarity": sim})
        out.sort(key=lambda r: -r["similarity"])
        return out[: body["match_count"]]


def _eq(value: str | None) -> str | None:
    return value.removeprefix("eq.") if value else None


@pytest.fixture
def fake() -> FakePostgrest:
    return FakePostgrest()


@pytest.fixture
def store(fake) -> SupabaseStore:
    s = SupabaseStore(URL, KEY, dim=DIM)
    s._client = httpx.Client(
        base_url=f"{URL}/rest/v1", transport=httpx.MockTransport(fake.handler),
        headers={"apikey": KEY, "Authorization": f"Bearer {KEY}"},
    )
    yield s
    s.close()


def market(**kw) -> Market:
    base = dict(
        id="11111111-1111-1111-1111-111111111111",
        question="Will the Golden State Warriors defeat the Los Angeles Lakers on August 8, 2027?",
        event="Golden State Warriors vs Los Angeles Lakers, Aug 8 2027",
        query="warriors lakers", category="sports",
        entities=["Golden State Warriors", "Los Angeles Lakers"],
        resolution_date="2027-08-08", resolution_sources=["Official NBA game results"],
        outcomes=["YES", "NO"],
    )
    base.update(kw)
    return Market(**base)


def vec(*values) -> np.ndarray:
    v = np.array(values, dtype=np.float32)
    return v / np.linalg.norm(v)


# --------------------------------------------------------------------------- #


def test_requires_a_service_key():
    with pytest.raises(RuntimeError, match="service_role"):
        SupabaseStore(URL, "", dim=DIM)


def test_upsert_writes_both_tables(store, fake):
    store.upsert(market(), vec(1, 0, 0, 0))

    assert len(fake.markets) == 1 and len(fake.embeddings) == 1
    row = next(iter(fake.markets.values()))
    assert row["question"].startswith("Will the Golden State Warriors")
    assert row["slug"] == "will-the-golden-state-warriors-defeat-the-los-angeles-lakers-on-august-8-2027"
    # Pricing/pool columns belong to the trading side and must not be written.
    assert not {"yes_price", "yes_pool", "volume", "liquidity_parameter"} & set(row)


def test_spec_fields_land_in_the_embeddings_table(store, fake):
    store.upsert(market(), vec(1, 0, 0, 0))
    spec = next(iter(fake.embeddings.values()))

    assert spec["canonical_event"] == "Golden State Warriors vs Los Angeles Lakers, Aug 8 2027"
    assert spec["outcomes"] == ["YES", "NO"]
    assert spec["resolution_sources"] == ["Official NBA game results"]
    assert len(spec["embedding"]) == DIM


def test_roundtrip_rejoins_both_tables(store):
    original = market()
    store.upsert(original, vec(1, 0, 0, 0))

    got = store.get(original.id)
    assert got.question == original.question
    assert got.event == original.event
    assert got.outcomes == ["YES", "NO"]
    assert got.resolution_sources == ["Official NBA game results"]
    assert got.entities == original.entities


def test_wrong_dimension_rejected(store):
    with pytest.raises(ValueError, match="expects"):
        store.upsert(market(), np.zeros(DIM + 1, dtype=np.float32))


def test_search_ranks_and_filters_by_status(store):
    a = market(id="aaaaaaaa-0000-0000-0000-000000000000", event="Warriors Lakers Aug 8 2027")
    b = market(id="bbbbbbbb-0000-0000-0000-000000000000", event="Bitcoin above 150k Dec 2027",
               entities=["Bitcoin"], category="crypto")
    store.upsert(a, vec(1, 0, 0, 0))
    store.upsert(b, vec(0, 1, 0, 0))

    hits = store.search(vec(1, 0.1, 0, 0), k=5)
    assert [h.market.id for h in hits] == [a.id, b.id]
    assert hits[0].similarity > hits[1].similarity


def test_settled_markets_drop_out_of_search(store):
    m = market()
    store.upsert(m, vec(1, 0, 0, 0))
    assert len(store.search(vec(1, 0, 0, 0))) == 1

    store.settle(m.id, outcome="YES", evidence="Warriors won 118-112.", resolved_at="2027-08-09T00:00:00Z")

    assert store.search(vec(1, 0, 0, 0)) == []
    settled = store.get(m.id)
    assert settled.status == "resolved" and settled.outcome == "YES"
    assert "118-112" in settled.resolution_evidence


def test_void_cancels(store):
    m = market()
    store.upsert(m, vec(1, 0, 0, 0))
    store.settle(m.id, outcome="VOID", resolved_at="2027-08-09T00:00:00Z")
    assert store.get(m.id).status == "cancelled"


def test_pending_resolution_still_blocks(store):
    m = market()
    store.upsert(m, vec(1, 0, 0, 0))
    store.set_status(m.id, "pending_resolution")
    assert len(store.search(vec(1, 0, 0, 0))) == 1


def test_canonical_key_collision_raises_duplicate(store):
    first = market(id="aaaaaaaa-0000-0000-0000-000000000000")
    second = market(id="bbbbbbbb-0000-0000-0000-000000000000", question="Will the Lakers lose?")
    assert canonical_key(first) == canonical_key(second)

    store.upsert(first, vec(1, 0, 0, 0))
    with pytest.raises(DuplicateMarketError) as exc:
        store.upsert(second, vec(1, 0, 0, 0))
    assert exc.value.existing_id == first.id


def test_updating_the_same_market_is_not_a_conflict(store):
    m = market()
    store.upsert(m, vec(1, 0, 0, 0))
    m.question = "Will the Golden State Warriors win on August 8, 2027?"
    store.upsert(m, vec(1, 0, 0, 0))
    assert store.get(m.id).question.endswith("on August 8, 2027?")


def test_get_by_canonical_key(store):
    m = market()
    store.upsert(m, vec(1, 0, 0, 0))
    assert store.get_by_canonical_key(canonical_key(m)).id == m.id
    assert store.get_by_canonical_key("nope") is None


def test_due_for_resolution_respects_date_and_status(store):
    due = market(id="aaaaaaaa-0000-0000-0000-000000000000", resolution_date="2027-01-01")
    later = market(id="bbbbbbbb-0000-0000-0000-000000000000", resolution_date="2028-01-01",
                   event="Other event", entities=["Other"])
    store.upsert(due, vec(1, 0, 0, 0))
    store.upsert(later, vec(0, 1, 0, 0))

    assert [m.id for m in store.due_for_resolution(on_date="2027-06-01")] == [due.id]


def test_count_and_list(store):
    store.upsert(market(id="aaaaaaaa-0000-0000-0000-000000000000"), vec(1, 0, 0, 0))
    store.upsert(market(id="bbbbbbbb-0000-0000-0000-000000000000", event="Other",
                        entities=["Other"]), vec(0, 1, 0, 0))

    assert store.count() == 2
    assert store.count(status="open") == 2
    assert len(store.list(limit=10)) == 2


def test_delete(store):
    m = market()
    store.upsert(m, vec(1, 0, 0, 0))
    assert store.delete(m.id) is True
    assert store.get(m.id) is None
    assert store.delete(m.id) is False


def test_new_id_is_a_uuid(store):
    import uuid
    uuid.UUID(store.new_id())  # raises if not a uuid


def test_search_sends_the_rpc_not_a_table_query(store, fake):
    store.upsert(market(), vec(1, 0, 0, 0))
    fake.requests.clear()
    store.search(vec(1, 0, 0, 0))

    assert any(path == "/rpc/match_markets" for _, path, _ in fake.requests)


@pytest.mark.parametrize("text,expected", [
    ("Will the Warriors win?", "will-the-warriors-win"),
    ("Bitcoin > $150,000 on Dec 31?", "bitcoin-150-000-on-dec-31"),
    ("   ", "market"),
    ("Café niño", "cafe-nino"),
])
def test_slugify(text, expected):
    assert slugify(text) == expected


# --------------------------------------------------------------------------- #
# Mapping onto the real schema (verified against the live project)
# --------------------------------------------------------------------------- #


def test_pending_resolution_maps_onto_the_closed_enum_value(store, fake):
    """`markets.status` is enum (draft, open, closed, resolved, cancelled) —
    'pending_resolution' is not a member and would be rejected by Postgres."""
    m = market()
    store.upsert(m, vec(1, 0, 0, 0))
    store.set_status(m.id, "pending_resolution")

    assert fake.markets[m.id]["status"] == "closed"
    assert store.get(m.id).status == "pending_resolution", "must read back round-trip"


def test_only_enum_values_are_ever_written(store, fake):
    valid = {"draft", "open", "closed", "resolved", "cancelled"}
    m = market()
    store.upsert(m, vec(1, 0, 0, 0))
    for status in ("open", "pending_resolution", "resolved", "cancelled"):
        store.set_status(m.id, status)
        assert fake.markets[m.id]["status"] in valid


def test_pending_markets_still_block_via_the_closed_status(store, fake):
    m = market()
    store.upsert(m, vec(1, 0, 0, 0))
    store.set_status(m.id, "pending_resolution")

    assert len(store.search(vec(1, 0, 0, 0))) == 1
    # The RPC must be asked for enum values, not this service's vocabulary.
    sent = [r for r in fake.requests if r[1] == "/rpc/match_markets"]
    assert sent


def test_category_is_mapped_to_their_capitalised_vocabulary(store, fake):
    store.upsert(market(category="sports"), vec(1, 0, 0, 0))
    assert next(iter(fake.markets.values()))["category"] == "Sports"


@pytest.mark.parametrize("mine,theirs", [
    ("sports", "Sports"), ("crypto", "Economy"), ("markets", "Economy"),
    ("entertainment", "Culture"), ("weather", "Science"), ("other", "Other"),
])
def test_category_mapping(store, fake, mine, theirs):
    store.upsert(market(category=mine), vec(1, 0, 0, 0))
    assert next(iter(fake.markets.values()))["category"] == theirs


def test_closes_at_is_derived_because_their_column_is_not_null(store, fake):
    """A MarketSpec leaves closes_at null unless a time was grounded, but
    `markets.closes_at` is NOT NULL — so a fallback is supplied there while the
    honest null is preserved on our side."""
    m = market(closes_at=None, resolution_date="2027-08-08")
    store.upsert(m, vec(1, 0, 0, 0))

    assert fake.markets[m.id]["closes_at"] == "2027-08-08T00:00:00+00:00"
    assert fake.embeddings[m.id]["closes_at"] is None
    assert fake.embeddings[m.id]["metadata"]["closes_at_derived"] is True
    assert store.get(m.id).closes_at is None, "the spec's null must survive the round trip"


def test_a_real_closes_at_is_not_overwritten(store, fake):
    m = market(closes_at="2027-08-08T19:00:00+00:00", resolution_date="2027-08-08")
    store.upsert(m, vec(1, 0, 0, 0))

    assert fake.markets[m.id]["closes_at"] == "2027-08-08T19:00:00+00:00"
    assert "closes_at_derived" not in fake.embeddings[m.id]["metadata"]
    assert store.get(m.id).closes_at == "2027-08-08T19:00:00+00:00"


def test_required_not_null_columns_are_always_supplied(store, fake):
    """slug, question, resolution_criteria and closes_at are NOT NULL in their
    schema — a write missing any of them fails at the database."""
    store.upsert(market(resolution_criteria="Resolve YES if..."), vec(1, 0, 0, 0))
    row = next(iter(fake.markets.values()))
    for column in ("slug", "question", "resolution_criteria", "closes_at"):
        assert row.get(column), f"{column} must never be null"
