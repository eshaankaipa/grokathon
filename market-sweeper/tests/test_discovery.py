from discovery.base import TopicDiscovery, TopicSeed
from discovery.composite import CompositeDiscovery
from discovery.configured import ConfiguredDiscovery
from discovery.fake import FakeTopicDiscovery
from discovery.x_trends import XTrendDiscovery


class _TrendClient:
    def __init__(self, raw):
        self._raw = raw
        self.trend_calls = 0

    def fetch_trends(self, woeid=1):
        self.trend_calls += 1
        return self._raw


async def test_fake_discovery_returns_seeds():
    seeds = [TopicSeed(topic_id="a", name="A", source="configured", metadata={})]
    disc = FakeTopicDiscovery(seeds)
    assert await disc.discover() == seeds
    assert isinstance(disc, TopicDiscovery)


async def test_configured_discovery_builds_seeds():
    disc = ConfiguredDiscovery(["Fed rate decision", "Warriors Lakers"])
    seeds = await disc.discover()
    assert all(isinstance(s, TopicSeed) for s in seeds)
    assert all(s.source == "configured" for s in seeds)
    assert seeds[0].metadata["query"] == "Fed rate decision"


async def test_x_trend_discovery_parses_raw_into_seeds_no_leak():
    raw = [{"trend_name": "#AI", "tweet_count": 5000},
           {"trend_name": "Warriors", "tweet_count": None},
           {"not_a_trend": "ignored"}]  # malformed entry dropped
    disc = XTrendDiscovery(_TrendClient(raw), woeid=1, limit=10)
    seeds = await disc.discover()
    assert [s.name for s in seeds] == ["#AI", "Warriors"]
    assert all(isinstance(s, TopicSeed) for s in seeds)
    assert all(s.source == "trend" for s in seeds)
    assert seeds[0].metadata["query"] == "#AI"       # query derived from trend name


async def test_composite_merges_sources():
    a = FakeTopicDiscovery([TopicSeed("a", "A", "trend", {})])
    b = FakeTopicDiscovery([TopicSeed("b", "B", "configured", {})])
    merged = await CompositeDiscovery([a, b]).discover()
    assert {s.name for s in merged} == {"A", "B"}
