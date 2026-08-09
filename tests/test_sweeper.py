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


def _cand(tid, **kw):
    return CandidateTopic(topic_id=tid, topic_name=tid, post_count=9000,
                          engagement_count=60000, volume_velocity=250.0,
                          volume_growth=2.5, unique_author_count=5000,
                          topic_age_minutes=120.0, **kw)


_CREATE = SemanticFeatures(0.9, 0.95, 0.9, 0.1, 0.85, canonical_event="Big Game 2026")
_WAIT = SemanticFeatures(0.6, 0.6, 0.9, 0.3, 0.2, canonical_event="Vague thing")
_REJECT = SemanticFeatures(0.1, 0.1, 0.8, 0.9, 0.3)


def _sweeper(seeds, ingest_map, features_map, *, budget=None, config=None,
             context_builder=None):
    budget = budget or RequestBudget(max_requests=(config or SweeperConfig()).max_x_requests_per_sweep)
    classifier = MarketCandidateClassifier(
        semantic_classifier=FakeSemanticClassifier(features_by_topic_id=features_map),
        config=ClassifierConfig())
    return BackgroundSweeper(
        discovery=FakeTopicDiscovery(seeds),
        ingestion=FakeSeedIngestion(ingest_map),
        context_builder=context_builder or FakeContextBuilder(),
        classifier=classifier,
        budget=budget,
        config=config or SweeperConfig(),
    )


async def test_buckets_by_decision():
    seeds = [TopicSeed("c", "c", "trend", {}), TopicSeed("w", "w", "trend", {}),
             TopicSeed("r", "r", "trend", {})]
    ingest = {"c": _cand("c"), "w": _cand("w"), "r": _cand("r")}
    feats = {"c": _CREATE, "w": _WAIT, "r": _REJECT}
    result = await _sweeper(seeds, ingest, feats).run_once()
    assert [sc.topic_seed.topic_id for sc in result.create] == ["c"]
    assert [sc.topic_seed.topic_id for sc in result.wait] == ["w"]
    assert result.rejected_count == 1
    assert result.create[0].classification_result.decision == "CREATE"
    assert result.create[0].topic_context is not None


async def test_low_volume_seed_skips_context_and_classify():
    calls = {"built": 0}

    class _CountingContext(FakeContextBuilder):
        async def build(self, candidate):
            calls["built"] += 1
            return await super().build(candidate)

    seeds = [TopicSeed("low", "low", "trend", {})]
    result = await _sweeper(seeds, {"low": None}, {},
                            context_builder=_CountingContext()).run_once()
    assert calls["built"] == 0
    assert result.rejected_count == 1
    assert result.create == () and result.wait == ()


async def test_duplicate_seeds_ingested_once():
    ingested = []

    class _CountingIngest(FakeSeedIngestion):
        async def ingest(self, seed):
            ingested.append(seed.topic_id)
            return await super().ingest(seed)

    seeds = [TopicSeed("wl", "Warriors Lakers", "trend", {}),
             TopicSeed("lw", "Lakers vs Warriors", "configured", {})]
    sw = BackgroundSweeper(
        discovery=FakeTopicDiscovery(seeds),
        ingestion=_CountingIngest({"wl": _cand("wl")}),
        context_builder=FakeContextBuilder(),
        classifier=MarketCandidateClassifier(
            semantic_classifier=FakeSemanticClassifier(features_by_topic_id={"wl": _CREATE})),
        budget=RequestBudget(max_requests=SweeperConfig().max_x_requests_per_sweep),
        config=SweeperConfig(),
    )
    result = await sw.run_once()
    assert ingested == ["wl"]                 # duplicate collapsed before ingestion
    assert len(result.create) == 1


async def test_max_topics_per_sweep_caps_processing():
    seeds = [TopicSeed(f"t{i}", f"topic {i}", "trend", {}) for i in range(5)]
    ingest = {f"t{i}": _cand(f"t{i}") for i in range(5)}
    feats = {f"t{i}": _CREATE for i in range(5)}
    cfg = SweeperConfig(max_topics_per_sweep=2)
    result = await _sweeper(seeds, ingest, feats, config=cfg).run_once()
    assert len(result.create) == 2


async def test_budget_exhaustion_returns_partial():
    budget = RequestBudget(max_requests=2)

    class _SpendingIngest(FakeSeedIngestion):
        def __init__(self, by_id, budget):
            super().__init__(by_id)
            self._budget = budget

        async def ingest(self, seed):
            self._budget.spend("search/recent")  # raises BudgetExceeded when exhausted
            return await super().ingest(seed)

    seeds = [TopicSeed(f"t{i}", f"t{i}", "trend", {}) for i in range(5)]
    ingest_map = {f"t{i}": _cand(f"t{i}") for i in range(5)}
    feats = {f"t{i}": _CREATE for i in range(5)}
    sw = BackgroundSweeper(
        discovery=FakeTopicDiscovery(seeds),
        ingestion=_SpendingIngest(ingest_map, budget),
        context_builder=FakeContextBuilder(),
        classifier=MarketCandidateClassifier(
            semantic_classifier=FakeSemanticClassifier(features_by_topic_id=feats)),
        budget=budget,
        config=SweeperConfig(),
    )
    result = await sw.run_once()
    assert len(result.create) == 2          # only 2 processed before budget ran out
    assert result.requests_spent == 2       # partial, no crash


async def test_budget_cap_must_not_exceed_config():
    import pytest
    with pytest.raises(ValueError):
        BackgroundSweeper(
            discovery=FakeTopicDiscovery([]),
            ingestion=FakeSeedIngestion({}),
            context_builder=FakeContextBuilder(),
            classifier=MarketCandidateClassifier(semantic_classifier=FakeSemanticClassifier()),
            budget=RequestBudget(max_requests=1000),
            config=SweeperConfig(max_x_requests_per_sweep=8),
        )
