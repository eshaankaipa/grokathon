from classifier.models import CandidateTopic, SemanticFeatures
from classifier.semantic.base import SemanticClassifier
from classifier.semantic.grok import GrokSemanticClassifier, _to_features


def test_to_features_clamps_and_maps_empty_strings():
    data = {
        "eventness": 1.5, "resolvability": -0.2, "unresolvedness": 0.7,
        "subjectivity": "not-a-number", "specificity": 0.6,
        "canonical_event": "", "reasoning_summary": "because",
    }
    f = _to_features(data)
    assert f.eventness == 1.0
    assert f.resolvability == 0.0
    assert f.subjectivity == 0.0          # bad type coerced to 0.0
    assert f.canonical_event is None       # empty string -> None
    assert f.reasoning_summary == "because"


async def test_grok_uses_injected_client_and_parses_response():
    class _Msg:
        content = (
            '{"eventness":0.9,"resolvability":0.9,"unresolvedness":0.9,'
            '"subjectivity":0.1,"specificity":0.8,'
            '"canonical_event":"Some Event 2026","reasoning_summary":"ok"}'
        )

    class _Choice:
        message = _Msg()

    class _Resp:
        choices = [_Choice()]

    class _Completions:
        async def create(self, **kwargs):
            # assert we ask for deterministic, schema-constrained output
            assert kwargs["temperature"] == 0
            assert kwargs["response_format"]["type"] == "json_schema"
            return _Resp()

    class _Chat:
        completions = _Completions()

    class _FakeClient:
        chat = _Chat()

    grok = GrokSemanticClassifier(client=_FakeClient())
    assert isinstance(grok, SemanticClassifier)
    got = await grok.classify(CandidateTopic(topic_id="t", topic_name="x",
                                             representative_posts=["a", "b"]))
    assert isinstance(got, SemanticFeatures)
    assert got.eventness == 0.9
    assert got.canonical_event == "Some Event 2026"


import os

import pytest


@pytest.mark.skipif(
    not (os.environ.get("XAI_API_KEY") or os.environ.get("GROK_API_KEY")),
    reason="no XAI_API_KEY/GROK_API_KEY in env — skipping live Grok call",
)
async def test_grok_live_smoke():
    # Opt-in: only runs when a key is exported (e.g. `set -a; source .env`) and
    # `pip install -e ".[grok]"` has been done. Makes one real, billable call.
    from classifier.semantic.grok import GrokSemanticClassifier

    grok = GrokSemanticClassifier()
    feats = await grok.classify(
        CandidateTopic(
            topic_id="live",
            topic_name="Warriors vs Lakers game tonight",
            representative_posts=["warriors lakers tonight", "steph vs lebron"],
        )
    )
    for v in (feats.eventness, feats.resolvability, feats.unresolvedness,
              feats.subjectivity, feats.specificity):
        assert 0.0 <= v <= 1.0
    # A concrete scheduled game should read as eventful and resolvable.
    assert feats.eventness > 0.5
    assert feats.resolvability > 0.5
