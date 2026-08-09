from classifier import CandidateTopic
from context.base import ContextBuilder
from context.fake import FakeContextBuilder
from context.models import TopicContext


async def test_fake_returns_preset_by_topic_id():
    preset = TopicContext(summary="preset", entities=("A",))
    fake = FakeContextBuilder(by_topic_id={"t1": preset})
    got = await fake.build(CandidateTopic(topic_id="t1", topic_name="x"))
    assert got is preset


async def test_fake_derives_default_context_from_posts():
    fake = FakeContextBuilder()
    cand = CandidateTopic(topic_id="t2", topic_name="Warriors vs Lakers",
                          representative_posts=["p1", "p2", "p3", "p4"])
    got = await fake.build(cand)
    assert isinstance(got, TopicContext)
    assert "Warriors vs Lakers" in got.summary
    assert got.key_developments == ("p1", "p2", "p3")


def test_fake_is_a_context_builder():
    assert isinstance(FakeContextBuilder(), ContextBuilder)


def test_topic_context_is_frozen():
    import pytest
    ctx = TopicContext(summary="s")
    with pytest.raises(AttributeError):
        ctx.summary = "x"  # type: ignore[misc]
