from classifier import CandidateTopic
from discovery.base import TopicSeed
from sweeper.config import SweeperConfig
from sweeper.ingestion import FakeSeedIngestion, SeedIngestion, XSeedIngestion


class _Client:
    def __init__(self, result):
        self._result = result
        self.calls = []

    def build_candidate_topic(self, **kwargs):
        self.calls.append(kwargs)
        return self._result


async def test_x_seed_ingestion_maps_seed_to_client_call():
    cand = CandidateTopic(topic_id="t", topic_name="Warriors Lakers")
    client = _Client(cand)
    cfg = SweeperConfig(max_posts_per_topic=30, min_volume=50)
    ing = XSeedIngestion(client, cfg)
    seed = TopicSeed(topic_id="t", name="Warriors Lakers", source="trend",
                     metadata={"query": "warriors lakers"})
    got = await ing.ingest(seed)
    assert got is cand
    assert client.calls[0]["query"] == "warriors lakers"
    assert client.calls[0]["min_volume"] == 50
    assert client.calls[0]["max_posts"] == 30
    assert isinstance(ing, SeedIngestion)


async def test_x_seed_ingestion_falls_back_to_seed_name_as_query():
    client = _Client(None)
    ing = XSeedIngestion(client, SweeperConfig())
    await ing.ingest(TopicSeed(topic_id="t", name="Fed rate", source="configured", metadata={}))
    assert client.calls[0]["query"] == "Fed rate"


async def test_fake_seed_ingestion_returns_presets():
    cand = CandidateTopic(topic_id="t", topic_name="x")
    ing = FakeSeedIngestion({"t": cand, "low": None})
    assert await ing.ingest(TopicSeed("t", "x", "trend", {})) is cand
    assert await ing.ingest(TopicSeed("low", "y", "trend", {})) is None
