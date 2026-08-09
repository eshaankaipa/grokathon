"""Supabase (Postgres + pgvector) backend for the market index.

Implements the same surface as `VectorStore`, so `Pipeline`, `Deduplicator`, and
`Resolver` are unchanged — see `app/store.py` for the reference implementation.

Split of responsibility against the existing schema:

    markets            (theirs)  question, category, status, outcome, closes_at,
                                 pricing, pools — the tradeable instrument
    market_embeddings  (ours)    canonical event, entities, outcomes, sources,
                                 canonical_key, embedding — the spec + dedup index

`markets` stays the single source of truth for status, so a market settled by the
trading side immediately stops blocking duplicates here.

Run `sql/001_market_embeddings.sql` once before using this backend.

Blocking I/O: calls are synchronous HTTP, matching the sync VectorStore
interface. Each one holds the event loop for a round trip (tens of ms). That is
fine at market-list rates; if throughput ever matters, the fix is making the
store interface async rather than threading it here.
"""

from __future__ import annotations

import json
import re
import unicodedata
import uuid
from collections.abc import Sequence
from typing import Any

import httpx
import numpy as np

from .models import LIVE_STATUSES, Market, SearchHit
from .store import DuplicateMarketError, canonical_key

TIMEOUT = httpx.Timeout(20.0, connect=10.0)

# `markets.status` is a Postgres enum (draft, open, closed, resolved, cancelled),
# so this service's `pending_resolution` cannot be written verbatim. `closed` is
# the same semantic — trading has stopped, settlement is pending — so map onto it
# rather than altering their enum, which their frontend also reads.
STATUS_TO_DB = {
    "open": "open",
    "pending_resolution": "closed",
    "resolved": "resolved",
    "cancelled": "cancelled",
}
STATUS_FROM_DB = {
    "draft": "open",
    "open": "open",
    "closed": "pending_resolution",
    "resolved": "resolved",
    "cancelled": "cancelled",
}

# `markets.category` is free text but conventionally capitalised, with an
# established vocabulary. Map onto it where there is a clear equivalent so the
# frontend's filters keep working.
CATEGORY_TO_DB = {
    "sports": "Sports", "science": "Science", "tech": "Tech",
    "markets": "Economy", "crypto": "Economy", "entertainment": "Culture",
    "weather": "Science", "politics": "Politics", "other": "Other",
}


class SupabaseStore:
    """PostgREST-backed vector store. No supabase-py dependency; httpx is enough."""

    # Kept for parity with VectorStore: the UNIQUE constraint on canonical_key is
    # created by the migration, so the create race is closed across machines.
    unique_key_enforced = True

    def __init__(self, url: str, service_key: str, dim: int, *, schema: str = "public") -> None:
        if not url or not service_key:
            raise RuntimeError(
                "SupabaseStore needs SUPABASE_URL and SUPABASE_SERVICE_KEY. The "
                "publishable/anon key cannot write — use the service_role key from "
                "Dashboard -> Settings -> API."
            )
        self.dim = dim
        self._client = httpx.Client(
            base_url=url.rstrip("/") + "/rest/v1",
            timeout=TIMEOUT,
            headers={
                "apikey": service_key,
                "Authorization": f"Bearer {service_key}",
                "Content-Type": "application/json",
                "Accept-Profile": schema,
                "Content-Profile": schema,
            },
        )

    # -- lifecycle ---------------------------------------------------------- #

    def close(self) -> None:
        self._client.close()

    def new_id(self) -> str:
        """Their `markets.id` is a uuid, so ids come from here rather than the
        `mkt_...` scheme the SQLite store uses."""
        return str(uuid.uuid4())

    # -- writes ------------------------------------------------------------- #

    def upsert(self, market: Market, embedding: np.ndarray) -> Market:
        vec = np.asarray(embedding, dtype=np.float32).ravel()
        if vec.shape[0] != self.dim:
            raise ValueError(f"embedding has dim {vec.shape[0]}, store expects {self.dim}")

        key = canonical_key(market)

        # Losing the race is normal, not exceptional: report who won.
        existing = self.get_by_canonical_key(key)
        if existing is not None and existing.id != market.id:
            raise DuplicateMarketError(existing.id)

        self._request(
            "POST", "/markets",
            params={"on_conflict": "id"},
            headers={"Prefer": "resolution=merge-duplicates,return=minimal"},
            json=[self._market_row(market)],
        )
        try:
            self._request(
                "POST", "/market_embeddings",
                params={"on_conflict": "market_id"},
                headers={"Prefer": "resolution=merge-duplicates,return=minimal"},
                json=[self._embedding_row(market, vec, key)],
            )
        except httpx.HTTPStatusError as exc:
            # 23505 = unique_violation on canonical_key: another writer got there
            # between the check above and this insert.
            if "23505" in exc.response.text or "duplicate key" in exc.response.text.lower():
                winner = self.get_by_canonical_key(key)
                raise DuplicateMarketError(winner.id if winner else "unknown") from exc
            raise
        return market

    def set_status(self, market_id: str, status: str) -> Market | None:
        if status not in {"open", "pending_resolution", "resolved", "cancelled"}:
            raise ValueError(f"unknown status: {status}")
        rows = self._request(
            "PATCH", "/markets", params={"id": f"eq.{market_id}"},
            headers={"Prefer": "return=representation"},
            json={"status": STATUS_TO_DB[status]},
        )
        return self.get(market_id) if rows else None

    def settle(
        self, market_id: str, *, outcome: str, evidence: str = "", resolved_at: str
    ) -> Market | None:
        if outcome not in {"YES", "NO", "VOID"}:
            raise ValueError(f"unknown outcome: {outcome}")
        rows = self._request(
            "PATCH", "/markets", params={"id": f"eq.{market_id}"},
            headers={"Prefer": "return=representation"},
            json={
                "status": "cancelled" if outcome == "VOID" else "resolved",
                "outcome": outcome,
                "resolved_at": resolved_at,
            },
        )
        if not rows:
            return None
        # Evidence has no column in `markets`; keep it on our side.
        self._request(
            "PATCH", "/market_embeddings", params={"market_id": f"eq.{market_id}"},
            headers={"Prefer": "return=minimal"},
            json={"metadata": {**(self._metadata(market_id) or {}),
                               "resolution_evidence": evidence}},
        )
        return self.get(market_id)

    def delete(self, market_id: str) -> bool:
        rows = self._request(
            "DELETE", "/markets", params={"id": f"eq.{market_id}"},
            headers={"Prefer": "return=representation"},
        )
        return bool(rows)

    # -- reads -------------------------------------------------------------- #

    def get(self, market_id: str) -> Market | None:
        rows = self._request(
            "GET", "/markets",
            params={"id": f"eq.{market_id}", "select": "*,market_embeddings(*)", "limit": 1},
        )
        return _to_market(rows[0]) if rows else None

    def get_by_canonical_key(self, key: str) -> Market | None:
        rows = self._request(
            "GET", "/market_embeddings",
            params={"canonical_key": f"eq.{key}", "select": "market_id", "limit": 1},
        )
        return self.get(rows[0]["market_id"]) if rows else None

    def list(self, *, status: str | None = None, limit: int = 50, offset: int = 0) -> list[Market]:
        params: dict[str, Any] = {
            "select": "*,market_embeddings(*)",
            "order": "created_at.desc",
            "limit": limit,
            "offset": offset,
        }
        if status:
            params["status"] = f"eq.{STATUS_TO_DB.get(status, status)}"
        return [_to_market(r) for r in self._request("GET", "/markets", params=params)]

    def count(self, *, status: str | None = None) -> int:
        params: dict[str, Any] = {"select": "id"}
        if status:
            params["status"] = f"eq.{STATUS_TO_DB.get(status, status)}"
        response = self._client.request(
            "HEAD", "/markets", params=params,
            headers={"Prefer": "count=exact", "Range": "0-0"},
        )
        response.raise_for_status()
        content_range = response.headers.get("content-range", "*/0")
        return int(content_range.rsplit("/", 1)[-1] or 0)

    def due_for_resolution(self, *, on_date: str, limit: int = 100) -> list[Market]:
        rows = self._request(
            "GET", "/market_embeddings",
            params={
                "select": "market_id,markets!inner(*)",
                "resolution_date": f"lte.{on_date}",
                "markets.status": "eq.open",
                "order": "resolution_date.asc",
                "limit": limit,
            },
        )
        return [m for m in (self.get(r["market_id"]) for r in rows) if m is not None]

    def search(
        self,
        embedding: np.ndarray,
        *,
        k: int = 8,
        statuses: Sequence[str] = LIVE_STATUSES,
        min_similarity: float = 0.0,
    ) -> list[SearchHit]:
        vec = np.asarray(embedding, dtype=np.float32).ravel()
        if vec.shape[0] != self.dim:
            raise ValueError(f"query has dim {vec.shape[0]}, store expects {self.dim}")

        rows = self._request(
            "POST", "/rpc/match_markets",
            json={
                "query_embedding": [float(x) for x in vec],
                "match_count": k,
                "min_similarity": min_similarity,
                "allowed_statuses": sorted(
                    {STATUS_TO_DB.get(s, s) for s in statuses}
                ),
            },
        )
        hits = []
        for row in rows:
            market = self.get(row["market_id"])
            if market:
                hits.append(SearchHit(market=market, similarity=round(float(row["similarity"]), 4)))
        return hits

    # -- helpers ------------------------------------------------------------ #

    def _metadata(self, market_id: str) -> dict | None:
        rows = self._request(
            "GET", "/market_embeddings",
            params={"market_id": f"eq.{market_id}", "select": "metadata", "limit": 1},
        )
        return rows[0]["metadata"] if rows else None

    def _request(self, method: str, path: str, **kwargs) -> list[dict]:
        response = self._client.request(method, path, **kwargs)
        response.raise_for_status()
        if not response.content:
            return []
        try:
            body = response.json()
        except ValueError:
            return []
        return body if isinstance(body, list) else [body]

    @staticmethod
    def _market_row(market: Market) -> dict[str, Any]:
        """Only the columns `markets` actually has — pricing and pools are the
        trading side's business and are left to their defaults."""
        row = {
            "id": market.id,
            "slug": slugify(market.question),
            "question": market.question,
            "resolution_criteria": market.resolution_criteria,
            "category": CATEGORY_TO_DB.get(market.category.lower(),
                                           market.category.title()),
            "status": STATUS_TO_DB.get(market.status, "open"),
            "outcome": market.outcome,
            "closes_at": market.closes_at or _derived_close(market),
            "resolved_at": market.resolved_at,
        }
        if market.source_tweet_ids:
            row["source_tweet_id"] = market.source_tweet_ids[0]
            row["source_tweet_url"] = (
                f"https://x.com/i/web/status/{market.source_tweet_ids[0]}"
            )
        return {k: v for k, v in row.items() if v is not None}

    @staticmethod
    def _embedding_row(market: Market, vec: np.ndarray, key: str) -> dict[str, Any]:
        return {
            "market_id": market.id,
            "canonical_event": market.event,
            "query": market.query,
            "entities": market.entities,
            "outcomes": market.outcomes,
            "resolution_sources": market.resolution_sources,
            "resolution_date": market.resolution_date,
            "closes_at": market.closes_at,
            "canonical_key": key,
            "embedding": [float(x) for x in vec],
            "embedding_model": str(market.metadata.get("embedding_model", "")),
            "source_tweet_ids": market.source_tweet_ids,
            "metadata": {
                **market.metadata,
                **({"closes_at_derived": True}
                   if not market.closes_at and market.resolution_date else {}),
            },
        }


def _derived_close(market: Market) -> str | None:
    """`markets.closes_at` is NOT NULL, but a MarketSpec deliberately leaves the
    closing time null unless the source pinned an exact one.

    Falling back to midnight UTC on the resolution date satisfies their schema
    while keeping trading closed before the outcome is knowable. The honest null
    stays in `market_embeddings.closes_at`, and the fallback is flagged in
    metadata so nobody mistakes it for a real announced time.
    """
    if not market.resolution_date:
        return None
    return f"{str(market.resolution_date)[:10]}T00:00:00+00:00"


def slugify(text: str, *, max_length: int = 80) -> str:
    normalized = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    slug = re.sub(r"[^a-z0-9]+", "-", normalized.lower()).strip("-")
    return slug[:max_length].rstrip("-") or "market"


def _to_market(row: dict[str, Any]) -> Market:
    """Join a `markets` row with its embedded `market_embeddings` child."""
    spec = row.get("market_embeddings") or {}
    if isinstance(spec, list):
        spec = spec[0] if spec else {}

    return Market(
        id=str(row["id"]),
        question=row.get("question") or "",
        event=spec.get("canonical_event") or row.get("question") or "",
        query=spec.get("query") or "",
        category=row.get("category") or "other",
        entities=_json_list(spec.get("entities")),
        resolution_criteria=row.get("resolution_criteria") or "",
        resolution_date=spec.get("resolution_date"),
        resolution_source=(_json_list(spec.get("resolution_sources")) or [""])[0],
        resolution_sources=_json_list(spec.get("resolution_sources")),
        outcomes=_json_list(spec.get("outcomes")) or ["YES", "NO"],
        # The spec's closes_at is authoritative even when it is null — that null
        # means "no exact time was ever grounded". `markets.closes_at` may hold a
        # derived fallback, so only fall back to it for markets that have no spec
        # row at all (i.e. created by the trading side, not by this service).
        closes_at=(spec.get("closes_at") if spec else row.get("closes_at")),
        status=STATUS_FROM_DB.get(row.get("status") or "open", "open"),
        outcome=row.get("outcome"),
        resolved_at=row.get("resolved_at"),
        resolution_evidence=str((spec.get("metadata") or {}).get("resolution_evidence", "")),
        created_at=row.get("created_at") or "",
        source_tweet_ids=_json_list(spec.get("source_tweet_ids")),
        metadata=spec.get("metadata") or {},
    )


def _json_list(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(v) for v in value]
    if isinstance(value, str) and value:
        try:
            parsed = json.loads(value)
            return [str(v) for v in parsed] if isinstance(parsed, list) else []
        except ValueError:
            return []
    return []
