"""Live top-tweets sweeper with configurable timing.

Pulls X trends, classifies each as CREATE / WAIT / REJECT, and prints the
results. If XAI_API_KEY is not set, it falls back to fake semantic/context
components so the pipeline still runs (for testing and cost-free demos).

Examples:
    # one-shot
    SWEEP_INTERVAL_SECONDS=0 python -m examples.live_top_tweets

    # loop every 5 minutes
    SWEEP_INTERVAL_SECONDS=300 python -m examples.live_top_tweets

    # adjust volume
    MAX_TOPICS=5 MAX_X_REQUESTS=10 python -m examples.live_top_tweets
"""
from __future__ import annotations

import asyncio
import os
import sys
import time
from pathlib import Path

import requests

from classifier import ClassifierConfig, MarketCandidateClassifier
from classifier.semantic.fake import FakeSemanticClassifier
from classifier.semantic.grok_single import GrokSingleShotClassifier
from context.fake import FakeContextBuilder
from context.models import TopicContext
from discovery.composite import CompositeDiscovery
from discovery.configured import ConfiguredDiscovery
from discovery.x_trends import XTrendDiscovery
from ingestion.budget import RequestBudget
from ingestion.x_client import XIngestionClient
from sweeper.config import SweeperConfig
from sweeper.ingestion import XSeedIngestion
from sweeper.sweeper import BackgroundSweeper


def _load_dotenv() -> None:
    """Load .env from current dir or ~/.env."""
    for p in [Path(".env"), Path.home() / ".env"]:
        if p.exists():
            for line in p.read_text().splitlines():
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, val = line.partition("=")
                os.environ.setdefault(key.strip(), val.strip())


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default


def _call_spec_generator(
    sc,
    spec_url: str = os.environ.get("SPEC_GENERATOR_URL", "http://localhost:8000"),
) -> None:
    admin_token = os.environ.get("XPRED_ADMIN_TOKEN")
    if not admin_token:
        print("  [CREATE] XPRED_ADMIN_TOKEN not set; cannot call market-spec-generator.")
        return

    ct = sc.candidate_topic
    posts = ct.representative_posts or []
    tweets = [
        {
            "id": f"{ct.topic_id}-{i}",
            "text": text,
            "author": None,
            "created_at": None,
            "likes": 0,
            "reposts": 0,
            "replies": 0,
            "views": 0,
        }
        for i, text in enumerate(posts)
    ]
    if not tweets:
        print("  [CREATE] no tweets to send to spec generator; skipping.")
        return

    payload = {
        "cluster": {
            "cluster_id": ct.topic_id,
            "topic": sc.topic_seed.name,
            "tweets": tweets,
        },
        "dry_run": False,
    }

    try:
        resp = requests.post(
            f"{spec_url}/ingest",
            headers={
                "Authorization": f"Bearer {admin_token}",
                "Content-Type": "application/json",
            },
            json=payload,
            timeout=120,
        )
        data = resp.json() if resp.headers.get("content-type", "").startswith("application/json") else None
        if resp.ok and data:
            decision = data.get("decision")
            if decision == "CREATE" and data.get("market"):
                market = data["market"]
                market_id = market.get("id")
                print(f"  [CREATE] -> https://xmarket.aidenhuang.com/market/{market_id}")
            else:
                print(f"  [CREATE] spec generator returned: {decision} ({data.get('reason', 'no reason')})")
        else:
            print(f"  [CREATE] spec generator failed ({resp.status_code}): {data or resp.text}")
    except Exception as e:
        print(f"  [CREATE] error calling spec generator: {e}")


async def _run_once() -> None:
    _load_dotenv()

    x_bearer = os.environ.get("X_BEARER_TOKEN")
    if not x_bearer:
        print("Set X_BEARER_TOKEN (in .env or ~/.env) to pull live X trends.")
        sys.exit(1)

    max_topics = _env_int("MAX_TOPICS", 1)
    max_x_requests = _env_int("MAX_X_REQUESTS", 5)
    max_posts = _env_int("MAX_POSTS_PER_TOPIC", 10)
    min_volume = _env_int("MIN_VOLUME", 25)
    max_context_grok_calls = _env_int("MAX_CONTEXT_GROK_CALLS", 2)
    interval = _env_int("SWEEP_INTERVAL_SECONDS", 0)

    cfg = SweeperConfig(
        max_topics_per_sweep=max_topics,
        max_x_requests_per_sweep=max_x_requests,
        max_posts_per_topic=max_posts,
        min_volume=min_volume,
        max_context_grok_calls_per_topic=max_context_grok_calls,
    )

    xai_key = os.environ.get("XAI_API_KEY") or os.environ.get("GROK_API_KEY")
    use_grok = bool(xai_key)

    if use_grok:
        print("INFO: using Grok single-shot for context + classification (one call).")
        single = GrokSingleShotClassifier()
        context_builder = single
        semantic = single
    else:
        print("INFO: XAI_API_KEY not found; using fake semantic + context.")
        semantic = FakeSemanticClassifier()
        context_builder = FakeContextBuilder(
            default=TopicContext(
                summary="Synthetic context for offline demo.",
                entities=(),
                key_developments=(),
                unresolved_events=(),
                source_post_ids=(),
            )
        )

    if not use_grok:
        print("WARNING: no XAI_API_KEY. Classifications are deterministic fakes.")
    print(f"  max topics: {max_topics}")
    print(f"  max posts/topic: {max_posts}")
    print(f"  max X requests: {max_x_requests}")
    print(f"  max Grok context calls/topic: {max_context_grok_calls}")
    print(f"  sweep interval: {interval}s (0 = one-shot)")

    budget = RequestBudget(max_requests=cfg.max_x_requests_per_sweep)
    client = XIngestionClient(budget=budget)
    discovery = CompositeDiscovery(
        [
            XTrendDiscovery(client, woeid=1, limit=cfg.max_topics_per_sweep),
            ConfiguredDiscovery(["fed rate decision -is:retweet lang:en"]),
        ]
    )
    sweeper = BackgroundSweeper(
        discovery=discovery,
        ingestion=XSeedIngestion(client, cfg),
        context_builder=context_builder,
        classifier=MarketCandidateClassifier(
            semantic_classifier=semantic, config=ClassifierConfig()
        ),
        budget=budget,
        config=cfg,
    )

    result = await sweeper.run_once()

    print(f"\nX requests spent: {result.requests_spent}")
    print(f"CREATE: {len(result.create)}  WAIT: {len(result.wait)}  REJECT/skip: {result.rejected_count}")
    for label, bucket in (("CREATE", result.create), ("WAIT", result.wait), ("REJECT", [])):
        if label == "REJECT":
            continue
        for sc in bucket:
            r = sc.classification_result
            ct = sc.candidate_topic
            print(
                f"  [{label}] {sc.topic_seed.name} "
                f"(posts={ct.post_count}, score={r.score:.2f}, query={r.query})"
            )
            if label == "CREATE":
                _call_spec_generator(sc)


async def main() -> None:
    _load_dotenv()
    interval = _env_int("SWEEP_INTERVAL_SECONDS", 0)

    while True:
        start = time.time()
        await _run_once()
        if interval <= 0:
            break
        elapsed = time.time() - start
        sleep_for = max(0, interval - elapsed)
        if sleep_for > 0:
            print(f"\nSleeping {sleep_for:.0f}s until next sweep...")
            time.sleep(sleep_for)


if __name__ == "__main__":
    asyncio.run(main())
