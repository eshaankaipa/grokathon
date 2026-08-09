"""End-to-end demo: three tweet clusters through the full pipeline.

    python -m scripts.seed && python -m scripts.demo

Cluster 1 is a fresh market. Cluster 2 says the same thing in different words and
should come back DUPLICATE. Cluster 3 is opinion bait and should be REJECT.
"""

from __future__ import annotations

import asyncio
import json

from app import deps
from app.models import Tweet, TweetCluster

CLUSTERS = [
    TweetCluster(
        cluster_id="c1",
        topic="#SuperBowl",
        tweets=[
            Tweet(id="1", author="nflinsider", text="Chiefs open as 3.5 point favorites over the 49ers for Super Bowl LXI on February 7, 2027.", likes=4200, reposts=1100, replies=380, views=910_000),
            Tweet(id="2", author="statmuse", text="Kansas City is 4-1 against San Francisco in the Mahomes era. Feb 7 2027 rematch is set.", likes=2100, reposts=640, replies=150, views=300_000),
            Tweet(id="3", author="oddsshark", text="Super Bowl LXI line moving: Chiefs -3.5 vs 49ers. Kickoff Feb 7, 2027.", likes=1800, reposts=520, replies=210, views=250_000),
        ],
    ),
    TweetCluster(
        cluster_id="c2",
        topic="Warriors Lakers",
        tweets=[
            Tweet(id="10", author="nbaonx", text="Lakers at Warriors tomorrow, August 8. Curry questionable, LeBron probable.", likes=5200, reposts=1400, replies=600, views=1_200_000),
            Tweet(id="11", author="dubnation", text="Chase Center Aug 8 vs the Lakers. Dubs need this one.", likes=1900, reposts=430, replies=280, views=210_000),
        ],
    ),
    TweetCluster(
        cluster_id="c3",
        topic="hot takes",
        tweets=[
            Tweet(id="20", author="takesguy", text="Honestly the new album is the worst thing released this decade and nobody wants to admit it", likes=8800, reposts=2300, replies=4100, views=2_000_000),
            Tweet(id="21", author="musicfan", text="hard disagree, it's a masterpiece, people just have no taste", likes=3200, reposts=700, replies=900, views=400_000),
        ],
    ),
]


async def main() -> None:
    svc = deps.build()
    try:
        for cluster in CLUSTERS:
            print(f"\n=== cluster {cluster.cluster_id} ({cluster.topic}) " + "=" * 30)
            result = await svc.pipeline.run(cluster)
            print(json.dumps(
                {
                    "decision": result.decision,
                    "event": result.event,
                    "query": result.query,
                    "reason": result.reason,
                    "question": result.market.question if result.market else None,
                    "duplicate_of": result.duplicate_of.question if result.duplicate_of else None,
                    "nearest": [
                        {"q": c.question, "sim": c.similarity} for c in result.candidates[:3]
                    ],
                },
                indent=2,
            ))
    finally:
        svc.close()


if __name__ == "__main__":
    asyncio.run(main())
