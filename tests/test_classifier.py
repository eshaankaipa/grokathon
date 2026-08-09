from classifier import (
    CandidateTopic,
    ClassifierConfig,
    FakeSemanticClassifier,
    MarketCandidateClassifier,
    SemanticFeatures,
)


def _make(topic_id, semantic, **candidate_kwargs):
    fake = FakeSemanticClassifier(features_by_topic_id={topic_id: semantic})
    clf = MarketCandidateClassifier(semantic_classifier=fake, config=ClassifierConfig())
    cand = CandidateTopic(topic_id=topic_id, **candidate_kwargs)
    return clf, cand


async def test_create_warriors_vs_lakers_tonight():
    semantic = SemanticFeatures(eventness=0.9, resolvability=0.95, unresolvedness=0.9,
                                subjectivity=0.1, specificity=0.85,
                                canonical_event="Golden State Warriors vs Los Angeles Lakers, Aug 8 2026")
    clf, cand = _make(
        "warriors_lakers", semantic,
        topic_name="Warriors vs Lakers game tonight",
        representative_posts=["warriors lakers tonight", "huge game"],
        post_count=8000, unique_author_count=5000, engagement_count=60000,
        volume_velocity=250, volume_growth=2.5, topic_age_minutes=120,
    )
    result = await clf.classify(cand)
    assert result.decision == "CREATE"
    assert result.query and "?" not in result.query
    assert result.canonical_event == semantic.canonical_event


async def test_reject_subjective_opinion():
    semantic = SemanticFeatures(eventness=0.15, resolvability=0.1, unresolvedness=0.8,
                                subjectivity=0.95, specificity=0.3)
    clf, cand = _make(
        "goat", semantic,
        topic_name="Steph Curry is the GOAT",
        post_count=50000, engagement_count=900000, volume_velocity=800,
    )
    result = await clf.classify(cand)
    assert result.decision == "REJECT"
    assert any("eventness" in r for r in result.reasons)


async def test_reject_already_resolved():
    semantic = SemanticFeatures(eventness=0.9, resolvability=0.95, unresolvedness=0.05,
                                subjectivity=0.1, specificity=0.9)
    clf, cand = _make(
        "final_score", semantic,
        topic_name="Warriors defeated Lakers 118-109",
        post_count=40000, engagement_count=500000, volume_velocity=600,
    )
    result = await clf.classify(cand)
    assert result.decision == "REJECT"
    assert any("unresolvedness" in r for r in result.reasons)


async def test_wait_low_specificity():
    semantic = SemanticFeatures(eventness=0.55, resolvability=0.55, unresolvedness=0.9,
                                subjectivity=0.3, specificity=0.2)
    clf, cand = _make(
        "openai_cooking", semantic,
        topic_name="OpenAI is cooking something huge",
        post_count=3000, engagement_count=40000,
        volume_velocity=180, volume_growth=2.8, topic_age_minutes=60,
    )
    result = await clf.classify(cand)
    assert result.decision == "WAIT"
    assert any("specificity" in r for r in result.reasons)


async def test_create_despite_informal_language():
    semantic = SemanticFeatures(eventness=0.85, resolvability=0.9, unresolvedness=0.9,
                                subjectivity=0.25, specificity=0.75,
                                canonical_event="Stephen Curry scoring 40+ points in an upcoming game")
    clf, cand = _make(
        "curry_40", semantic,
        topic_name="curry going crazy tonight",
        representative_posts=["steph dropping 40 tonight", "40 piece incoming",
                              "curry going crazy tonight"],
        post_count=7000, unique_author_count=4000, engagement_count=70000,
        volume_velocity=220, volume_growth=2.0, topic_age_minutes=90,
    )
    result = await clf.classify(cand)
    assert result.decision == "CREATE"
    assert result.query


async def test_wait_when_score_high_but_specificity_low():
    # Isolates the specificity gate: the score alone clears create_threshold,
    # but low specificity must still downgrade CREATE -> WAIT.
    semantic = SemanticFeatures(eventness=0.9, resolvability=0.9, unresolvedness=0.9,
                                subjectivity=0.1, specificity=0.3)
    clf, cand = _make(
        "high_score_low_spec", semantic,
        topic_name="something huge is definitely happening",
        post_count=100000, unique_author_count=60000, engagement_count=500000,
        volume_velocity=1000, volume_growth=5.0, topic_age_minutes=30,
    )
    result = await clf.classify(cand)
    assert result.score >= ClassifierConfig().create_threshold  # score alone would qualify
    assert result.decision == "WAIT"
    assert result.query is None
    assert any("specificity" in r for r in result.reasons)


async def test_missing_features_do_not_raise():
    semantic = SemanticFeatures(0.9, 0.9, 0.9, 0.1, 0.8, canonical_event="Some event")
    clf, cand = _make("bare", semantic, topic_name="bare topic")  # no numeric fields
    result = await clf.classify(cand)
    # strong semantics but zero activity signal -> not enough to CREATE -> WAIT
    assert result.decision == "WAIT"
    assert any("missing X features" in r for r in result.reasons)
