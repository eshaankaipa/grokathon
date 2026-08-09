# X Markets — Autonomous Market Candidate Pipeline

> **For reviewers/agents:** this is the **backend slice** of X Markets that turns raw X activity into
> vetted, market-worthy events. It stops at `CREATE / WAIT / REJECT` + a canonical event/query;
> everything downstream (market-question generation, trading, resolution, frontend) is intentionally
> **not** built here.
>
> This README lives in `sweeper/` (the orchestrator), but the pipeline spans sibling packages at the repo
> root: [`../classifier/`](../classifier/), [`../ingestion/`](../ingestion/), [`../discovery/`](../discovery/),
> [`../context/`](../context/), and this [`sweeper/`](.). The unrelated Remotion pitch video in
> [`../video-demo/`](../video-demo/) is not part of this work.

Branch of record: `feat/market-candidate-classifier`. Python **3.11+**. **78 tests pass / 1 skipped** (all mocked; no network, no spend). Validated live against real X + Grok.

---

## What this does

```
X API  →  ┌───────────────────────────────────────────────┐  →  CREATE / WAIT / REJECT
raw       │  AUTONOMOUS DISCOVERY  +  MARKET CLASSIFIER     │      + canonical event
trends    │  (Background Sweeper drives the Classifier)     │      + query
+ posts   └───────────────────────────────────────────────┘        │
                                                                     └─► downstream (NOT in this repo):
                                                                         question generation, markets,
                                                                         trading, resolution, frontend
```

Two cooperating systems + a reused ingestion layer:

- **Market Candidate Classifier** ([`../classifier/`](../classifier/)) — decides whether one topic deserves a market.
- **Background Sweeper** ([`../discovery/`](../discovery/), [`../context/`](../context/), [`sweeper/`](.)) — autonomously discovers topics and runs each through the classifier.
- **Ingestion** ([`../ingestion/`](../ingestion/)) — read-only, budget-guarded X access.

The single public entry point for the autonomous path:

```python
result = await sweeper.run_once()   # -> SweepResult(create, wait, rejected_count, requests_spent)
```

---

## The contract (inputs → outputs)

This is what a downstream integration needs. Objects are Python dataclasses; serialize any of them to JSON with `json.dumps(dataclasses.asdict(obj))` (tuples become arrays, `None` becomes `null`).

### INPUT — X data

There are two ways in, depending on how much you want the pipeline to do:

**(a) Autonomous** — pass nothing. `BackgroundSweeper.run_once()` discovers topics from live X trends itself. This is the normal entry point.

**(b) Direct classification** — hand the classifier one already-assembled `CandidateTopic` (the normalized, X-agnostic input the ingestion layer produces from `counts/recent` + `search/recent`):

```jsonc
// CandidateTopic — the normalized input (all fields except topic_id/topic_name are optional)
{
  "topic_id": "ufc-vegas-120",
  "topic_name": "#UFCVegas120",
  "representative_posts": ["Ty Miller TKO round 3 ...", "Lemos vs Thainara next ..."],
  "post_count": 7096,            // full volume, from counts/recent
  "unique_author_count": 39,     // distinct authors in the ~40-post sample
  "engagement_count": 76,        // summed likes/reposts/replies/quotes over the sample
  "impression_count": null,      // optional; often unavailable
  "volume_velocity": 956.0,      // posts in the latest hour bucket
  "volume_growth": 26.16,        // latest bucket vs mean of prior buckets
  "topic_age_minutes": 2.52,     // now − oldest sampled post
  "metadata": { "query": "#UFCVegas120", "sampled_posts": 40 }
}
```

Raw X JSON → `CandidateTopic` mapping is documented in [../docs/ingestion.md](../docs/ingestion.md); the classifier itself never sees raw X payloads.

### OUTPUT — the decision

`run_once()` returns a **`SweepResult`**. `create` and `wait` are lists of `SweepCandidate`; `REJECT`ed topics are counted only (not returned):

```jsonc
// SweepResult
{
  "create": [ /* SweepCandidate, … */ ],
  "wait":   [ /* SweepCandidate, … */ ],
  "rejected_count": 1,
  "requests_spent": 7
}
```

Each **`SweepCandidate`** carries the full provenance (seed → candidate → context → decision). The field the next stage acts on is `classification_result`:

```jsonc
// ClassificationResult  (the core output contract)
{
  "decision": "CREATE",                 // "CREATE" | "WAIT" | "REJECT"
  "score": 0.666,                        // 0..1 marketability score
  "canonical_event": "United States women's national basketball team wins FIBA Women's World Cup gold medal",
  "query": "United States women s national basketball team wins FIBA Women s World Cup gold medal",
  "semantic_features": {                 // Grok's 0..1 judgments (+ its canonical_event/reasoning)
    "eventness": 0.9, "resolvability": 0.85, "unresolvedness": 0.8,
    "subjectivity": 0.2, "specificity": 0.7,
    "canonical_event": "…", "reasoning_summary": "…"
  },
  "numeric_features": {                   // normalized 0..1 X signals
    "attention": 0.99, "velocity": 0.98, "engagement": 0.15, "diversity": 0.9, "freshness": 0.1
  },
  "reasons": [                            // human-readable decision trace
    "passed hard gates; marketability score 0.67",
    "score >= create_threshold 0.62 and specificity >= 0.45 -> CREATE"
  ]
}
```

**Minimal downstream contract.** The market-question generator only needs three fields off each `CREATE` (and optionally `WAIT`) candidate:

```json
{
  "decision": "CREATE",
  "event": "United States women's national basketball team wins FIBA Women's World Cup gold medal",
  "query": "United States women s national basketball team wins FIBA Women s World Cup gold medal"
}
```

- `event` = `classification_result.canonical_event` — a **neutral phrase**, never a question (turning it into "Will …?" is the downstream stage's job).
- `query` = `classification_result.query` — a concise search string for re-pulling/monitoring the topic. `query` is populated on `CREATE`, `null` on `WAIT`/`REJECT`.
- `WAIT` means "real but not yet" — keep it visible and re-evaluate on a later sweep. `REJECT` is dropped (only its reason is logged in debug mode).

---

## How the Background Sweeper works (step by step)

`BackgroundSweeper.run_once()` ([sweeper.py](sweeper.py)) coordinates injected components — it contains **no scoring/semantic logic of its own**:

```
① DISCOVER   discovery.discover()               live X trends (or configured/fake) -> [TopicSeed]
② DEDUPE     dedupe_seeds(seeds)[:max_topics]    collapse near-duplicate seeds, cap the count
③ per seed (while the shared X budget allows):
   INGEST    ingestion.ingest(seed)              counts/recent pre-filter (skip if < min_volume)
                                                 -> search/recent (~max_posts) -> CandidateTopic
   CONTEXT   context_builder.build(candidate)    Grok RLM: chunk -> summarize -> recursively reduce
                                                 -> TopicContext
   CLASSIFY  classifier.classify(cand, context)  numeric features + Grok semantic -> gates -> score
                                                 -> CREATE / WAIT / REJECT
④ RESULT     SweepResult(create[], wait[], rejected_count, requests_spent)
```

Key properties:

- **One shared `RequestBudget`** is threaded through discovery *and* ingestion. On `BudgetExceeded` the sweep stops cleanly and returns **partial** results — it never crashes mid-way or silently overspends (X billing is pay-per-use with no cap).
- **Cheap before expensive:** a topic below `min_volume` is rejected after the counts call and **never triggers** the costly `search/recent`.
- **Understand vs decide** is strictly separated: the Context Builder *explains* the conversation; the Classifier *decides* market-worthiness. Neither does the other's job.

---

## The components

### Classifier — [`../classifier/`](../classifier/) (dependency-free core; X/Grok/ingestion-agnostic)
| File | Responsibility |
|---|---|
| [models.py](../classifier/models.py) | `CandidateTopic` (input), `SemanticFeatures`, `NumericFeatures`, `ClassificationResult` — frozen, scores clamped 0–1 |
| [config.py](../classifier/config.py) | `ClassifierConfig` — all weights, thresholds, gate cutoffs, normalization constants (nothing hardcoded elsewhere) |
| [numeric_features.py](../classifier/numeric_features.py) | raw X signals → normalized `attention, velocity, engagement, diversity, freshness` (handles missing fields) |
| [gates.py](../classifier/gates.py) | hard gates on eventness / resolvability / unresolvedness → fail = REJECT regardless of popularity |
| [scoring.py](../classifier/scoring.py) | weighted marketability score (− subjectivity penalty) + `build_query` (neutral search string, never a question) |
| [semantic/](../classifier/semantic/) | injected judgment: `base` (interface), `fake` (tests), `grok` (real xAI Grok → 5 scores + neutral `canonical_event`) |
| [classifier.py](../classifier/classifier.py) | orchestrates the decision |

**Decision policy (single source of truth):**
1. any hard-gate failure → **REJECT**
2. else `score ≥ create_threshold` AND `specificity ≥ min_specificity_for_create` → **CREATE**
3. else `score ≥ wait_threshold` → **WAIT**
4. else → **REJECT** (too weak)

The classifier optionally accepts a `TopicContext` (`classify(candidate, context=None)`); the semantic adapter uses it to enrich the prompt. Referenced via `TYPE_CHECKING` only, so the core keeps zero runtime dependency on `context/`.

### Ingestion — [`../ingestion/`](../ingestion/)
- [budget.py](../ingestion/budget.py) — `RequestBudget` / `BudgetExceeded`: hard request cap, raises before overspending.
- [x_client.py](../ingestion/x_client.py) — `XIngestionClient`: `counts/recent` → `search/recent` → `CandidateTopic`, plus `fetch_trends`. Bearer-only, read-only, honors rate-limit headers, never writes, never full-archive search. Base URL `https://api.x.com`.

### Discovery — [`../discovery/`](../discovery/) (finds topics; never classifies)
`TopicSeed` + `TopicDiscovery` interface, plus `FakeTopicDiscovery`, `ConfiguredDiscovery` (hand-picked queries), `XTrendDiscovery` (live X trends), `CompositeDiscovery`. Raw trend JSON is parsed only inside the adapter.

### Context Builder (RLM) — [`../context/`](../context/) (understands; never decides)
`TopicContext` + interface + fake + [grok.py](../context/grok.py). The Grok builder is a **recursive language model**: split posts into chunks → summarize each → **recursively reduce** batches until one summary remains (single pass for small sets). Budget-capped; folds leftover raw posts in on exhaustion so nothing is dropped; validated config (`max_synthesis_inputs ≥ 2`) guarantees termination.

### Sweeper — [`sweeper/`](.)
`SweepResult` / `SweepCandidate` models, `SweeperConfig` (budget/cost knobs), `dedupe_seeds`, a seed→ingestion adapter, and `BackgroundSweeper.run_once()`.

---

## Run it

Setup (once, from the repo root):
```bash
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"     # core + tests
pip install -e ".[live]"    # + Grok + X client, for the live demos
```

Offline (no keys, deterministic):
```bash
python -m examples.sweeper_demo    # autonomous flow with fakes
python -m examples.demo            # single-topic classifier
```

Live (real, billable X + Grok; reads `.env`; read-only, tiny budget):
```bash
python -m examples.live_sweeper                 # one-line summary per candidate
python -m examples.live_sweeper_verbose         # fully autonomous US trends, pretty per-topic cards
SWEEP_WOEID=1 python -m examples.live_sweeper_verbose   # global trends instead of US (23424977)
```

Tests:
```bash
python -m pytest -q         # 78 passed, 1 skipped — all mocked, no network/spend
```

Credentials live in `.env` (gitignored; see [`../.env.example`](../.env.example) and [../docs/x-api-access.md](../docs/x-api-access.md)). Never hardcode or commit secrets.

---

## Budget & cost controls (`SweeperConfig`)
`max_topics_per_sweep`, `max_x_requests_per_sweep` (enforced against the injected `RequestBudget`), `max_posts_per_topic`, `max_context_grok_calls_per_topic` (wire into `ContextConfig`), `min_volume`. Discovery + ingestion share one budget; the live demos default to a tiny cap.

---

## Repo layout
```
classifier/     decision engine (dependency-free core + semantic adapters)
ingestion/      read-only budget-guarded X client
discovery/      topic-seed discovery (trends / configured / fake / composite)
context/        event-level RLM context builder
sweeper/        BackgroundSweeper orchestration  ← this README
examples/       offline + live demos
tests/          78 mocked tests
docs/           sweeper.md, ingestion.md, x-api-access.md, superpowers/plans/*
video-demo/     UNRELATED Remotion pitch video (ignore for backend review)
pyproject.toml  extras: [dev] [grok] [ingest] [live]
```

More detail: [../docs/sweeper.md](../docs/sweeper.md) · [../docs/ingestion.md](../docs/ingestion.md) · [../classifier/README.md](../classifier/README.md) · implementation plans in [../docs/superpowers/plans/](../docs/superpowers/plans/).

---

## Status & known limitations
- Fully built, reviewed task-by-task + two whole-branch reviews; validated live (classifier on manual queries; full autonomous sweep on US trends → correctly produced CREATE/REJECT decisions on real events).
- **Calibration (deferred):** default `create_threshold=0.62` is tuned conservatively — fresh sports/breaking events clear it; slower-moving topics land just under and get WAIT. Intended to be tuned against a labeled set.
- **Sampling nuance:** `post_count`/`velocity`/`growth` reflect full volume (from `counts/recent`); `unique_author_count`/`engagement` are computed from the ~40-post sample, so they're sample-scaled, not population totals.
- **Minor dedup gap:** seed dedup tokenizes ASCII only, so all-non-Latin hashtags can collapse together. Cosmetic; easy fix.

## Scope boundary (do NOT add here)
question generation · market spec/persistence/matching · trading · payments · resolution · frontend · persistent scheduling. Those are later pipeline stages.
