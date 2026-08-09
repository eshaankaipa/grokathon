from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app.classifier import Classifier
from app.models import Decision, Tweet, TweetCluster
from tests.conftest import FakeLLM


def cluster(engagement_likes: int = 10_000) -> TweetCluster:
    return TweetCluster(
        cluster_id="c1",
        topic="#NBA",
        tweets=[Tweet(id="1", text="Lakers at Warriors on August 8", likes=engagement_likes)],
    )


def create_payload(**kw) -> dict:
    tomorrow = (datetime.now(timezone.utc) + timedelta(days=1)).date().isoformat()
    payload = {
        "decision": "CREATE",
        "event": "Golden State Warriors vs Los Angeles Lakers",
        "query": "Warriors Lakers",
        "category": "sports",
        "entities": ["Golden State Warriors", "Los Angeles Lakers"],
        "resolution_date": tomorrow,
        "confidence": 0.9,
        "reason": "Scheduled game with a verifiable winner.",
    }
    payload.update(kw)
    return payload


async def test_create_passes_through():
    llm = FakeLLM([create_payload()])
    result = await Classifier(llm, min_engagement=500).classify(cluster())

    assert result.decision is Decision.CREATE
    assert result.event.startswith("Golden State Warriors")
    assert result.entities == ["Golden State Warriors", "Los Angeles Lakers"]


async def test_low_engagement_downgrades_to_wait():
    llm = FakeLLM([create_payload()])
    result = await Classifier(llm, min_engagement=500).classify(cluster(engagement_likes=10))

    assert result.decision is Decision.WAIT
    assert "engagement" in result.reason


async def test_past_resolution_date_is_rejected():
    yesterday = (datetime.now(timezone.utc) - timedelta(days=1)).date().isoformat()
    llm = FakeLLM([create_payload(resolution_date=yesterday)])
    result = await Classifier(llm, min_engagement=0).classify(cluster())

    assert result.decision is Decision.REJECT
    assert "past" in result.reason


async def test_create_without_event_becomes_wait():
    llm = FakeLLM([create_payload(event="", query="")])
    result = await Classifier(llm, min_engagement=0).classify(cluster())

    assert result.decision is Decision.WAIT


async def test_unknown_decision_defaults_to_wait():
    llm = FakeLLM([{"decision": "MAYBE", "event": "something"}])
    result = await Classifier(llm, min_engagement=0).classify(cluster())

    assert result.decision is Decision.WAIT
    assert result.reason


async def test_garbage_fields_are_coerced():
    llm = FakeLLM([create_payload(
        category="sportsball", entities="not a list", confidence="high", resolution_date="not-a-date",
    )])
    result = await Classifier(llm, min_engagement=0).classify(cluster())

    assert result.category == "other"
    assert result.entities == []
    assert result.confidence == 0.0
    assert result.resolution_date is None


async def test_reject_skips_the_engagement_guard():
    llm = FakeLLM([create_payload(decision="REJECT", reason="Subjective opinion.")])
    result = await Classifier(llm, min_engagement=10_000_000).classify(cluster())

    assert result.decision is Decision.REJECT
    assert result.reason == "Subjective opinion."
