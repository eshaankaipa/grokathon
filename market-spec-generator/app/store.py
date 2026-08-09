from __future__ import annotations

import hashlib
import json
import sqlite3
import threading
import uuid
from collections.abc import Sequence
from pathlib import Path
from typing import Any

import numpy as np

from .models import LIVE_STATUSES, Market, SearchHit

SCHEMA = """
CREATE TABLE IF NOT EXISTS markets (
    id                  TEXT PRIMARY KEY,
    question            TEXT NOT NULL,
    event               TEXT NOT NULL,
    query               TEXT NOT NULL DEFAULT '',
    category            TEXT NOT NULL DEFAULT 'other',
    entities            TEXT NOT NULL DEFAULT '[]',
    resolution_criteria TEXT NOT NULL DEFAULT '',
    resolution_date     TEXT,
    resolution_source   TEXT NOT NULL DEFAULT '',
    status              TEXT NOT NULL DEFAULT 'open',
    created_at          TEXT NOT NULL,
    source_tweet_ids    TEXT NOT NULL DEFAULT '[]',
    metadata            TEXT NOT NULL DEFAULT '{}',
    embedding           BLOB NOT NULL,
    embedding_model     TEXT NOT NULL DEFAULT '',
    dim                 INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_markets_status ON markets(status);
CREATE INDEX IF NOT EXISTS idx_markets_created ON markets(created_at DESC);
"""

# Columns added after the first release. Applied idempotently on open so an
# existing markets.db keeps working without a manual migration step.
ADDED_COLUMNS = {
    "outcome": "TEXT",
    "resolved_at": "TEXT",
    "resolution_evidence": "TEXT NOT NULL DEFAULT ''",
    "canonical_key": "TEXT",
    "outcomes": "TEXT NOT NULL DEFAULT '[\"YES\",\"NO\"]'",
    "closes_at": "TEXT",
    "resolution_sources": "TEXT NOT NULL DEFAULT '[]'",
}


class DuplicateMarketError(Exception):
    """Raised when a write loses a race to an identical market."""

    def __init__(self, existing_id: str) -> None:
        super().__init__(f"an identical market already exists: {existing_id}")
        self.existing_id = existing_id


def canonical_key(market: Market) -> str:
    """Stable fingerprint of what a market is about.

    Two proposals that normalize to the same key are the same market by
    construction, so a UNIQUE index on this makes the final write atomic — the
    guard that a check-then-write dedup cannot provide on its own.
    """
    payload = "|".join([
        " ".join(market.event.lower().split()),
        market.category.strip().lower(),
        market.resolution_date or "",
        ",".join(sorted({e.strip().lower() for e in market.entities if e.strip()})),
    ])
    return hashlib.sha256(payload.encode()).hexdigest()[:32]


class VectorStore:
    """SQLite-backed vector database for prediction markets.

    Persistence is SQLite; search is an exact (brute-force) cosine scan over an
    in-memory matrix that is rebuilt lazily whenever a write dirties it. Exact
    search over a few hundred thousand markets is sub-millisecond and never
    returns the approximate-index misses that would let a duplicate market slip
    through — which matters more here than raw throughput.

    Swapping in Pinecone/Vectorize/pgvector later means reimplementing `upsert`,
    `search`, and `get`; nothing else in the codebase touches the storage layer.
    """

    def __init__(self, db_path: str | Path, dim: int) -> None:
        self.dim = dim
        self.path = Path(db_path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(self.path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.executescript(SCHEMA)
        self._migrate()
        self._conn.commit()

        # Lazily built search index.
        self._ids: list[str] = []
        self._matrix: np.ndarray | None = None
        self._index_statuses: tuple[str, ...] = ()
        self._dirty = True
        self._data_version_seen = -1

    # -- lifecycle ---------------------------------------------------------- #

    def _migrate(self) -> None:
        existing = {r["name"] for r in self._conn.execute("PRAGMA table_info(markets)")}
        for column, spec in ADDED_COLUMNS.items():
            if column not in existing:
                self._conn.execute(f"ALTER TABLE markets ADD COLUMN {column} {spec}")

        # Older rows carry a single resolution_source; promote it into the list.
        for row in self._conn.execute(
            "SELECT id, resolution_source FROM markets "
            "WHERE resolution_sources IS NULL OR resolution_sources IN ('', '[]')"
        ).fetchall():
            if row["resolution_source"]:
                self._conn.execute(
                    "UPDATE markets SET resolution_sources=? WHERE id=?",
                    (json.dumps([row["resolution_source"]]), row["id"]),
                )

        # Backfill keys for rows written before the column existed.
        for row in self._conn.execute(
            "SELECT * FROM markets WHERE canonical_key IS NULL OR canonical_key = ''"
        ).fetchall():
            self._conn.execute(
                "UPDATE markets SET canonical_key=? WHERE id=?",
                (canonical_key(_row_to_market(row)), row["id"]),
            )

        # The UNIQUE index is what actually closes the create race. If a legacy DB
        # already holds duplicates it can't be built — keep working with the
        # in-process guard alone rather than refusing to open.
        try:
            self._conn.execute(
                "CREATE UNIQUE INDEX IF NOT EXISTS idx_markets_canonical "
                "ON markets(canonical_key)"
            )
            self.unique_key_enforced = True
        except sqlite3.IntegrityError:
            self.unique_key_enforced = False

    def new_id(self) -> str:
        return new_market_id()

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    # -- writes ------------------------------------------------------------- #

    def upsert(self, market: Market, embedding: np.ndarray) -> Market:
        vec = np.asarray(embedding, dtype=np.float32).ravel()
        if vec.shape[0] != self.dim:
            raise ValueError(f"embedding has dim {vec.shape[0]}, store expects {self.dim}")

        key = canonical_key(market)
        with self._lock:
            try:
                self._conn.execute(
                    """
                    INSERT INTO markets (
                        id, question, event, query, category, entities, resolution_criteria,
                        resolution_date, resolution_source, outcomes, closes_at,
                        resolution_sources, status, outcome, resolved_at,
                        resolution_evidence, created_at, source_tweet_ids, metadata,
                        embedding, embedding_model, dim, canonical_key
                    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                    ON CONFLICT(id) DO UPDATE SET
                        question=excluded.question,
                        event=excluded.event,
                        query=excluded.query,
                        category=excluded.category,
                        entities=excluded.entities,
                        resolution_criteria=excluded.resolution_criteria,
                        resolution_date=excluded.resolution_date,
                        resolution_source=excluded.resolution_source,
                        outcomes=excluded.outcomes,
                        closes_at=excluded.closes_at,
                        resolution_sources=excluded.resolution_sources,
                        status=excluded.status,
                        outcome=excluded.outcome,
                        resolved_at=excluded.resolved_at,
                        resolution_evidence=excluded.resolution_evidence,
                        source_tweet_ids=excluded.source_tweet_ids,
                        metadata=excluded.metadata,
                        embedding=excluded.embedding,
                        embedding_model=excluded.embedding_model,
                        dim=excluded.dim,
                        canonical_key=excluded.canonical_key
                    """,
                    (
                        market.id,
                        market.question,
                        market.event,
                        market.query,
                        market.category,
                        json.dumps(market.entities),
                        market.resolution_criteria,
                        market.resolution_date,
                        market.resolution_source,
                        json.dumps(market.outcomes),
                        market.closes_at,
                        json.dumps(market.resolution_sources),
                        market.status,
                        market.outcome,
                        market.resolved_at,
                        market.resolution_evidence,
                        market.created_at,
                        json.dumps(market.source_tweet_ids),
                        json.dumps(market.metadata),
                        vec.tobytes(),
                        str(market.metadata.get("embedding_model", "")),
                        self.dim,
                        key,
                    ),
                )
            except sqlite3.IntegrityError as exc:
                if "canonical_key" not in str(exc):
                    raise
                self._conn.rollback()
                row = self._conn.execute(
                    "SELECT id FROM markets WHERE canonical_key=?", (key,)
                ).fetchone()
                raise DuplicateMarketError(row["id"] if row else "unknown") from exc

            self._conn.commit()
            self._dirty = True
        return market

    def get_by_canonical_key(self, key: str) -> Market | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM markets WHERE canonical_key=?", (key,)
            ).fetchone()
        return _row_to_market(row) if row else None

    def set_status(self, market_id: str, status: str) -> Market | None:
        if status not in {"open", "pending_resolution", "resolved", "cancelled"}:
            raise ValueError(f"unknown status: {status}")
        with self._lock:
            cur = self._conn.execute("UPDATE markets SET status=? WHERE id=?", (status, market_id))
            self._conn.commit()
            if cur.rowcount == 0:
                return None
            self._dirty = True
        return self.get(market_id)

    def settle(
        self, market_id: str, *, outcome: str, evidence: str = "", resolved_at: str
    ) -> Market | None:
        """Record a final outcome. VOID cancels the market rather than resolving it."""
        if outcome not in {"YES", "NO", "VOID"}:
            raise ValueError(f"unknown outcome: {outcome}")
        status = "cancelled" if outcome == "VOID" else "resolved"
        with self._lock:
            cur = self._conn.execute(
                "UPDATE markets SET status=?, outcome=?, resolution_evidence=?, resolved_at=? "
                "WHERE id=?",
                (status, outcome, evidence, resolved_at, market_id),
            )
            self._conn.commit()
            if cur.rowcount == 0:
                return None
            self._dirty = True
        return self.get(market_id)

    def due_for_resolution(self, *, on_date: str, limit: int = 100) -> list[Market]:
        """Open markets whose resolution date has arrived."""
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM markets WHERE status='open' AND resolution_date IS NOT NULL "
                "AND resolution_date <= ? ORDER BY resolution_date ASC LIMIT ?",
                (on_date, limit),
            ).fetchall()
        return [_row_to_market(r) for r in rows]

    def delete(self, market_id: str) -> bool:
        with self._lock:
            cur = self._conn.execute("DELETE FROM markets WHERE id=?", (market_id,))
            self._conn.commit()
            self._dirty = True
            return cur.rowcount > 0

    # -- reads -------------------------------------------------------------- #

    def get(self, market_id: str) -> Market | None:
        with self._lock:
            row = self._conn.execute("SELECT * FROM markets WHERE id=?", (market_id,)).fetchone()
        return _row_to_market(row) if row else None

    def list(self, *, status: str | None = None, limit: int = 50, offset: int = 0) -> list[Market]:
        sql = "SELECT * FROM markets"
        params: list[Any] = []
        if status:
            sql += " WHERE status=?"
            params.append(status)
        sql += " ORDER BY created_at DESC LIMIT ? OFFSET ?"
        params += [limit, offset]
        with self._lock:
            rows = self._conn.execute(sql, params).fetchall()
        return [_row_to_market(r) for r in rows]

    def count(self, *, status: str | None = None) -> int:
        sql = "SELECT COUNT(*) AS n FROM markets"
        params: list[Any] = []
        if status:
            sql += " WHERE status=?"
            params.append(status)
        with self._lock:
            return int(self._conn.execute(sql, params).fetchone()["n"])

    def search(
        self,
        embedding: np.ndarray,
        *,
        k: int = 8,
        statuses: Sequence[str] = LIVE_STATUSES,
        min_similarity: float = 0.0,
    ) -> list[SearchHit]:
        """Exact cosine top-k over markets in `statuses`.

        Resolved and cancelled markets are excluded by default: the same fixture
        can legitimately be re-listed next season, and a settled market should
        never block a new one. Markets awaiting settlement still block.
        """
        vec = np.asarray(embedding, dtype=np.float32).ravel()
        if vec.shape[0] != self.dim:
            raise ValueError(f"query has dim {vec.shape[0]}, store expects {self.dim}")

        with self._lock:
            self._ensure_index(tuple(statuses))
            if self._matrix is None or len(self._ids) == 0:
                return []
            sims = self._matrix @ vec
            k = min(k, sims.shape[0])
            top = np.argpartition(-sims, k - 1)[:k]
            top = top[np.argsort(-sims[top])]
            ids = [(self._ids[i], float(sims[i])) for i in top if float(sims[i]) >= min_similarity]

        hits: list[SearchHit] = []
        for market_id, score in ids:
            market = self.get(market_id)
            if market:
                hits.append(SearchHit(market=market, similarity=round(score, 4)))
        return hits

    # -- index -------------------------------------------------------------- #

    def _data_version(self) -> int:
        """SQLite bumps this whenever *another* connection commits.

        Without it the in-memory matrix only invalidates on writes made through
        this instance, so a second process (a second uvicorn worker) would keep
        serving searches from a snapshot taken before the other worker's writes —
        silently missing duplicates. Row reads never had this problem; only the
        cached vector index does.
        """
        return int(self._conn.execute("PRAGMA data_version").fetchone()[0])

    def _ensure_index(self, statuses: tuple[str, ...]) -> None:
        version = self._data_version()
        if version != self._data_version_seen:
            self._dirty = True
            self._data_version_seen = version
        if not self._dirty and statuses == self._index_statuses:
            return
        if statuses:
            placeholders = ",".join("?" for _ in statuses)
            sql = f"SELECT id, embedding FROM markets WHERE status IN ({placeholders})"
            rows = self._conn.execute(sql, statuses).fetchall()
        else:
            rows = self._conn.execute("SELECT id, embedding FROM markets").fetchall()

        self._ids = [r["id"] for r in rows]
        if self._ids:
            self._matrix = np.vstack(
                [np.frombuffer(r["embedding"], dtype=np.float32) for r in rows]
            )
        else:
            self._matrix = None
        self._index_statuses = statuses
        self._dirty = False


def new_market_id() -> str:
    return f"mkt_{uuid.uuid4().hex[:12]}"


def _column(row: sqlite3.Row, name: str) -> Any:
    """Read a column that may not exist yet during an in-flight migration."""
    return row[name] if name in row.keys() else None


def _row_to_market(row: sqlite3.Row) -> Market:
    return Market(
        id=row["id"],
        question=row["question"],
        event=row["event"],
        query=row["query"],
        category=row["category"],
        entities=json.loads(row["entities"]),
        resolution_criteria=row["resolution_criteria"],
        resolution_date=row["resolution_date"],
        resolution_source=row["resolution_source"],
        outcomes=json.loads(_column(row, "outcomes") or '["YES","NO"]'),
        closes_at=_column(row, "closes_at"),
        resolution_sources=json.loads(_column(row, "resolution_sources") or "[]"),
        status=row["status"],
        outcome=_column(row, "outcome"),
        resolved_at=_column(row, "resolved_at"),
        resolution_evidence=_column(row, "resolution_evidence") or "",
        created_at=row["created_at"],
        source_tweet_ids=json.loads(row["source_tweet_ids"]),
        metadata=json.loads(row["metadata"]),
    )
