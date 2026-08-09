"""Preflight the Supabase backend. Read-only — creates and deletes nothing.

    python -m scripts.supabase_check

Checks, in the order they'd break:
  1. credentials present and accepted
  2. the migration has been run (table + RPC exist)
  3. the embedding dimension matches this service's model
  4. how many markets are indexed vs. unindexed
"""

from __future__ import annotations

import sys

import httpx
import numpy as np

from app.config import get_settings
from app.supabase_store import SupabaseStore

OK, BAD, WARN = "  OK  ", " FAIL ", " WARN "


def main() -> int:
    settings = get_settings()
    failures = 0

    if not settings.supabase_url:
        print(f"{BAD} SUPABASE_URL is not set")
        return 1
    print(f"{OK} url: {settings.supabase_url}")

    if not settings.supabase_service_key:
        print(f"{BAD} SUPABASE_SERVICE_KEY is not set.")
        print("       The publishable/anon key cannot write — RLS blocks it. Get the")
        print("       service_role key from Dashboard -> Settings -> API.")
        return 1
    print(f"{OK} service key present ({len(settings.supabase_service_key)} chars)")

    store = SupabaseStore(settings.supabase_url, settings.supabase_service_key,
                          dim=settings.embedding_dim)
    try:
        # 1. Can we read the markets table at all?
        try:
            total = store.count()
            print(f"{OK} markets table reachable — {total} row(s)")
        except httpx.HTTPStatusError as exc:
            print(f"{BAD} cannot read markets: HTTP {exc.response.status_code} {exc.response.text[:120]}")
            return 1

        # 2. Has the migration run?
        try:
            indexed = store._request("GET", "/market_embeddings",
                                     params={"select": "market_id", "limit": 1000})
            print(f"{OK} market_embeddings exists — {len(indexed)} market(s) indexed")
            if total and not indexed:
                print(f"{WARN} no markets are indexed yet, so dedup has nothing to compare")
                print("       against. Backfill with: python -m scripts.supabase_backfill")
        except httpx.HTTPStatusError as exc:
            print(f"{BAD} market_embeddings missing (HTTP {exc.response.status_code}).")
            print("       Run sql/001_market_embeddings.sql in the Supabase SQL editor.")
            return 1

        # 3. Does the RPC exist, and does its vector width match our model?
        probe = np.zeros(settings.embedding_dim, dtype=np.float32)
        probe[0] = 1.0
        try:
            store.search(probe, k=1)
            print(f"{OK} match_markets RPC works at dim {settings.embedding_dim} "
                  f"({settings.embedding_model})")
        except httpx.HTTPStatusError as exc:
            body = exc.response.text[:200]
            if "match_markets" in body or exc.response.status_code == 404:
                print(f"{BAD} match_markets RPC not found — re-run the migration.")
            elif "expected" in body and "dimensions" in body:
                print(f"{BAD} dimension mismatch: the table was created for a different "
                      f"embedding size than {settings.embedding_dim}. {body}")
            else:
                print(f"{BAD} RPC failed: HTTP {exc.response.status_code} {body}")
            failures += 1

        # 4. Status vocabulary — settlement needs more than open/resolved.
        statuses = {
            r.get("status") for r in
            store._request("GET", "/markets", params={"select": "status", "limit": 1000})
        }
        print(f"{OK} statuses in use: {sorted(s for s in statuses if s)}")
        print("       this service also writes 'pending_resolution' and 'cancelled';")
        print("       if markets.status has a CHECK constraint, widen it (see the SQL file).")
    finally:
        store.close()

    print("\nREADY" if not failures else f"\n{failures} check(s) failed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
