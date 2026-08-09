"""Find date references in raw post text.

Used to tell an extracted resolution date that the posts actually support from
one the model supplied from its own priors.
"""

from __future__ import annotations

import re
from datetime import date, timedelta

MONTHS = {
    "jan": 1, "january": 1, "feb": 2, "february": 2, "mar": 3, "march": 3,
    "apr": 4, "april": 4, "may": 5, "jun": 6, "june": 6, "jul": 7, "july": 7,
    "aug": 8, "august": 8, "sep": 9, "sept": 9, "september": 9, "oct": 10,
    "october": 10, "nov": 11, "november": 11, "dec": 12, "december": 12,
}

_MONTH_ALT = "|".join(sorted(MONTHS, key=len, reverse=True))

# "August 8, 2026" / "Aug 8th" / "8 August 2026"
_MONTH_DAY = re.compile(
    rf"\b({_MONTH_ALT})\.?\s+(\d{{1,2}})(?:st|nd|rd|th)?(?:,?\s+(\d{{4}}))?\b", re.I
)
_DAY_MONTH = re.compile(
    rf"\b(\d{{1,2}})(?:st|nd|rd|th)?\s+({_MONTH_ALT})\.?(?:,?\s+(\d{{4}}))?\b", re.I
)
_ISO = re.compile(r"\b(\d{4})-(\d{2})-(\d{2})\b")
_SLASHED = re.compile(r"\b(\d{1,2})/(\d{1,2})/(\d{2,4})\b")

# Phrases that pin a date without naming one. The post is talking about *when*,
# so a date derived from it is grounded even though no literal date appears.
_RELATIVE = re.compile(
    r"\b(today|tonight|tomorrow|this (?:morning|afternoon|evening|weekend|week|month|season)|"
    r"next (?:week|month|season|year|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|"
    r"monday|tuesday|wednesday|thursday|friday|saturday|sunday|"
    r"in \d+ (?:days?|weeks?|months?)|kickoff|tip-?off|first pitch|puck drop|"
    r"doors open|game ?day|earnings call|before the bell|after the bell)\b",
    re.I,
)


def extract_dates(text: str, *, today: date) -> set[date]:
    """Every absolute date the text mentions.

    A bare "August 8" resolves to the next such date on or after `today`, which
    is how a reader would take it.
    """
    found: set[date] = set()

    for match in _ISO.finditer(text):
        _add(found, int(match.group(1)), int(match.group(2)), int(match.group(3)))

    for match in _SLASHED.finditer(text):
        month, day, year = (int(g) for g in match.groups())
        if year < 100:
            year += 2000
        _add(found, year, month, day)  # US ordering; X trend text is US-dominant

    for pattern, month_first in ((_MONTH_DAY, True), (_DAY_MONTH, False)):
        for match in pattern.finditer(text):
            raw_month = match.group(1) if month_first else match.group(2)
            raw_day = match.group(2) if month_first else match.group(1)
            month = MONTHS[raw_month.lower().rstrip(".")]
            day = int(raw_day)
            if year_text := match.group(3):
                _add(found, int(year_text), month, day)
            else:
                _add_next_occurrence(found, month, day, today)

    return found


def has_relative_reference(text: str) -> bool:
    return bool(_RELATIVE.search(text))


def _add(found: set[date], year: int, month: int, day: int) -> None:
    try:
        found.add(date(year, month, day))
    except ValueError:
        pass  # 31 February and friends


def _add_next_occurrence(found: set[date], month: int, day: int, today: date) -> None:
    for year in (today.year, today.year + 1):
        try:
            candidate = date(year, month, day)
        except ValueError:
            return
        if candidate >= today:
            found.add(candidate)
            return
    found.add(date(today.year, month, day))


def date_support(
    text: str, resolution_date: str | None, *, today: date, tolerance_days: int = 1
) -> str:
    """How well the text backs up `resolution_date`.

    explicit — the text names that date (within tolerance, for timezone slippage)
    relative — the text pins a time without naming a date ("tomorrow", "kickoff")
    mismatch — the text names dates, but not this one
    absent   — the text says nothing about when, so the date came from elsewhere
    """
    if not resolution_date:
        return "absent"
    try:
        target = date.fromisoformat(resolution_date)
    except ValueError:
        return "absent"

    mentioned = extract_dates(text, today=today)
    if any(abs((d - target).days) <= tolerance_days for d in mentioned):
        return "explicit"
    if has_relative_reference(text):
        return "relative"
    if mentioned:
        return "mismatch"
    return "absent"
