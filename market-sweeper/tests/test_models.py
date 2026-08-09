import pytest

from classifier.models import (
    CandidateTopic,
    NumericFeatures,
    SemanticFeatures,
    clamp01,
)


def test_clamp01_bounds():
    assert clamp01(-0.5) == 0.0
    assert clamp01(1.7) == 1.0
    assert clamp01(0.42) == 0.42


def test_candidate_optional_fields_default_none():
    c = CandidateTopic(topic_id="t1", topic_name="Warriors vs Lakers")
    assert c.post_count is None
    assert c.representative_posts == []
    assert c.metadata == {}


def test_semantic_features_clamped():
    s = SemanticFeatures(eventness=1.4, resolvability=-0.2, unresolvedness=0.9,
                         subjectivity=0.1, specificity=0.5)
    assert s.eventness == 1.0
    assert s.resolvability == 0.0
    assert s.unresolvedness == 0.9


def test_numeric_features_clamped():
    n = NumericFeatures(attention=2.0, velocity=-1.0, engagement=0.3,
                        diversity=0.5, freshness=0.8)
    assert n.attention == 1.0
    assert n.velocity == 0.0


def test_models_are_frozen():
    c = CandidateTopic(topic_id="t1", topic_name="x")
    with pytest.raises(AttributeError):
        c.topic_id = "t2"  # type: ignore[misc]
