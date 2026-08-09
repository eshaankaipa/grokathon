from classifier.models import CandidateTopic, NumericFeatures, SemanticFeatures
from classifier.scoring import build_query, marketability_score


def _strong_numeric():
    return NumericFeatures(attention=0.7, velocity=0.8, engagement=0.7,
                           diversity=0.6, freshness=0.7)


def test_score_in_unit_range():
    s = marketability_score(_strong_numeric(),
                            SemanticFeatures(0.9, 0.95, 0.9, 0.1, 0.85))
    assert 0.0 <= s <= 1.0
    assert s > 0.6


def test_subjectivity_penalizes_score():
    numeric = _strong_numeric()
    low_subj = marketability_score(numeric, SemanticFeatures(0.9, 0.9, 0.9, 0.0, 0.8))
    high_subj = marketability_score(numeric, SemanticFeatures(0.9, 0.9, 0.9, 1.0, 0.8))
    assert low_subj > high_subj


def test_build_query_strips_stopwords_and_punctuation():
    s = SemanticFeatures(0.9, 0.9, 0.9, 0.1, 0.9,
                         canonical_event="Golden State Warriors vs Los Angeles Lakers, Aug 8 2026")
    q = build_query(s, CandidateTopic(topic_id="t", topic_name="ignored"))
    assert q == "Golden State Warriors Los Angeles Lakers Aug 8 2026"
    assert "?" not in q and "vs" not in q.split()


def test_build_query_falls_back_to_topic_name():
    s = SemanticFeatures(0.9, 0.9, 0.9, 0.1, 0.9, canonical_event=None)
    q = build_query(s, CandidateTopic(topic_id="t", topic_name="Fed rate decision"))
    assert q == "Fed rate decision"
