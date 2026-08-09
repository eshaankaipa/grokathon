"""Live end-to-end demo: X ingest -> Grok -> classifier. Makes REAL, billable calls.

    pip install -e ".[live]"
    python examples/live_e2e.py "warriors lakers -is:retweet lang:en"

Reads XAI_API_KEY and X_BEARER_TOKEN from .env. Hard-capped by RequestBudget so
it cannot run away on pay-per-use billing. Falls back to the fake semantic
classifier if no XAI/Grok key is present.
"""
from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

from classifier import ClassifierConfig, MarketCandidateClassifier
from classifier.semantic.fake import FakeSemanticClassifier
from classifier.semantic.grok import GrokSemanticClassifier
from ingestion.budget import RequestBudget
from ingestion.x_client import XIngestionClient


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
    query = sys.argv[1] if len(sys.argv) > 1 else "prediction market -is:retweet lang:en"

    budget = RequestBudget(max_requests=4)
    client = XIngestionClient(budget=budget)  # bearer from env
    candidate = client.build_candidate_topic(
        topic_id="live-1", topic_name=query, query=query, min_volume=10)
    if candidate is None:
        print({"decision": "skipped", "reason": "volume below min_volume"})
        return

    if os.environ.get("XAI_API_KEY") or os.environ.get("GROK_API_KEY"):
        semantic = GrokSemanticClassifier()
    else:
        print("[no XAI_API_KEY] falling back to FakeSemanticClassifier")
        semantic = FakeSemanticClassifier()

    classifier = MarketCandidateClassifier(
        semantic_classifier=semantic, config=ClassifierConfig())
    result = await classifier.classify(candidate)
    print({
        "decision": result.decision,
        "event": result.canonical_event,
        "query": result.query,
        "score": round(result.score, 3),
        "requests_spent": budget.spent,
    })
    for r in result.reasons:
        print("  -", r)


if __name__ == "__main__":
    asyncio.run(main())
