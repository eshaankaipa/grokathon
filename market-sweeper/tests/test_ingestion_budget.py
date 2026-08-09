import pytest

from ingestion.budget import BudgetExceeded, RequestBudget


def test_spend_tracks_and_reports():
    b = RequestBudget(max_requests=3)
    b.spend("search/recent")
    b.spend("counts/recent")
    assert b.spent == 2
    assert b.remaining == 1


def test_raises_before_exceeding_and_does_not_count_failed_spend():
    b = RequestBudget(max_requests=1)
    b.spend("counts/recent")
    with pytest.raises(BudgetExceeded):
        b.spend("search/recent")
    assert b.spent == 1


def test_per_endpoint_cost_weighting():
    b = RequestBudget(max_requests=10, per_endpoint_costs={"search/all": 5})
    b.spend("search/all")
    assert b.spent == 5
    assert b.remaining == 5


def test_negative_cost_rejected():
    b = RequestBudget(max_requests=5)
    with pytest.raises(ValueError):
        b.spend("x", cost=-1)


def test_spent_is_not_a_constructor_arg():
    with pytest.raises(TypeError):
        RequestBudget(max_requests=5, _spent=999)  # type: ignore[call-arg]
    assert RequestBudget(max_requests=5).spent == 0
