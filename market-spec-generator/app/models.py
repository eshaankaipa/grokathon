from __future__ import annotations

from datetime import date, datetime, timezone
from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, Field


def utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# --------------------------------------------------------------------------- #
# Input
# --------------------------------------------------------------------------- #


class Tweet(BaseModel):
    """One post out of the X API, trimmed to what the classifier actually reads."""

    id: str
    text: str
    author: str | None = None
    created_at: str | None = None
    likes: int = 0
    reposts: int = 0
    replies: int = 0
    views: int = 0

    @property
    def engagement(self) -> int:
        # Reposts signal spread far harder than a like does; views are noisy so they
        # only get counted at a heavy discount.
        return self.likes + 3 * self.reposts + 2 * self.replies + self.views // 100


class TweetCluster(BaseModel):
    """A group of adjacent/similar tweets produced by the upstream clustering step."""

    cluster_id: str | None = None
    topic: str | None = Field(default=None, description="Trend name or hashtag, if X gave one")
    tweets: list[Tweet] = Field(min_length=1)

    @property
    def total_engagement(self) -> int:
        return sum(t.engagement for t in self.tweets)

    def digest(self, limit: int = 25) -> str:
        """Compact, token-cheap rendering of the cluster for the classifier prompt."""
        ranked = sorted(self.tweets, key=lambda t: t.engagement, reverse=True)[:limit]
        lines = []
        if self.topic:
            lines.append(f"TREND: {self.topic}")
        lines.append(f"CLUSTER SIZE: {len(self.tweets)} posts, {self.total_engagement} weighted engagement")
        lines.append("TOP POSTS:")
        for t in ranked:
            when = f" @ {t.created_at}" if t.created_at else ""
            who = f"@{t.author}" if t.author else "unknown"
            text = " ".join(t.text.split())
            lines.append(f"- [{who}{when} | eng {t.engagement}] {text}")
        return "\n".join(lines)


# --------------------------------------------------------------------------- #
# Stage 1 — classifier
# --------------------------------------------------------------------------- #


class Decision(str, Enum):
    CREATE = "CREATE"
    WAIT = "WAIT"
    REJECT = "REJECT"


class Classification(BaseModel):
    decision: Decision
    event: str = Field(default="", description="Canonical human-readable event name")
    query: str = Field(default="", description="Short keyword query used for vector dedup")
    category: str = Field(default="other")
    entities: list[str] = Field(default_factory=list)
    resolution_date: str | None = Field(default=None, description="ISO date the outcome is known")
    confidence: float = 0.0
    reason: str = ""


# --------------------------------------------------------------------------- #
# Stage 2 — vector dedup
# --------------------------------------------------------------------------- #


# --------------------------------------------------------------------------- #
# Market spec generation — the boundary with the upstream sweeper
# --------------------------------------------------------------------------- #


DEFAULT_OUTCOMES: list[str] = ["YES", "NO"]


class EventSpec(BaseModel):
    """An approved real-world event, as handed over by the upstream sweeper.

    This is the public input contract. It is deliberately free of this
    repository's internals — no Classification, no TweetCluster, no X API
    objects — so the upstream system can post JSON without knowing anything
    about how markets are classified or stored here.
    """

    canonical_event: str
    query: str | None = None
    category: str | None = None
    context_summary: str | None = None
    entities: list[str] = Field(default_factory=list)
    key_developments: list[str] = Field(default_factory=list)
    unresolved_events: list[str] = Field(default_factory=list)

    @classmethod
    def from_classification(
        cls, classification: "Classification", cluster: "TweetCluster | None" = None
    ) -> "EventSpec":
        """Adapter for in-repo callers that still hold a Classification.

        Keeps the existing pipeline working while the generator itself depends
        only on EventSpec. The tweet cluster, if given, is flattened into a plain
        summary string — the generator never sees tweet objects.
        """
        summary = None
        if cluster is not None:
            summary = " | ".join(
                " ".join(t.text.split())
                for t in sorted(cluster.tweets, key=lambda t: t.engagement, reverse=True)[:5]
            )
        return cls(
            canonical_event=classification.event,
            query=classification.query or None,
            category=classification.category or None,
            context_summary=summary,
            entities=list(classification.entities),
            key_developments=(
                [f"Outcome expected to be known on {classification.resolution_date}"]
                if classification.resolution_date else []
            ),
        )


class MarketSpec(BaseModel):
    """A complete, self-contained prediction-market definition.

    Everything needed to understand what the market means lives here — a caller
    never has to rejoin fields from the classifier or anywhere else.
    """

    question: str
    outcomes: list[str] = Field(default_factory=lambda: list(DEFAULT_OUTCOMES))
    # When trading stops. Distinct from resolution_date, and null whenever the
    # source material does not pin an exact time — never manufactured.
    closes_at: datetime | None = None
    # When the outcome is expected to become knowable.
    resolution_date: date | datetime | None = None
    resolution_criteria: str = ""
    resolution_sources: list[str] = Field(default_factory=list)
    category: str | None = None
    canonical_event: str
    source_query: str | None = None


class Grounding(BaseModel):
    """Whether the source posts actually support the proposed market."""

    supported: bool
    date_support: Literal["explicit", "relative", "mismatch", "absent"] = "absent"
    confidence: float = 0.0
    issues: list[str] = Field(default_factory=list)
    evidence: str = ""
    reason: str = ""


class Candidate(BaseModel):
    market_id: str
    question: str
    event: str
    resolution_date: str | None = None
    status: str = "open"
    similarity: float


class DuplicateCheck(BaseModel):
    is_duplicate: bool
    duplicate_of: Candidate | None = None
    method: Literal["none", "threshold", "judge"] = "none"
    confidence: float = 0.0
    reason: str = ""
    candidates: list[Candidate] = Field(default_factory=list)


# --------------------------------------------------------------------------- #
# Stage 3 — question generator
# --------------------------------------------------------------------------- #


class MarketQuestion(BaseModel):
    """Superseded by MarketSpec. Retained so older callers keep importing cleanly."""

    question: str
    resolution_criteria: str = ""
    resolution_date: str | None = None
    resolution_source: str = ""


# --------------------------------------------------------------------------- #
# Stored market
# --------------------------------------------------------------------------- #


Status = Literal["open", "pending_resolution", "resolved", "cancelled"]

# Markets that still block a duplicate. A settled or voided market does not:
# the same fixture can legitimately be re-listed next season.
LIVE_STATUSES: tuple[str, ...] = ("open", "pending_resolution")


class Outcome(str, Enum):
    YES = "YES"
    NO = "NO"
    VOID = "VOID"
    UNKNOWN = "UNKNOWN"


class Market(BaseModel):
    id: str
    question: str
    event: str
    query: str
    category: str = "other"
    entities: list[str] = Field(default_factory=list)
    resolution_criteria: str = ""
    resolution_date: str | None = None
    resolution_source: str = ""
    outcomes: list[str] = Field(default_factory=lambda: list(DEFAULT_OUTCOMES))
    closes_at: str | None = None
    resolution_sources: list[str] = Field(default_factory=list)
    status: Status = "open"
    outcome: Literal["YES", "NO", "VOID"] | None = None
    resolved_at: str | None = None
    resolution_evidence: str = ""
    created_at: str = Field(default_factory=utcnow_iso)
    source_tweet_ids: list[str] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)


class Verdict(BaseModel):
    """What an outcome source concluded about a due market."""

    outcome: Outcome = Outcome.UNKNOWN
    confidence: float = 0.0
    evidence: str = ""
    source: str = ""


class Settlement(BaseModel):
    market_id: str
    question: str
    status: Status
    outcome: Literal["YES", "NO", "VOID"] | None = None
    confidence: float = 0.0
    evidence: str = ""
    note: str = ""


class SweepResult(BaseModel):
    checked: int = 0
    settled: int = 0
    pending_review: int = 0
    settlements: list[Settlement] = Field(default_factory=list)


class SearchHit(BaseModel):
    market: Market
    similarity: float


# --------------------------------------------------------------------------- #
# Pipeline output
# --------------------------------------------------------------------------- #


class PipelineResult(BaseModel):
    """What the caller gets back. `decision` is CREATE/WAIT/REJECT/DUPLICATE."""

    decision: Literal["CREATE", "WAIT", "REJECT", "DUPLICATE"]
    event: str = ""
    query: str = ""
    reason: str = ""
    market: Market | None = None
    spec: MarketSpec | None = None
    duplicate_of: Candidate | None = None
    classification: Classification | None = None
    grounding: Grounding | None = None
    candidates: list[Candidate] = Field(default_factory=list)
