from classifier.gates import check_hard_gates
from classifier.models import SemanticFeatures


def test_all_gates_pass_returns_empty():
    s = SemanticFeatures(eventness=0.9, resolvability=0.9, unresolvedness=0.9,
                         subjectivity=0.1, specificity=0.8)
    assert check_hard_gates(s) == []


def test_low_eventness_fails():
    s = SemanticFeatures(0.1, 0.9, 0.9, 0.9, 0.3)
    failures = check_hard_gates(s)
    assert any("eventness" in f for f in failures)


def test_already_resolved_fails_on_unresolvedness():
    s = SemanticFeatures(0.9, 0.95, 0.05, 0.1, 0.9)
    failures = check_hard_gates(s)
    assert any("unresolvedness" in f for f in failures)


def test_low_resolvability_fails():
    s = SemanticFeatures(0.9, 0.1, 0.9, 0.2, 0.8)
    failures = check_hard_gates(s)
    assert any("resolvability" in f for f in failures)
