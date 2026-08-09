# Market Candidate Classifier

Classifies an X topic as CREATE / WAIT / REJECT for prediction-market creation,
and emits a canonical event + query. The classifier core is dependency-free and
never calls X or Grok — dependencies are injected.

## Install
    python -m venv .venv && . .venv/bin/activate
    pip install -e ".[dev]"     # core + tests
    pip install -e ".[grok]"    # + Grok semantic adapter
    pip install -e ".[ingest]"  # + live X ingestion client
    pip install -e ".[live]"    # grok + ingest (for examples/live_e2e.py)

## Use (offline)
    from classifier import CandidateTopic, MarketCandidateClassifier, FakeSemanticClassifier
    clf = MarketCandidateClassifier(semantic_classifier=FakeSemanticClassifier())
    result = await clf.classify(CandidateTopic(topic_id="t", topic_name="..."))

## Live
    from classifier.semantic.grok import GrokSemanticClassifier   # needs XAI_API_KEY
    from ingestion.x_client import XIngestionClient                # needs X_BEARER_TOKEN
    from ingestion.budget import RequestBudget

Ingestion (X -> CandidateTopic) lives in the separate `ingestion` package; see
`docs/ingestion.md`. Billing is pay-per-use with no cap — always pass a `RequestBudget`.

## Demos
    python examples/demo.py                       # offline, no network
    python examples/live_e2e.py "<x search query>"   # real X + Grok (billable)

## Background Sweeper

Full vertical slice combining discovery, ingestion, context, and classification.
See `docs/sweeper.md` for architecture and cost controls.

    python -m examples.sweeper_demo      # offline, no keys
    python -m examples.live_sweeper      # real X + Grok (billable), tiny budget

## Test
    python -m pytest -v          # all mocked; no network, no spend
