from classifier.config import ClassifierConfig
from classifier.models import CandidateTopic
from classifier.numeric_features import extract_numeric_features


def test_missing_fields_use_missing_value():
    cfg = ClassifierConfig(missing_feature_value=0.0)
    n = extract_numeric_features(CandidateTopic(topic_id="t", topic_name="x"), cfg)
    assert n.attention == 0.0
    assert n.velocity == 0.0
    assert n.engagement == 0.0
    assert n.diversity == 0.0
    assert n.freshness == 0.0


def test_saturation_is_monotonic_and_bounded():
    cfg = ClassifierConfig()
    low = extract_numeric_features(
        CandidateTopic(topic_id="t", topic_name="x", post_count=100), cfg)
    high = extract_numeric_features(
        CandidateTopic(topic_id="t", topic_name="x", post_count=100_000), cfg)
    assert 0.0 <= low.attention < high.attention <= 1.0


def test_diversity_is_author_ratio_when_post_count_present():
    cfg = ClassifierConfig()
    n = extract_numeric_features(
        CandidateTopic(topic_id="t", topic_name="x",
                       post_count=100, unique_author_count=80), cfg)
    assert abs(n.diversity - 0.8) < 1e-9


def test_freshness_decays_with_age():
    cfg = ClassifierConfig()
    young = extract_numeric_features(
        CandidateTopic(topic_id="t", topic_name="x", topic_age_minutes=10), cfg)
    old = extract_numeric_features(
        CandidateTopic(topic_id="t", topic_name="x", topic_age_minutes=5000), cfg)
    assert young.freshness > old.freshness


def test_velocity_blends_velocity_and_growth():
    cfg = ClassifierConfig()
    vel_only = extract_numeric_features(
        CandidateTopic(topic_id="t", topic_name="x", volume_velocity=200), cfg)
    vel_and_growth = extract_numeric_features(
        CandidateTopic(topic_id="t", topic_name="x",
                       volume_velocity=200, volume_growth=3.0), cfg)
    assert 0.0 < vel_only.velocity <= 1.0
    assert 0.0 < vel_and_growth.velocity <= 1.0


def test_freshness_nonpositive_halflife_is_safe():
    from classifier.config import ClassifierConfig
    cfg = ClassifierConfig(freshness_halflife_minutes=0.0, missing_feature_value=0.0)
    n = extract_numeric_features(
        CandidateTopic(topic_id="t", topic_name="x", topic_age_minutes=10), cfg)
    assert n.freshness == 0.0
