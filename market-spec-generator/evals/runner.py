from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

from app.classifier import Classifier
from app.dedup import Deduplicator
from app.embeddings import Embedder, canonical_text
from app.llm import JSONLLM
from app.grounding import Grounder
from app.models import Classification, Decision, Market, Tweet, TweetCluster
from app.store import VectorStore

EVAL_DIR = Path(__file__).resolve().parent


def load(name: str) -> dict[str, Any]:
    return json.loads((EVAL_DIR / name).read_text())


# --------------------------------------------------------------------------- #
# Scoring
# --------------------------------------------------------------------------- #


@dataclass
class Score:
    """Binary classification score with `duplicate` as the positive class."""

    tp: int = 0
    fp: int = 0
    tn: int = 0
    fn: int = 0

    @property
    def precision(self) -> float:
        return self.tp / (self.tp + self.fp) if (self.tp + self.fp) else 1.0

    @property
    def recall(self) -> float:
        return self.tp / (self.tp + self.fn) if (self.tp + self.fn) else 1.0

    @property
    def f1(self) -> float:
        p, r = self.precision, self.recall
        return 2 * p * r / (p + r) if (p + r) else 0.0

    @property
    def accuracy(self) -> float:
        total = self.tp + self.fp + self.tn + self.fn
        return (self.tp + self.tn) / total if total else 0.0

    def add(self, *, predicted: bool, actual: bool) -> None:
        if predicted and actual:
            self.tp += 1
        elif predicted and not actual:
            self.fp += 1
        elif not predicted and actual:
            self.fn += 1
        else:
            self.tn += 1


@dataclass
class CaseResult:
    name: str
    passed: bool
    expected: str
    got: str
    detail: str = ""


@dataclass
class DedupReport:
    """Two stages scored separately, because they fail for different reasons.

    Recall failures mean the vector store never surfaced the right candidate, so
    the judge never had a chance — that's a floor/k problem. Judge failures mean
    the candidate was right there and the model called it wrong — that's a prompt
    or model problem. Averaging them hides which one you have.
    """

    recall_hits: int = 0
    recall_total: int = 0
    score: Score = field(default_factory=Score)
    cases: list[CaseResult] = field(default_factory=list)

    @property
    def retrieval_recall(self) -> float:
        return self.recall_hits / self.recall_total if self.recall_total else 1.0

    @property
    def failures(self) -> list[CaseResult]:
        return [c for c in self.cases if not c.passed]


# --------------------------------------------------------------------------- #
# Dedup evaluation
# --------------------------------------------------------------------------- #


async def seed_corpus(store: VectorStore, embedder: Embedder, markets: list[dict]) -> None:
    for raw in markets:
        market = Market(**raw)
        vector = await embedder.embed_one(
            canonical_text(
                event=market.event, query=market.query, entities=market.entities,
                category=market.category, resolution_date=market.resolution_date,
            )
        )
        store.upsert(market, vector)


def _proposal(raw: dict) -> Classification:
    return Classification(
        decision=Decision.CREATE,
        event=raw["event"],
        query=raw.get("query", ""),
        category=raw.get("category", "other"),
        entities=raw.get("entities", []),
        resolution_date=raw.get("resolution_date"),
    )


async def eval_dedup(dedup: Deduplicator, cases: list[dict]) -> DedupReport:
    report = DedupReport()

    for case in cases:
        expected_id = case.get("duplicate_of")
        check, _ = await dedup.check(_proposal(case["proposal"]))

        # Stage 1: did the store surface the right market at all?
        if expected_id:
            report.recall_total += 1
            retrieved = {c.market_id for c in check.candidates}
            if expected_id in retrieved:
                report.recall_hits += 1
            else:
                report.cases.append(CaseResult(
                    name=case["name"], passed=False, expected=expected_id,
                    got="not retrieved",
                    detail=f"vector search missed it; best was "
                           f"{check.candidates[0].similarity:.3f}" if check.candidates
                           else "vector search returned nothing above the floor",
                ))

        # Stage 2: was the final verdict right?
        got_id = check.duplicate_of.market_id if check.duplicate_of else None
        correct = got_id == expected_id
        report.score.add(predicted=check.is_duplicate, actual=bool(expected_id))

        if not correct and not any(c.name == case["name"] for c in report.cases):
            report.cases.append(CaseResult(
                name=case["name"], passed=False,
                expected=expected_id or "new",
                got=got_id or "new",
                detail=f"[{check.method}] {check.reason}",
            ))
        elif correct:
            report.cases.append(CaseResult(
                name=case["name"], passed=True,
                expected=expected_id or "new", got=got_id or "new",
                detail=f"[{check.method}]",
            ))

    return report


# --------------------------------------------------------------------------- #
# Threshold sweep — embeddings only, no LLM calls
# --------------------------------------------------------------------------- #


@dataclass
class SweepRow:
    floor: float
    retrieval_recall: float
    mean_candidates: float
    auto_dup_correct: int
    auto_dup_wrong: int


async def sweep_thresholds(
    store: VectorStore,
    embedder: Embedder,
    cases: list[dict],
    *,
    floors: list[float],
    auto_threshold: float,
    k: int = 8,
) -> list[SweepRow]:
    """Show what CANDIDATE_FLOOR buys and costs, without spending an LLM call.

    Also counts how often a bare similarity threshold would auto-settle a pair
    correctly vs. wrongly — the measurement that catches a threshold sitting
    below a hard negative.
    """
    vectors = []
    for case in cases:
        p = case["proposal"]
        vectors.append(await embedder.embed_one(canonical_text(
            event=p["event"], query=p.get("query", ""), entities=p.get("entities", []),
            category=p.get("category", ""), resolution_date=p.get("resolution_date"),
        )))

    rows: list[SweepRow] = []
    for floor in floors:
        hits = total = 0
        candidate_counts = []
        auto_ok = auto_bad = 0

        for case, vector in zip(cases, vectors):
            expected = case.get("duplicate_of")
            found = store.search(vector, k=k, min_similarity=floor)
            candidate_counts.append(len(found))

            if expected:
                total += 1
                if any(h.market.id == expected for h in found):
                    hits += 1

            # What a similarity-only rule would have done.
            if found and found[0].similarity >= auto_threshold:
                if found[0].market.id == expected:
                    auto_ok += 1
                else:
                    auto_bad += 1

        rows.append(SweepRow(
            floor=floor,
            retrieval_recall=hits / total if total else 1.0,
            mean_candidates=sum(candidate_counts) / len(candidate_counts),
            auto_dup_correct=auto_ok,
            auto_dup_wrong=auto_bad,
        ))
    return rows


# --------------------------------------------------------------------------- #
# Classifier evaluation
# --------------------------------------------------------------------------- #


@dataclass
class ClassifyReport:
    correct: int = 0
    total: int = 0
    date_correct: int = 0
    date_total: int = 0
    confusion: dict[str, dict[str, int]] = field(default_factory=dict)
    cases: list[CaseResult] = field(default_factory=list)

    @property
    def accuracy(self) -> float:
        return self.correct / self.total if self.total else 0.0

    @property
    def date_accuracy(self) -> float:
        return self.date_correct / self.date_total if self.date_total else 1.0

    @property
    def failures(self) -> list[CaseResult]:
        return [c for c in self.cases if not c.passed]


async def eval_classifier(classifier: Classifier, cases: list[dict]) -> ClassifyReport:
    report = ClassifyReport()

    for case in cases:
        expected = case["expect"]
        cluster = TweetCluster(**case["cluster"])
        result = await classifier.classify(cluster)
        got = result.decision.value

        report.total += 1
        report.confusion.setdefault(expected, {}).setdefault(got, 0)
        report.confusion[expected][got] += 1

        detail = result.reason[:90]
        if got == expected:
            report.correct += 1

        if (want_date := case.get("expect_date")) is not None:
            report.date_total += 1
            if result.resolution_date == want_date:
                report.date_correct += 1
            else:
                detail = f"date {result.resolution_date} != {want_date}. {detail}"

        date_ok = case.get("expect_date") is None or result.resolution_date == case["expect_date"]
        report.cases.append(CaseResult(
            name=case["name"], passed=(got == expected and date_ok),
            expected=expected, got=got, detail=detail,
        ))

    return report


# --------------------------------------------------------------------------- #
# Grounding evaluation
# --------------------------------------------------------------------------- #


@dataclass
class GroundReport:
    score: Score = field(default_factory=Score)
    support_correct: int = 0
    support_total: int = 0
    llm_calls_saved: int = 0
    cases: list[CaseResult] = field(default_factory=list)

    @property
    def failures(self) -> list[CaseResult]:
        return [c for c in self.cases if not c.passed]


async def eval_grounding(grounder: Grounder, cases: list[dict]) -> GroundReport:
    """`supported` is scored with UNSUPPORTED as the positive class — the whole
    point of the stage is catching unfounded markets, so recall here means 'of the
    invented markets, how many did we block'."""
    report = GroundReport()

    for case in cases:
        cluster = TweetCluster(tweets=[
            Tweet(id=str(i), text=t) for i, t in enumerate(case["tweets"])
        ])
        classification = Classification(
            decision=Decision.CREATE, event=case["event"], query=case["event"],
            category=case.get("category", "other"), entities=case.get("entities", []),
            resolution_date=case.get("resolution_date"),
        )
        result = await grounder.check(classification, cluster)

        expected = case["expect_supported"]
        report.score.add(predicted=not result.supported, actual=not expected)

        if result.date_support in ("explicit", "relative"):
            report.llm_calls_saved += 1

        detail = result.reason[:100]
        support_ok = True
        if (want := case.get("expect_date_support")) is not None:
            report.support_total += 1
            if result.date_support == want:
                report.support_correct += 1
            else:
                support_ok = False
                detail = f"date_support {result.date_support} != {want}. {detail}"

        report.cases.append(CaseResult(
            name=case["name"], passed=(result.supported == expected and support_ok),
            expected="supported" if expected else "blocked",
            got="supported" if result.supported else "blocked",
            detail=detail,
        ))

    return report


# --------------------------------------------------------------------------- #
# Market spec evaluation
# --------------------------------------------------------------------------- #


@dataclass
class SpecReport:
    generated: int = 0
    valid: int = 0
    repaired: int = 0
    rejected: int = 0
    property_checks: int = 0
    property_passes: int = 0
    cases: list[CaseResult] = field(default_factory=list)

    @property
    def validity(self) -> float:
        return self.valid / self.generated if self.generated else 0.0

    @property
    def property_accuracy(self) -> float:
        return self.property_passes / self.property_checks if self.property_checks else 1.0

    @property
    def failures(self) -> list[CaseResult]:
        return [c for c in self.cases if not c.passed]


async def eval_spec(generator, cases: list[dict]) -> SpecReport:
    """Score the Market Spec Generator end to end.

    Validity is the headline: did a spec survive deterministic validation at all.
    Property checks assert the things a prompt can silently regress on — that
    closes_at stays null when no time is grounded, that entity names survive, and
    that a cancellation never resolves NO.
    """
    from app.models import EventSpec
    from app.spec_validation import MarketSpecValidationError, validate_market_spec

    report = SpecReport()

    for case in cases:
        event = EventSpec(**case["event"])
        report.generated += 1
        detail = ""
        passed = True

        try:
            spec = await generator.generate(event)
        except MarketSpecValidationError as exc:
            report.rejected += 1
            passed = not case.get("expect_valid", True)
            report.cases.append(CaseResult(
                name=case["name"], passed=passed,
                expected="valid" if case.get("expect_valid", True) else "rejected",
                got="rejected", detail="; ".join(str(i) for i in exc.errors)[:160],
            ))
            continue

        issues = validate_market_spec(spec)
        if not [i for i in issues if i.severity == "error"]:
            report.valid += 1
        else:
            passed = False
            detail = "; ".join(str(i) for i in issues)[:160]

        # Property assertions
        def check(condition: bool, message: str) -> None:
            nonlocal passed, detail
            report.property_checks += 1
            if condition:
                report.property_passes += 1
            else:
                passed = False
                detail = (detail + " | " + message).strip(" |")

        if case.get("expect_closes_at_null"):
            check(spec.closes_at is None,
                  f"closes_at should be null, got {spec.closes_at}")
        for term in case.get("expect_question_contains", []):
            check(term.lower() in spec.question.lower(),
                  f"question missing {term!r}")
        for term in case.get("expect_question_not_contains", []):
            check(term.lower() not in spec.question.lower(),
                  f"question contains subjective {term!r}")
        if case.get("expect_criteria_not_cancellation_as_no"):
            check(not any(i.code == "cancellation_as_no" for i in issues),
                  "cancellation mapped to NO")
        check(bool(spec.canonical_event), "canonical event not preserved")
        check(spec.outcomes == ["YES", "NO"], f"outcomes are {spec.outcomes}")

        report.cases.append(CaseResult(
            name=case["name"], passed=passed,
            expected="valid" if case.get("expect_valid", True) else "rejected",
            got="valid", detail=detail or spec.question[:90],
        ))

    return report
