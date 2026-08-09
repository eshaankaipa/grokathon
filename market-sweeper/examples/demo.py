"""Offline end-to-end demo (no network): Fake semantic -> classifier.

Run: python examples/demo.py
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


async def main() -> None:
    candidate = CandidateTopic(
        topic_id="warriors_lakers",
        topic_name="Warriors vs Lakers game tonight",
        representative_posts=["warriors lakers tonight", "steph vs lebron one more time"],
        post_count=8000, unique_author_count=5200, engagement_count=64000,
        volume_velocity=250.0, volume_growth=2.4, topic_age_minutes=110.0,
        metadata={"source": "demo"},
    )
    semantic = FakeSemanticClassifier(features_by_topic_id={
        candidate.topic_id: SemanticFeatures(
            eventness=0.9, resolvability=0.95, unresolvedness=0.9,
            subjectivity=0.1, specificity=0.85,
            canonical_event="Golden State Warriors vs Los Angeles Lakers, Aug 8 2026",
        )
    })
    classifier = MarketCandidateClassifier(
        semantic_classifier=semantic, config=ClassifierConfig())
    result = await classifier.classify(candidate)
    print({
        "decision": result.decision,
        "event": result.canonical_event,
        "query": result.query,
    })


if __name__ == "__main__":
    asyncio.run(main())
