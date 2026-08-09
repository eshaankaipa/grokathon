from classifier.config import ClassifierConfig


def test_defaults_present_and_ordered():
    cfg = ClassifierConfig()
    # thresholds must be strictly ordered
    assert 0.0 < cfg.wait_threshold < cfg.create_threshold <= 1.0
    # positive scoring weights sum to 1.0 (keeps the normalized score intuitive)
    positive = (cfg.attention_weight + cfg.velocity_weight + cfg.engagement_weight
                + cfg.eventness_weight + cfg.resolvability_weight
                + cfg.unresolvedness_weight + cfg.specificity_weight)
    assert abs(positive - 1.0) < 1e-9


def test_config_is_overridable():
    cfg = ClassifierConfig(create_threshold=0.8)
    assert cfg.create_threshold == 0.8
    assert ClassifierConfig().create_threshold != 0.8  # default untouched
