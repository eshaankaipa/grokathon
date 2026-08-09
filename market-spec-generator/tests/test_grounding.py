from __future__ import annotations

from datetime import date

import pytest

from app.dates import date_support, extract_dates, has_relative_reference
from app.grounding import Grounder
from app.llm import LLMError
from app.models import Classification, Decision, Tweet, TweetCluster
from tests.conftest import RoutingLLM

TODAY = date(2026, 8, 8)


# -- date extraction -------------------------------------------------------- #


@pytest.mark.parametrize("text,expected", [
    ("Lakers at Warriors on August 8, 2026", date(2026, 8, 8)),
    ("Tip-off Aug 8 2026", date(2026, 8, 8)),
    ("game is 8/8/2026", date(2026, 8, 8)),
    ("scheduled 2026-08-08", date(2026, 8, 8)),
    ("on August 8th", date(2026, 8, 8)),
    ("8 August 2026 at Chase Center", date(2026, 8, 8)),
    ("Super Bowl LXI on February 7, 2027", date(2027, 2, 7)),
])
def test_extract_dates_finds_common_formats(text, expected):
    assert expected in extract_dates(text, today=TODAY)


def test_bare_month_day_resolves_to_the_next_occurrence():
    # Today is Aug 8 2026, so "February 7" means 2027.
    assert date(2027, 2, 7) in extract_dates("the game is February 7", today=TODAY)


def test_invalid_dates_are_ignored():
    assert extract_dates("February 31, 2026 is not a day", today=TODAY) == set()


def test_unrelated_numbers_are_not_dates():
    assert extract_dates("Curry scored 30 points on 12 shots", today=TODAY) == set()


@pytest.mark.parametrize("text", ["tip-off is tomorrow", "game tonight", "next Friday",
                                  "kickoff at 4", "in 3 days", "earnings call this week"])
def test_relative_references_are_detected(text):
    assert has_relative_reference(text)


def test_plain_statement_has_no_relative_reference():
    assert not has_relative_reference("The Warriors are a good basketball team")


# -- support classification -------------------------------------------------- #


def test_explicit_support():
    assert date_support("Lakers at Warriors August 8, 2026", "2026-08-08", today=TODAY) == "explicit"


def test_timezone_slippage_is_tolerated():
    assert date_support("game on August 9 2026", "2026-08-08", today=TODAY) == "explicit"


def test_relative_support():
    assert date_support("Lakers at Warriors tomorrow!", "2026-08-09", today=TODAY) == "relative"


def test_mismatch_when_posts_name_another_date():
    assert date_support("the game is September 20, 2026", "2026-08-08", today=TODAY) == "mismatch"


def test_absent_when_posts_say_nothing_about_when():
    assert date_support("Warriors and Lakers are both good", "2026-08-08", today=TODAY) == "absent"


def test_no_date_proposed_is_absent():
    assert date_support("anything", None, today=TODAY) == "absent"


# -- Grounder --------------------------------------------------------------- #


def cluster(*texts: str) -> TweetCluster:
    return TweetCluster(tweets=[Tweet(id=str(i), text=t) for i, t in enumerate(texts)])


def proposal(date_str: str | None = "2026-08-08") -> Classification:
    return Classification(
        decision=Decision.CREATE, event="Warriors vs Lakers", query="warriors lakers",
        category="sports", entities=["Warriors", "Lakers"], resolution_date=date_str,
    )


async def test_explicit_date_skips_the_llm():
    llm = RoutingLLM()  # raises if called
    g = await Grounder(llm).check(proposal(), cluster("Lakers at Warriors on August 8, 2026"))

    assert g.supported and g.date_support == "explicit"
    assert llm.calls == []


async def test_relative_date_skips_the_llm():
    llm = RoutingLLM()
    g = await Grounder(llm).check(proposal("2026-08-09"), cluster("Lakers at Warriors tomorrow"))

    assert g.supported and g.date_support == "relative"
    assert llm.calls == []


async def test_absent_date_escalates_to_the_evidence_check():
    llm = RoutingLLM(ground={"supported": False, "confidence": 0.9,
                             "issues": ["No post mentions a date."],
                             "reason": "The date is not supported by the posts."})
    g = await Grounder(llm).check(proposal(), cluster("Warriors and Lakers are both good"))

    assert g.supported is False
    assert g.date_support == "absent"
    assert g.issues
    assert len(llm.calls) == 1


async def test_evidence_check_can_rescue_public_knowledge():
    llm = RoutingLLM(ground={"supported": True, "confidence": 0.95,
                             "evidence": "\"Super Bowl LXI\"",
                             "reason": "Super Bowl LXI has a fixed, publicly known date."})
    g = await Grounder(llm).check(proposal("2027-02-07"), cluster("Super Bowl LXI is going to be wild"))

    assert g.supported is True


async def test_low_confidence_support_is_rejected():
    llm = RoutingLLM(ground={"supported": True, "confidence": 0.2, "reason": "maybe"})
    g = await Grounder(llm).check(proposal(), cluster("no dates here at all"))

    assert g.supported is False, "a hedged yes is not support"


async def test_mismatched_date_escalates():
    llm = RoutingLLM(ground={"supported": False, "confidence": 0.9,
                             "reason": "Posts reference September 20, not August 8."})
    g = await Grounder(llm).check(proposal(), cluster("the game is September 20, 2026"))

    assert g.date_support == "mismatch"
    assert g.supported is False


class BrokenLLM:
    async def json(self, *, system: str, user: str, temperature: float = 0.1):
        raise LLMError("upstream exploded")


async def test_llm_failure_fails_closed_when_strict():
    """This guard exists to block unfounded markets; losing it must not open the gate."""
    g = await Grounder(BrokenLLM(), strict=True).check(proposal(), cluster("nothing about dates"))

    assert g.supported is False
    assert any("failed" in i.lower() for i in g.issues)


async def test_llm_failure_fails_open_when_not_strict():
    g = await Grounder(BrokenLLM(), strict=False).check(proposal(), cluster("nothing about dates"))
    assert g.supported is True


async def test_non_strict_mode_lets_it_through():
    g = await Grounder(None, strict=False).check(proposal(), cluster("nothing about dates"))
    assert g.supported is True


async def test_no_llm_and_strict_blocks():
    g = await Grounder(None, strict=True).check(proposal(), cluster("nothing about dates"))
    assert g.supported is False
    assert g.issues
