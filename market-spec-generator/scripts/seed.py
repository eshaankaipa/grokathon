"""Seed the vector DB with a handful of existing markets so dedup has something to hit.

    python -m scripts.seed
"""

from __future__ import annotations

import asyncio

from app import deps
from app.models import Market
from app.store import new_market_id

SEED = [
    Market(
        id=new_market_id(),
        question="Will the Golden State Warriors defeat the Los Angeles Lakers on August 8, 2026?",
        event="Golden State Warriors vs Los Angeles Lakers, Aug 8 2026",
        query="Warriors Lakers August 8 2026",
        category="sports",
        entities=["Golden State Warriors", "Los Angeles Lakers"],
        resolution_criteria="Resolves YES if the Warriors win the Aug 8, 2026 game per the official box score. Postponement past Aug 15 cancels.",
        resolution_date="2026-08-08",
        resolution_source="NBA official box score",
    ),
    Market(
        id=new_market_id(),
        question="Will Bitcoin close above $150,000 on December 31, 2026?",
        event="Bitcoin year-end close 2026",
        query="Bitcoin 150000 December 31 2026 close",
        category="crypto",
        entities=["Bitcoin"],
        resolution_criteria="Resolves YES if Coinbase BTC-USD spot is above $150,000 at 00:00 UTC on Jan 1, 2027.",
        resolution_date="2026-12-31",
        resolution_source="Coinbase BTC-USD spot",
    ),
    Market(
        id=new_market_id(),
        question="Will Apple announce a foldable iPhone at its September 2026 event?",
        event="Apple September 2026 product event, foldable iPhone announcement",
        query="Apple foldable iPhone September 2026 event",
        category="tech",
        entities=["Apple"],
        resolution_criteria="Resolves YES if Apple announces a foldable-display iPhone during its September 2026 keynote.",
        resolution_date="2026-09-30",
        resolution_source="Apple newsroom / keynote livestream",
    ),
]


async def main() -> None:
    svc = deps.build()
    try:
        for market in SEED:
            await svc.pipeline.add_existing(market)
            print(f"  + {market.id}  {market.question}")
        print(f"\n{svc.store.count()} markets in {svc.settings.db_path}")
    finally:
        svc.close()


if __name__ == "__main__":
    asyncio.run(main())
