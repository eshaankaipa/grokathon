"""Offline Background Sweeper demo (no network, no keys).

Run: python -m examples.sweeper_demo
"""
from __future__ import annotations

import asyncio

from classifier import (
    CandidateTopic,
    ClassifierConfig,
    FakeSemanticClassifier,
    MarketCandidateClassifier,
    SemanticFeatures,
)
from context.fake import FakeContextBuilder
from discovery.base import TopicSeed
from discovery.fake import FakeTopicDiscovery
from ingestion.budget import RequestBudget
from sweeper.config import SweeperConfig
from sweeper.ingestion import FakeSeedIngestion
from sweeper.sweeper import BackgroundSweeper


def _cand(topic_id: str, name: str) -> CandidateTopic:
    return CandidateTopic(
        topic_id=topic_id, topic_name=name,
        representative_posts=[f"{name} is happening", f"everyone talking about {name}"],
        post_count=8000, unique_author_count=5000, engagement_count=64000,
        volume_velocity=250.0, volume_growth=2.4, topic_age_minutes=120.0,
    )


async def main() -> None:
    seeds = [
        TopicSeed("warriors-lakers", "Warriors Lakers", "trend", {}),
        TopicSeed("lakers-vs-warriors", "Lakers vs Warriors", "configured", {}),  # dup
        TopicSeed("openai-announcement", "OpenAI announcement", "trend", {}),
        TopicSeed("steph-is-the-goat", "Steph is the GOAT", "trend", {}),
        TopicSeed("quiet-topic", "Quiet Topic", "configured", {}),  # below min-volume
    ]
    ingest = {
        "warriors-lakers": _cand("warriors-lakers", "Warriors Lakers"),
        "openai-announcement": _cand("openai-announcement", "OpenAI announcement"),
        "steph-is-the-goat": _cand("steph-is-the-goat", "Steph is the GOAT"),
        "quiet-topic": None,  # below min-volume -> skipped after counts
    }
    features = {
        "warriors-lakers": SemanticFeatures(0.9, 0.95, 0.9, 0.1, 0.85,
                                            canonical_event="Golden State Warriors vs Los Angeles Lakers, Aug 8 2026"),
        "openai-announcement": SemanticFeatures(0.55, 0.55, 0.9, 0.3, 0.2,
                                                canonical_event="Upcoming OpenAI product announcement"),
        "steph-is-the-goat": SemanticFeatures(0.15, 0.1, 0.8, 0.95, 0.3),
    }

    cfg = SweeperConfig()
    sweeper = BackgroundSweeper(
        discovery=FakeTopicDiscovery(seeds),
        ingestion=FakeSeedIngestion(ingest),
        context_builder=FakeContextBuilder(),
        classifier=MarketCandidateClassifier(
            semantic_classifier=FakeSemanticClassifier(features_by_topic_id=features),
            config=ClassifierConfig()),
        budget=RequestBudget(max_requests=cfg.max_x_requests_per_sweep),
        config=cfg,
    )
    result = await sweeper.run_once()

    print(f"Discovered {len(seeds)} topics\n")
    print("CREATE")
    for sc in result.create:
        print(f"  {sc.topic_seed.name}")
        print(f"    canonical event: {sc.classification_result.canonical_event}")
        print(f"    query: {sc.classification_result.query}")
        print(f"    score: {sc.classification_result.score:.2f}")
    print("\nWAIT")
    for sc in result.wait:
        print(f"  {sc.topic_seed.name}")
        print(f"    canonical event: {sc.classification_result.canonical_event}")
        print(f"    score: {sc.classification_result.score:.2f}")
    print(f"\nRejected: {result.rejected_count}")
    print(f"Requests spent: {result.requests_spent}")


if __name__ == "__main__":
    asyncio.run(main())
