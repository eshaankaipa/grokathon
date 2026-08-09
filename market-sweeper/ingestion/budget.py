from __future__ import annotations

from dataclasses import dataclass, field


class BudgetExceeded(RuntimeError):
    """Raised when a request would exceed the hard request-count budget."""


@dataclass
class RequestBudget:
    """Hard cap on billable X API requests for one ingest run.

    Pay-per-use billing has no monthly cap, so this is the backstop that stops a
    runaway loop from burning credits. Mutable counter by design; not thread-safe
    (intended for a single ingest loop).
    """

    max_requests: int
    per_endpoint_costs: dict[str, int] = field(default_factory=dict)
    _spent: int = field(default=0, init=False)

    def spend(self, endpoint: str = "", cost: int | None = None) -> None:
        c = cost if cost is not None else self.per_endpoint_costs.get(endpoint, 1)
        if c < 0:
            raise ValueError("cost must be non-negative")
        if self._spent + c > self.max_requests:
            raise BudgetExceeded(
                f"request budget {self.max_requests} would be exceeded: "
                f"spent {self._spent}, need {c} more for '{endpoint or 'request'}'"
            )
        self._spent += c

    @property
    def spent(self) -> int:
        return self._spent

    @property
    def remaining(self) -> int:
        return max(0, self.max_requests - self._spent)
