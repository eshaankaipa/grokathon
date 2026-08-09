"""Embed markets that exist in Supabase but have no dedup index entry.

    python -m scripts.supabase_backfill --dry-run
    python -m scripts.supabase_backfill

Until a market is indexed it cannot block a duplicate, so markets created before
this service existed are invisible to dedup. This writes only to
`market_embeddings` — the `markets` table is never modified.

Those markets carry no canonical event, query, or entities (this service didn't
create them), so the embedded text is built from the question instead. That puts
them slightly off the space that pipeline-created markets occupy — good enough to
catch near-duplicates, but re-check anything borderline.
"""

from __future__ import annotations

import asyncio
import sys

from app.config import get_settings
from app.embeddings import OpenAIEmbedder, canonical_text
from app.models import Market
from app.store import canonical_key
from app.supabase_store import CATEGORY_TO_DB, SupabaseStore


def _as_market(row: dict) -> Market:
    """Best-effort spec for a market this service did not create."""
    closes = (row.get("closes_at") or "")[:10] or None
    category = str(row.get("category") or "other").lower()
    # Map their capitalised vocabulary back to ours where possible.
    reverse = {v.lower(): k for k, v in CATEGORY_TO_DB.items()}
    return Market(
        id=str(row["id"]),
        question=row.get("question") or "",
        event=row.get("question") or "",   # no canonical event exists for these
        query="",
        category=reverse.get(category, category),
        entities=[],
        resolution_criteria=row.get("resolution_criteria") or "",
        resolution_date=closes,
        status="open",
    )


async def main() -> int:
    dry_run = "--dry-run" in sys.argv
    settings = get_settings()
    store = SupabaseStore(settings.supabase_url, settings.supabase_service_key,
                          dim=settings.embedding_dim)
    embedder = OpenAIEmbedder(settings)

    try:
        markets = store._request("GET", "/markets", params={"select": "*", "limit": 1000})
        indexed = {
            r["market_id"] for r in
            store._request("GET", "/market_embeddings",
                           params={"select": "market_id", "limit": 5000})
        }
        pending = [r for r in markets if str(r["id"]) not in indexed]

        print(f"{len(markets)} market(s), {len(indexed)} already indexed, "
              f"{len(pending)} to embed")
        if not pending:
            print("nothing to do")
            return 0

        seen_keys: dict[str, str] = {}
        embedded = skipped = 0

        for row in pending:
            market = _as_market(row)
            if not market.question.strip():
                print(f"  skip {market.id}  (no question)")
                skipped += 1
                continue

            key = canonical_key(market)
            if key in seen_keys:
                # Two existing markets that normalize identically. Indexing both
                # would violate the UNIQUE constraint, and one of them is a
                # pre-existing duplicate worth knowing about.
                print(f"  skip {market.id}  (same canonical key as {seen_keys[key]})")
                print(f"       {market.question[:70]}")
                skipped += 1
                continue
            seen_keys[key] = market.id

            if dry_run:
                print(f"  would embed {market.id}  {market.question[:60]}")
                embedded += 1
                continue

            vector = await embedder.embed_one(canonical_text(
                event=market.event, query=market.query, entities=market.entities,
                category=market.category, resolution_date=market.resolution_date,
            ))
            try:
                store._request(
                    "POST", "/market_embeddings",
                    params={"on_conflict": "market_id"},
                    headers={"Prefer": "resolution=merge-duplicates,return=minimal"},
                    json=[store._embedding_row(market, vector, key)],
                )
            except Exception as exc:  # noqa: BLE001 — report and continue
                print(f"  FAIL {market.id}: {exc}")
                skipped += 1
                continue
            print(f"  embedded {market.id}  {market.question[:60]}")
            embedded += 1

        verb = "would embed" if dry_run else "embedded"
        print(f"\n{verb} {embedded}, skipped {skipped}")
        if dry_run:
            print("dry run — nothing was written")
    finally:
        store.close()
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
