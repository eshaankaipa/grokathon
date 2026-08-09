from __future__ import annotations

from dataclasses import dataclass

from classifier import CandidateTopic, ClassificationResult
from context.models import TopicContext
from discovery.base import TopicSeed


@dataclass(frozen=True)
class SweepCandidate:
    topic_seed: TopicSeed
    candidate_topic: CandidateTopic
    topic_context: TopicContext | None
    classification_result: ClassificationResult


@dataclass(frozen=True)
class SweepResult:
    create: tuple[SweepCandidate, ...]
    wait: tuple[SweepCandidate, ...]
    rejected_count: int
    requests_spent: int
