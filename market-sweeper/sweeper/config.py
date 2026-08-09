from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class SweeperConfig:
    """Sweep-wide budget/cost controls.

    ``max_x_requests_per_sweep`` is enforced by BackgroundSweeper against the injected
    RequestBudget. ``max_context_grok_calls_per_topic`` is advisory: the caller must wire it
    into the context builder's ``ContextConfig(max_grok_calls_per_topic=...)`` (see
    examples/live_sweeper.py).
    """

    max_topics_per_sweep: int = 10
    max_x_requests_per_sweep: int = 20
    max_posts_per_topic: int = 40
    max_context_grok_calls_per_topic: int = 6
    min_volume: int = 10
    debug: bool = False
