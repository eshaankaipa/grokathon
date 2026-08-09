from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from app.models import Classification, Decision, EventSpec, MarketSpec, Tweet, TweetCluster
from app.question import QuestionGenerator
from app.spec_validation import (
    MarketSpecValidationError,
    is_valid,
    validate_market_spec,
)
from tests.conftest import RoutingLLM

NOW = datetime(2026, 8, 9, 12, 0, tzinfo=timezone.utc)
FUTURE = NOW + timedelta(days=30)

GOOD_CRITERIA = (
    "Resolve YES if official NBA records list the Golden State Warriors as the winner "
    "of the scheduled game. Resolve NO if official NBA records list the Los Angeles "
    "Lakers as the winner. If the game is permanently cancelled and not replayed, "
    "resolve VOID."
)


def spec(**overrides) -> MarketSpec:
    base = dict(
        question="Will the Golden State Warriors defeat the Los Angeles Lakers on August 8, 2026?",
        outcomes=["YES", "NO"],
        closes_at=None,
        resolution_date=FUTURE.date(),
        resolution_criteria=GOOD_CRITERIA,
        resolution_sources=["Official NBA game results"],
        category="sports",
        canonical_event="Golden State Warriors vs Los Angeles Lakers on August 8, 2026",
        source_query="Warriors Lakers August 8 2026",
    )
    base.update(overrides)
    return MarketSpec(**base)


def codes(s: MarketSpec) -> set[str]:
    return {i.code for i in validate_market_spec(s, now=NOW)}


# --------------------------------------------------------------------------- #
# Validator
# --------------------------------------------------------------------------- #


def test_a_good_spec_is_valid():
    assert validate_market_spec(spec(), now=NOW) == []


def test_subjective_question_rejected():
    issues = validate_market_spec(
        spec(question="Will GPT-6 be amazing?", canonical_event="GPT-6 release"), now=NOW
    )
    assert "subjective" in {i.code for i in issues}
    assert not is_valid(issues)


def test_subjective_term_allowed_when_criteria_quantify_it():
    s = spec(
        question="Will NVIDIA report a successful quarter on November 18, 2026?",
        canonical_event="NVIDIA Q3 earnings",
        resolution_criteria=(
            "Resolve YES if NVIDIA reports a successful quarter, defined as revenue "
            "above 45000 million USD. Resolve NO if reported revenue is at or below "
            "45000 million USD. If the earnings call is cancelled, resolve VOID."
        ),
    )
    assert "subjective" not in codes(s)


def test_question_must_end_with_a_question_mark():
    assert "not_a_question" in codes(spec(question="Will the Warriors win on August 8, 2026"))


def test_question_must_be_predictive():
    assert "not_predictive" in codes(spec(question="The Golden State Warriors game on August 8?"))


def test_excessively_long_question_rejected():
    assert "too_long" in codes(spec(question="Will the Golden State Warriors " + "really " * 40 + "win?"))


def test_missing_no_definition_rejected():
    issues = validate_market_spec(
        spec(resolution_criteria="Resolve YES if the Warriors win per official NBA records."),
        now=NOW,
    )
    assert "outcome_undefined" in {i.code for i in issues}
    assert not is_valid(issues)


def test_cancellation_resolving_no_is_rejected():
    issues = validate_market_spec(spec(resolution_criteria=(
        "Resolve YES if the Warriors win. Resolve NO if the Lakers win. "
        "If the game is canceled, resolve NO."
    )), now=NOW)
    assert "cancellation_as_no" in {i.code for i in issues}
    assert not is_valid(issues)


def test_postponement_to_void_is_accepted():
    assert "cancellation_as_no" not in codes(spec(resolution_criteria=(
        "Resolve YES if the Warriors win. Resolve NO if the Lakers win. "
        "If the game is postponed beyond the settlement window, resolve VOID."
    )))


def test_void_is_not_a_tradeable_outcome():
    assert "void_not_tradeable" in codes(spec(outcomes=["YES", "NO", "VOID"]))


def test_too_few_outcomes_rejected():
    assert "too_few" in codes(spec(outcomes=["YES"]))


def test_duplicate_outcomes_rejected():
    assert "duplicates" in codes(spec(outcomes=["YES", "yes"]))


def test_fabricated_url_rejected():
    issues = validate_market_spec(
        spec(resolution_sources=["https://nba.com/games/2026/08/08/box-score"]), now=NOW
    )
    assert "fabricated_url" in {i.code for i in issues}
    assert not is_valid(issues)


def test_missing_sources_rejected():
    assert "missing" in codes(spec(resolution_sources=[]))


def test_non_authoritative_source_is_a_warning_not_an_error():
    issues = validate_market_spec(spec(resolution_sources=["some guy on X"]), now=NOW)
    assert {i.code for i in issues} == {"not_authoritative"}
    assert is_valid(issues), "a weak source description should warn, not block"


def test_past_close_time_rejected():
    issues = validate_market_spec(spec(closes_at=NOW - timedelta(days=1)), now=NOW)
    assert "in_the_past" in {i.code for i in issues}
    assert not is_valid(issues)


def test_close_after_resolution_rejected():
    assert "after_resolution" in codes(spec(closes_at=FUTURE + timedelta(days=2)))


def test_null_close_time_is_allowed():
    assert validate_market_spec(spec(closes_at=None), now=NOW) == []


def test_close_time_within_the_resolution_day_is_allowed():
    assert validate_market_spec(
        spec(closes_at=datetime.combine(FUTURE.date(), datetime.min.time(), tzinfo=timezone.utc)
             + timedelta(hours=19)),
        now=NOW,
    ) == []


def test_empty_canonical_event_rejected():
    assert "empty" in codes(spec(canonical_event=""))


def test_question_unrelated_to_the_event_rejected():
    assert "not_represented" in codes(
        spec(question="Will Bitcoin close above 150000 dollars on December 31, 2026?")
    )


# --------------------------------------------------------------------------- #
# Generator
# --------------------------------------------------------------------------- #


SPORTS_EVENT = EventSpec(
    canonical_event="Golden State Warriors vs Los Angeles Lakers on August 8, 2026",
    query="Golden State Warriors Los Angeles Lakers August 8 2026",
    category="sports",
    context_summary="Conversation centers on the Warriors-Lakers game.",
    entities=["Golden State Warriors", "Los Angeles Lakers"],
    key_developments=["The game is scheduled for August 8, 2026"],
    unresolved_events=["game winner"],
)

DRAFT = {
    "question": "Will the Golden State Warriors defeat the Los Angeles Lakers on August 8, 2026?",
    "outcomes": ["YES", "NO"],
    "closes_at": None,
    "resolution_date": FUTURE.date().isoformat(),
    "resolution_criteria": GOOD_CRITERIA,
    "resolution_sources": ["Official NBA game results"],
    "category": "sports",
    "canonical_event": "Golden State Warriors vs Los Angeles Lakers on August 8, 2026",
}


async def test_generates_a_valid_sports_spec():
    result = await QuestionGenerator(RoutingLLM(question=DRAFT)).generate(SPORTS_EVENT)

    assert result.outcomes == ["YES", "NO"]
    assert result.canonical_event == SPORTS_EVENT.canonical_event
    assert result.source_query == SPORTS_EVENT.query
    assert result.category == "sports"
    assert result.resolution_sources == ["Official NBA game results"]
    assert validate_market_spec(result, now=NOW) == []


async def test_product_release_keeps_deadline_and_invents_no_timestamp():
    event = EventSpec(
        canonical_event="OpenAI GPT-6 public release before September 30, 2026",
        category="technology", entities=["OpenAI"],
    )
    draft = {
        "question": "Will OpenAI publicly release GPT-6 before September 30, 2026?",
        "outcomes": ["YES", "NO"],
        # A bare date is not a closing *time* — it must not become midnight.
        "closes_at": "2026-09-30",
        "resolution_date": "2026-09-30",
        "resolution_criteria": (
            "Resolve YES if OpenAI makes GPT-6 generally available to the public before "
            "September 30, 2026, per an official company announcement. Resolve NO if no "
            "such release has occurred by that date. If OpenAI is dissolved before the "
            "deadline, resolve VOID."
        ),
        "resolution_sources": ["Official OpenAI company announcement"],
    }
    result = await QuestionGenerator(RoutingLLM(question=draft)).generate(event)

    assert result.closes_at is None, "a bare date must not be inflated into a timestamp"
    assert result.resolution_date.isoformat() == "2026-09-30"
    assert result.category == "technology"


async def test_upstream_category_is_not_reclassified():
    draft = {**DRAFT, "category": "entertainment"}
    result = await QuestionGenerator(RoutingLLM(question=draft)).generate(SPORTS_EVENT)
    assert result.category == "sports", "a trusted upstream category wins"


async def test_legacy_single_resolution_source_is_accepted():
    draft = {k: v for k, v in DRAFT.items() if k != "resolution_sources"}
    draft["resolution_source"] = "Official NBA game results"
    result = await QuestionGenerator(RoutingLLM(question=draft)).generate(SPORTS_EVENT)
    assert result.resolution_sources == ["Official NBA game results"]


async def test_missing_outcomes_default_to_binary():
    draft = {k: v for k, v in DRAFT.items() if k != "outcomes"}
    result = await QuestionGenerator(RoutingLLM(question=draft)).generate(SPORTS_EVENT)
    assert result.outcomes == ["YES", "NO"]


async def test_invalid_draft_triggers_one_repair_then_succeeds():
    bad = {**DRAFT, "resolution_criteria":
           "Resolve YES if the Warriors win. If the game is canceled, resolve NO."}

    class RepairingLLM(RoutingLLM):
        def __init__(self):
            super().__init__(question=bad)
            self.n = 0

        async def json(self, *, system, user, temperature=0.1):
            self.n += 1
            return bad if self.n == 1 else DRAFT

    llm = RepairingLLM()
    result = await QuestionGenerator(llm).generate(SPORTS_EVENT)

    assert llm.n == 2, "exactly one repair pass"
    assert validate_market_spec(result, now=NOW) == []


async def test_repair_failure_raises_with_the_issues():
    bad = {**DRAFT, "question": "Will GPT-6 be amazing?"}
    llm = RoutingLLM(question=bad)

    with pytest.raises(MarketSpecValidationError) as exc:
        await QuestionGenerator(llm).generate(SPORTS_EVENT)

    assert any(i.code == "subjective" for i in exc.value.issues)


async def test_repair_can_be_disabled():
    bad = {**DRAFT, "resolution_sources": []}
    with pytest.raises(MarketSpecValidationError):
        await QuestionGenerator(RoutingLLM(question=bad), repair=False).generate(SPORTS_EVENT)


# --------------------------------------------------------------------------- #
# Boundary + backward compatibility
# --------------------------------------------------------------------------- #


def test_event_spec_round_trips_through_json():
    payload = SPORTS_EVENT.model_dump(mode="json")
    assert EventSpec.model_validate(payload) == SPORTS_EVENT


def test_market_spec_round_trips_through_json():
    s = spec(closes_at=FUTURE)
    assert MarketSpec.model_validate(s.model_dump(mode="json")) == s


def test_market_spec_json_has_no_repo_internals():
    keys = set(spec().model_dump(mode="json"))
    assert keys == {
        "question", "outcomes", "closes_at", "resolution_date", "resolution_criteria",
        "resolution_sources", "category", "canonical_event", "source_query",
    }


def test_adapter_maps_classification_without_leaking_tweets():
    classification = Classification(
        decision=Decision.CREATE, event="Warriors vs Lakers", query="warriors lakers",
        category="sports", entities=["Golden State Warriors"], resolution_date="2026-08-08",
    )
    cluster = TweetCluster(tweets=[Tweet(id="1", text="Lakers at Warriors", likes=10)])

    event = EventSpec.from_classification(classification, cluster)

    assert event.canonical_event == "Warriors vs Lakers"
    assert event.category == "sports"
    assert "Lakers at Warriors" in event.context_summary
    assert isinstance(event.context_summary, str), "tweets must be flattened, not passed through"
    assert any("2026-08-08" in d for d in event.key_developments)


async def test_generator_still_accepts_a_classification():
    """Backward compatibility for in-repo callers holding a Classification."""
    classification = Classification(
        decision=Decision.CREATE,
        event="Golden State Warriors vs Los Angeles Lakers on August 8, 2026",
        query="warriors lakers", category="sports",
        entities=["Golden State Warriors", "Los Angeles Lakers"],
        resolution_date=FUTURE.date().isoformat(),
    )
    result = await QuestionGenerator(RoutingLLM(question=DRAFT)).generate(classification)
    assert result.canonical_event == classification.event
