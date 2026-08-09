import pytest

from classifier.models import CandidateTopic, SemanticFeatures
from classifier.semantic.base import SemanticClassifier
from classifier.semantic.fake import FakeSemanticClassifier


async def test_fake_returns_preset_by_topic_id():
    preset = SemanticFeatures(0.9, 0.9, 0.9, 0.1, 0.8, canonical_event="E")
    fake = FakeSemanticClassifier(features_by_topic_id={"t1": preset})
    got = await fake.classify(CandidateTopic(topic_id="t1", topic_name="x"))
    assert got is preset


async def test_fake_returns_default_when_unknown():
    default = SemanticFeatures(0.4, 0.4, 0.4, 0.5, 0.3)
    fake = FakeSemanticClassifier(default=default)
    got = await fake.classify(CandidateTopic(topic_id="unknown", topic_name="x"))
    assert got is default


def test_fake_is_a_semantic_classifier():
    assert isinstance(FakeSemanticClassifier(), SemanticClassifier)


def test_base_cannot_be_instantiated():
    with pytest.raises(TypeError):
        SemanticClassifier()  # type: ignore[abstract]
