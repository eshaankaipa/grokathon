from discovery.base import TopicSeed
from sweeper.dedup import dedupe_seeds


def _seed(name):
    return TopicSeed(topic_id=name.lower().replace(" ", "-"), name=name,
                     source="trend", metadata={})


def test_token_set_dedup_collapses_reorderings():
    seeds = [_seed("Warriors Lakers"), _seed("Lakers vs Warriors"), _seed("Fed rate")]
    out = dedupe_seeds(seeds)
    names = [s.name for s in out]
    assert names == ["Warriors Lakers", "Fed rate"]  # 2nd collapsed, first kept


def test_distinct_topics_are_kept():
    seeds = [_seed("OpenAI launch"), _seed("Bitcoin ETF")]
    assert len(dedupe_seeds(seeds)) == 2
