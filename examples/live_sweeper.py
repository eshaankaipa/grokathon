"""Live Background Sweeper — makes REAL, billable X + Grok calls.

    pip install -e ".[live]"
    python -m examples.live_sweeper

Requires X_BEARER_TOKEN and XAI_API_KEY in .env. Uses a tiny X request budget
by default, prints the request count, and makes NO write calls. Never run by tests.
"""
from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

from classifier import ClassifierConfig, MarketCandidateClassifier
from classifier.semantic.grok import GrokSemanticClassifier
from context.config import ContextConfig
from context.grok import GrokContextBuilder
from discovery.composite import CompositeDiscovery
from discovery.configured import ConfiguredDiscovery
from discovery.x_trends import XTrendDiscovery
from ingestion.budget import RequestBudget
from ingestion.x_client import XIngestionClient
from sweeper.config import SweeperConfig
from sweeper.ingestion import XSeedIngestion
from sweeper.sweeper import BackgroundSweeper


def _load_dotenv(path: str = ".env") -> None:
    p = Path(path)
    if not p.exists():
        return
    for line in p.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        os.environ.setdefault(key.strip(), val.strip())


async def main() -> None:
    _load_dotenv()
    if not os.environ.get("X_BEARER_TOKEN") or not (
        os.environ.get("XAI_API_KEY") or os.environ.get("GROK_API_KEY")
    ):
        print("Set X_BEARER_TOKEN and XAI_API_KEY (in .env) to run the live sweeper.")
        sys.exit(1)

    cfg = SweeperConfig(
        max_topics_per_sweep=3, max_x_requests_per_sweep=8,
        max_posts_per_topic=40, min_volume=25,
    )
    print("WARNING: this makes REAL, billable X + Grok API calls.")
    print(f"  max X requests this sweep: {cfg.max_x_requests_per_sweep}")
    print("  press Ctrl-C within 3s to abort...")
    await asyncio.sleep(3)

    budget = RequestBudget(max_requests=cfg.max_x_requests_per_sweep)
    client = XIngestionClient(budget=budget)  # bearer from env
    discovery = CompositeDiscovery([
        XTrendDiscovery(client, woeid=1, limit=cfg.max_topics_per_sweep),
        ConfiguredDiscovery(["fed rate decision -is:retweet lang:en"]),
    ])
    sweeper = BackgroundSweeper(
        discovery=discovery,
        ingestion=XSeedIngestion(client, cfg),
        context_builder=GrokContextBuilder(
            config=ContextConfig(max_grok_calls_per_topic=cfg.max_context_grok_calls_per_topic)),
        classifier=MarketCandidateClassifier(
            semantic_classifier=GrokSemanticClassifier(), config=ClassifierConfig()),
        budget=budget,
        config=cfg,
    )
    result = await sweeper.run_once()

    print(f"\nX requests spent: {result.requests_spent}")
    print(f"CREATE: {len(result.create)}  WAIT: {len(result.wait)}  "
          f"REJECT/skip: {result.rejected_count}")
    for label, bucket in (("CREATE", result.create), ("WAIT", result.wait)):
        for sc in bucket:
            r = sc.classification_result
            print(f"  [{label}] {sc.topic_seed.name} -> {r.canonical_event} "
                  f"(score {r.score:.2f}, query={r.query})")


if __name__ == "__main__":
    asyncio.run(main())
