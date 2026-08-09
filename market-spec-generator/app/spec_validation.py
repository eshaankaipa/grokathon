"""Deterministic validation of a generated MarketSpec.

The LLM proposes the draft; this decides whether the draft is acceptable. Every
check here is plain code — no model calls — so the same spec always gets the same
verdict, and a prompt regression shows up as a failed validation rather than a
badly-worded market that someone bets money on.

Mirrors the idiom already used in `Classifier` (deterministic guards overriding
the model) and `Grounder` (a text scan before any LLM call).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date, datetime, time, timezone

from .models import MarketSpec

MAX_QUESTION_CHARS = 200

# Terms whose truth depends on the reader. Allowed only when the criteria pin
# them to something countable.
SUBJECTIVE_TERMS = frozenset({
    "amazing", "awesome", "incredible", "impressive", "successful", "success",
    "great", "terrible", "awful", "best", "worst", "good", "bad", "crush",
    "crushes", "dominate", "dominant", "huge", "massive", "popular", "overrated",
    "underrated", "beautiful", "disappointing", "insane", "epic", "legendary",
    "iconic", "stunning", "embarrassing", "disaster", "flop", "hyped",
})

# Words suggesting the source is an authority rather than a guess.
AUTHORITATIVE_HINTS = (
    "official", "sec ", "filing", "government", "commission", "authority",
    "league", "federal", "court", "registry", "exchange", "regulator",
    "announcement", "press release", "gazette", "bureau", "ministry",
    "certified", "board of", "returns",
)

_URL = re.compile(r"https?://|\bwww\.|\b[a-z0-9-]+\.(?:com|org|net|gov|io|co|edu)/", re.I)
_SENTENCE = re.compile(r"(?<=[.!?])\s+")
_CANCEL = re.compile(r"\b(cancel|canceled|cancelled|cancellation|postpon\w*|abandon\w*|"
                     r"called off|not (?:be )?played|no[- ]contest|suspended)\b", re.I)
_WORD = re.compile(r"[a-z0-9']+")

STOPWORDS = frozenset({
    "will", "the", "a", "an", "of", "on", "in", "at", "to", "for", "and", "or",
    "vs", "versus", "be", "is", "are", "by", "with", "before", "after", "than",
    "that", "this", "it", "its", "as", "from", "into", "over", "under",
})


@dataclass(frozen=True)
class ValidationIssue:
    field: str
    code: str
    message: str
    severity: str = "error"

    def __str__(self) -> str:
        return f"[{self.severity}] {self.field}.{self.code}: {self.message}"


class MarketSpecValidationError(ValueError):
    """Raised when a spec fails validation. Carries every issue, not just the first."""

    def __init__(self, issues: list[ValidationIssue]) -> None:
        self.issues = issues
        super().__init__("; ".join(str(i) for i in issues) or "invalid market spec")

    @property
    def errors(self) -> list[ValidationIssue]:
        return [i for i in self.issues if i.severity == "error"]


def validate_market_spec(
    spec: MarketSpec, *, now: datetime | None = None
) -> list[ValidationIssue]:
    """Every problem found, worst-case-first. An empty list means the spec is usable.

    Warnings are reported but do not make a spec invalid — see `is_valid`.
    """
    now = now or datetime.now(timezone.utc)
    issues: list[ValidationIssue] = []

    issues += _check_question(spec)
    issues += _check_outcomes(spec)
    issues += _check_criteria(spec)
    issues += _check_resolution_date(spec)
    issues += _check_closing_time(spec, now)
    issues += _check_sources(spec)
    issues += _check_canonical_event(spec)
    return issues


def is_valid(issues: list[ValidationIssue]) -> bool:
    return not any(i.severity == "error" for i in issues)


def raise_for_issues(issues: list[ValidationIssue]) -> None:
    if not is_valid(issues):
        raise MarketSpecValidationError(issues)


# --------------------------------------------------------------------------- #
# Individual checks
# --------------------------------------------------------------------------- #


def _check_question(spec: MarketSpec) -> list[ValidationIssue]:
    issues = []
    question = spec.question.strip()

    if not question:
        return [ValidationIssue("question", "empty", "Question is empty.")]
    if not question.endswith("?"):
        issues.append(ValidationIssue("question", "not_a_question",
                                      "Question does not end with '?'."))
    if not re.match(r"^(will|is|are|does|did|has|have|can)\b", question, re.I):
        issues.append(ValidationIssue(
            "question", "not_predictive",
            "Question should start with 'Will' (or another clear yes/no opener)."))
    if len(question) > MAX_QUESTION_CHARS:
        issues.append(ValidationIssue(
            "question", "too_long",
            f"Question is {len(question)} chars, limit is {MAX_QUESTION_CHARS}."))

    # Subjective wording is allowed only if the criteria quantify it.
    criteria = spec.resolution_criteria.lower()
    quantified = bool(re.search(r"\d", criteria))
    for term in sorted(SUBJECTIVE_TERMS):
        if re.search(rf"\b{re.escape(term)}\b", question, re.I):
            if not (term in criteria and quantified):
                issues.append(ValidationIssue(
                    "question", "subjective",
                    f"Question uses the subjective term {term!r} without an objective "
                    f"definition in the resolution criteria."))
    return issues


def _check_outcomes(spec: MarketSpec) -> list[ValidationIssue]:
    issues = []
    outcomes = [o.strip() for o in spec.outcomes if o.strip()]

    if len(outcomes) < 2:
        issues.append(ValidationIssue("outcomes", "too_few",
                                      "A market needs at least two outcomes."))
    if len({o.upper() for o in outcomes}) != len(outcomes):
        issues.append(ValidationIssue("outcomes", "duplicates",
                                      "Outcomes must be distinct."))
    # VOID is a settlement state, not something anyone can trade.
    if any(o.upper() == "VOID" for o in outcomes):
        issues.append(ValidationIssue(
            "outcomes", "void_not_tradeable",
            "VOID is a settlement state, not a tradeable outcome. Remove it from outcomes."))
    if len(outcomes) == 2 and {o.upper() for o in outcomes} != {"YES", "NO"}:
        issues.append(ValidationIssue(
            "outcomes", "non_binary_pair",
            f"A two-outcome market should be YES/NO, got {outcomes}.", severity="warning"))
    return issues


def _check_criteria(spec: MarketSpec) -> list[ValidationIssue]:
    issues = []
    criteria = spec.resolution_criteria.strip()
    if not criteria:
        return [ValidationIssue("resolution_criteria", "empty",
                                "Resolution criteria are empty.")]

    sentences = _SENTENCE.split(criteria)
    cancel_sentences = [s for s in sentences if _CANCEL.search(s)]
    normal_sentences = [s for s in sentences if not _CANCEL.search(s)]

    # Each outcome must be defined somewhere other than a cancellation clause —
    # "if cancelled, resolve NO" does not define what NO means.
    for outcome in spec.outcomes:
        token = outcome.strip()
        if not token:
            continue
        pattern = rf"\b{re.escape(token)}\b"
        if not any(re.search(pattern, s, re.I) for s in normal_sentences):
            issues.append(ValidationIssue(
                "resolution_criteria", "outcome_undefined",
                f"Criteria never state the conditions for {token!r}."))

    # Cancellation and postponement must not silently become NO.
    for sentence in cancel_sentences:
        resolves_no = re.search(r"\bresolves?\s+(?:to\s+)?['\"]?NO\b", sentence, re.I) \
            or re.search(r"\bNO\b", sentence)
        mentions_void = re.search(r"\b(void|unresolved|refund\w*|annull?ed|no[- ]action)\b",
                                  sentence, re.I)
        if resolves_no and not mentions_void:
            issues.append(ValidationIssue(
                "resolution_criteria", "cancellation_as_no",
                "Criteria resolve a cancelled or postponed event to NO. A market whose "
                "event never happened was never tested — it should VOID or stay "
                "unresolved."))
            break

    # Outcomes named in the criteria that the market does not offer.
    allowed = {o.upper() for o in spec.outcomes} | {"VOID"}
    for found in re.findall(r"\b(?:resolves?\s+(?:to\s+)?)([A-Z]{2,6})\b", criteria):
        if found not in allowed:
            issues.append(ValidationIssue(
                "resolution_criteria", "unknown_outcome",
                f"Criteria reference outcome {found!r}, which is not in {spec.outcomes}."))
            break
    return issues


def _check_resolution_date(spec: MarketSpec) -> list[ValidationIssue]:
    """A market with no resolution date is never picked up by the settlement
    sweep, so it sits open forever. Not fatal — some events genuinely have no
    knowable date — but it must not pass silently."""
    if spec.resolution_date is not None:
        return []
    return [ValidationIssue(
        "resolution_date", "missing",
        "No resolution date: this market can never be selected for settlement.",
        severity="warning")]


def _check_closing_time(spec: MarketSpec, now: datetime) -> list[ValidationIssue]:
    # A null closes_at is expected whenever the source never pinned a time.
    if spec.closes_at is None:
        return []

    closes = spec.closes_at
    if closes.tzinfo is None:
        closes = closes.replace(tzinfo=timezone.utc)

    issues = []
    if closes < now:
        issues.append(ValidationIssue(
            "closes_at", "in_the_past",
            f"Trading close {closes.isoformat()} is before now ({now.isoformat()})."))

    resolution = _as_datetime(spec.resolution_date)
    if resolution is not None and closes > resolution:
        issues.append(ValidationIssue(
            "closes_at", "after_resolution",
            "Trading must stop no later than the point the outcome becomes knowable "
            f"({closes.isoformat()} > {resolution.isoformat()})."))
    return issues


def _check_sources(spec: MarketSpec) -> list[ValidationIssue]:
    issues = []
    sources = [s.strip() for s in spec.resolution_sources if s.strip()]

    if not sources:
        return [ValidationIssue("resolution_sources", "missing",
                                "At least one resolution source is required.")]

    for source in sources:
        if _URL.search(source):
            issues.append(ValidationIssue(
                "resolution_sources", "fabricated_url",
                f"Source {source!r} contains a URL. URLs cannot be verified here — "
                "use a human-readable description of the authority instead."))

    if not any(hint in s.lower() for s in sources for hint in AUTHORITATIVE_HINTS):
        issues.append(ValidationIssue(
            "resolution_sources", "not_authoritative",
            f"No source reads as an authority: {sources}.", severity="warning"))
    return issues


def _check_canonical_event(spec: MarketSpec) -> list[ValidationIssue]:
    event = spec.canonical_event.strip()
    if not event:
        return [ValidationIssue("canonical_event", "empty",
                                "Canonical event must be preserved.")]

    # The question should still be recognisably about the event it came from.
    # Bare numbers are excluded: a shared year would otherwise make every market
    # in 2026 look related to every other one.
    event_words = {w for w in _WORD.findall(event.lower())
                   if len(w) > 3 and w not in STOPWORDS and not w.isdigit()}
    question_words = set(_WORD.findall(spec.question.lower()))
    if event_words and not (event_words & question_words):
        return [ValidationIssue(
            "canonical_event", "not_represented",
            f"The question shares no significant term with the canonical event {event!r}.")]
    return []


def _as_datetime(value: date | datetime | None) -> datetime | None:
    """Normalize a resolution date to the end of that day, UTC.

    A date-only resolution means the outcome is knowable at some point that day,
    so a close anywhere within the day is acceptable.
    """
    if value is None:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    return datetime.combine(value, time.max, tzinfo=timezone.utc)
