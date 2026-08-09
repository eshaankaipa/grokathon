from __future__ import annotations

import logging
from typing import Any

from ingestion.budget import BudgetExceeded, RequestBudget

from .config import SweeperConfig
from .dedup import dedupe_seeds
from .models import SweepCandidate, SweepResult

_log = logging.getLogger("sweeper")


class BackgroundSweeper:
    """Autonomous sweep: discover -> dedupe -> ingest -> context -> classify.

    Contains no scoring/semantic logic; it coordinates injected components and
    respects one shared X RequestBudget.
    """

    def __init__(
        self,
        *,
        discovery: Any,
        ingestion: Any,
        context_builder: Any,
        classifier: Any,
        budget: RequestBudget,
        config: SweeperConfig | None = None,
    ) -> None:
        self._discovery = discovery
        self._ingestion = ingestion
        self._context_builder = context_builder
        self._classifier = classifier
        self._budget = budget
        self._config = config or SweeperConfig()
        if budget.max_requests > self._config.max_x_requests_per_sweep:
            raise ValueError(
                f"budget.max_requests ({budget.max_requests}) exceeds "
                f"config.max_x_requests_per_sweep ({self._config.max_x_requests_per_sweep})"
            )

    async def run_once(self) -> SweepResult:
        cfg = self._config
        create: list[SweepCandidate] = []
        wait: list[SweepCandidate] = []
        rejected = 0
        try:
            seeds = await self._discovery.discover()
            seeds = dedupe_seeds(seeds)[: cfg.max_topics_per_sweep]
            for seed in seeds:
                candidate = await self._ingestion.ingest(seed)
                if candidate is None:
                    rejected += 1
                    if cfg.debug:
                        _log.debug("skip %s: below min_volume", seed.name)
                    continue
                context = await self._context_builder.build(candidate)
                result = await self._classifier.classify(candidate, context)
                sc = SweepCandidate(
                    topic_seed=seed, candidate_topic=candidate,
                    topic_context=context, classification_result=result,
                )
                if result.decision == "CREATE":
                    create.append(sc)
                elif result.decision == "WAIT":
                    wait.append(sc)
                else:
                    rejected += 1
                    if cfg.debug:
                        reason = result.reasons[-1] if result.reasons else ""
                        _log.debug("reject %s: %s", seed.name, reason)
        except BudgetExceeded:
            _log.warning("X request budget exhausted; returning partial sweep result")
        return SweepResult(
            create=tuple(create), wait=tuple(wait),
            rejected_count=rejected, requests_spent=self._budget.spent,
        )
