import json

from classifier import CandidateTopic
from context.config import ContextConfig
from context.grok import GrokContextBuilder
from context.models import TopicContext


class _Msg:
    def __init__(self, content):
        self.content = content


class _Choice:
    def __init__(self, content):
        self.message = _Msg(content)


class _Resp:
    def __init__(self, content):
        self.choices = [_Choice(content)]


class _FakeClient:
    """Returns queued JSON strings; records each call's messages."""

    def __init__(self, payloads):
        self._payloads = list(payloads)
        self.calls = []
        self.chat = self  # so client.chat.completions.create resolves
        self.completions = self

    async def create(self, **kwargs):
        self.calls.append(kwargs)
        return _Resp(self._payloads.pop(0))


def _ctx_json(summary, entities=(), devs=(), unresolved=()):
    return json.dumps({
        "summary": summary, "entities": list(entities),
        "key_developments": list(devs), "unresolved_events": list(unresolved),
    })


async def test_small_post_set_single_pass():
    client = _FakeClient([_ctx_json("one-pass summary", entities=["A"])])
    cfg = ContextConfig(chunk_size=10)
    builder = GrokContextBuilder(client=client, config=cfg)
    cand = CandidateTopic(topic_id="t", topic_name="x",
                          representative_posts=["p1", "p2", "p3"])
    ctx = await builder.build(cand)
    assert isinstance(ctx, TopicContext)
    assert ctx.summary == "one-pass summary"
    assert len(client.calls) == 1  # single pass


async def test_large_post_set_hierarchical_then_synthesize():
    # 25 posts, chunk_size 10 -> 3 chunk calls + 1 synthesis = 4 calls
    payloads = [
        _ctx_json("chunk1", devs=["d1"]),
        _ctx_json("chunk2", devs=["d2"]),
        _ctx_json("chunk3", devs=["d3"]),
        _ctx_json("final synthesis", entities=["A", "B"], devs=["d1", "d2", "d3"],
                  unresolved=["will X happen?"]),
    ]
    client = _FakeClient(payloads)
    cfg = ContextConfig(chunk_size=10, max_synthesis_inputs=8, max_grok_calls_per_topic=6)
    builder = GrokContextBuilder(client=client, config=cfg)
    cand = CandidateTopic(topic_id="t", topic_name="x",
                          representative_posts=[f"p{i}" for i in range(25)])
    ctx = await builder.build(cand)
    assert len(client.calls) == 4                      # 3 chunks + 1 synthesis
    assert ctx.summary == "final synthesis"            # synthesis output wins
    assert ctx.unresolved_events == ("will X happen?",)


async def test_grok_call_cap_is_respected():
    # cap = 3 -> at most 2 chunk calls then 1 synthesis
    payloads = [_ctx_json(f"c{i}") for i in range(10)]
    client = _FakeClient(payloads)
    cfg = ContextConfig(chunk_size=5, max_grok_calls_per_topic=3)
    builder = GrokContextBuilder(client=client, config=cfg)
    cand = CandidateTopic(topic_id="t", topic_name="x",
                          representative_posts=[f"p{i}" for i in range(40)])
    await builder.build(cand)
    assert len(client.calls) <= 3


async def test_recursive_reduce_tree_for_many_summaries():
    # chunk_size=2 over 8 posts -> 4 chunk summaries; max_synthesis_inputs=2 forces a
    # multi-level reduce tree: 4 -> (2 synth) -> 2 -> (1 synth) -> 1  = 4 map + 3 reduce = 7 calls.
    payloads = [_ctx_json(f"c{i}") for i in range(4)] + [
        _ctx_json("r1"), _ctx_json("r2"), _ctx_json("final"),
    ]
    client = _FakeClient(payloads)
    cfg = ContextConfig(chunk_size=2, max_synthesis_inputs=2, max_grok_calls_per_topic=20)
    builder = GrokContextBuilder(client=client, config=cfg)
    cand = CandidateTopic(topic_id="t", topic_name="x",
                          representative_posts=[f"p{i}" for i in range(8)])
    ctx = await builder.build(cand)
    assert len(client.calls) == 7        # genuine multi-level recursion, not a flat 2-level
    assert ctx.summary == "final"


async def test_reduce_falls_back_to_raw_merge_when_budget_exhausted():
    # Tiny budget: after chunk maps, no calls left -> reduce must merge without crashing.
    payloads = [_ctx_json("c0", entities=["A"]), _ctx_json("c1", entities=["B"])]
    client = _FakeClient(payloads)
    cfg = ContextConfig(chunk_size=1, max_synthesis_inputs=2, max_grok_calls_per_topic=2)
    builder = GrokContextBuilder(client=client, config=cfg)
    cand = CandidateTopic(topic_id="t", topic_name="x",
                          representative_posts=["p0", "p1"])
    ctx = await builder.build(cand)
    assert len(client.calls) == 2                 # both budget units spent on the map step
    assert set(ctx.entities) == {"A", "B"}        # raw merge combined the chunk outputs


async def test_empty_posts_degrades_without_calling_grok():
    client = _FakeClient([])
    builder = GrokContextBuilder(client=client, config=ContextConfig())
    ctx = await builder.build(CandidateTopic(topic_id="t", topic_name="Quiet Topic"))
    assert len(client.calls) == 0
    assert isinstance(ctx, TopicContext)
    assert "Quiet Topic" in ctx.summary


async def test_map_budget_exhaustion_keeps_remaining_posts_raw():
    client = _FakeClient([_ctx_json("c0", devs=["from-llm"])])
    cfg = ContextConfig(chunk_size=1, max_synthesis_inputs=2, max_grok_calls_per_topic=1)
    builder = GrokContextBuilder(client=client, config=cfg)
    cand = CandidateTopic(topic_id="t", topic_name="x",
                          representative_posts=["p0", "p1", "p2"])
    ctx = await builder.build(cand)
    assert len(client.calls) == 1
    assert "p1" in ctx.key_developments and "p2" in ctx.key_developments


def test_context_config_rejects_degenerate_values():
    import pytest
    with pytest.raises(ValueError):
        ContextConfig(max_synthesis_inputs=1)
    with pytest.raises(ValueError):
        ContextConfig(chunk_size=0)
    with pytest.raises(ValueError):
        ContextConfig(max_grok_calls_per_topic=0)
