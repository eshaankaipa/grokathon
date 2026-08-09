from types import SimpleNamespace

from classifier import (
    CandidateTopic,
    ClassifierConfig,
    MarketCandidateClassifier,
    SemanticFeatures,
)
from classifier.semantic.base import SemanticClassifier


class _SpySemantic(SemanticClassifier):
    def __init__(self, features):
        self.features = features
        self.received_context = "UNSET"

    async def classify(self, candidate, context=None):
        self.received_context = context
        return self.features


async def test_classifier_forwards_context_to_semantic():
    feats = SemanticFeatures(0.9, 0.9, 0.9, 0.1, 0.8, canonical_event="E")
    spy = _SpySemantic(feats)
    clf = MarketCandidateClassifier(semantic_classifier=spy, config=ClassifierConfig())
    ctx = SimpleNamespace(summary="ctx")  # duck-typed stand-in for TopicContext
    await clf.classify(CandidateTopic(topic_id="t", topic_name="x"), context=ctx)
    assert spy.received_context is ctx


async def test_classifier_works_without_context():
    feats = SemanticFeatures(0.9, 0.9, 0.9, 0.1, 0.8, canonical_event="E")
    spy = _SpySemantic(feats)
    clf = MarketCandidateClassifier(semantic_classifier=spy)
    await clf.classify(CandidateTopic(topic_id="t", topic_name="x"))
    assert spy.received_context is None
