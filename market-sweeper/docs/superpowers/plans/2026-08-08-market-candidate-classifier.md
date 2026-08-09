# Market Candidate Classifier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a self-contained, typed, configuration-driven Python component that classifies an X topic as `CREATE` / `WAIT` / `REJECT` for prediction-market creation, and emits a canonical event + query.

**Architecture:** The classifier consumes an already-normalized `CandidateTopic` (it never calls X). It extracts normalized numeric features from the deterministic X-derived signals, requests semantic judgments through an injected `SemanticClassifier` interface (Grok adapter in prod, fake in tests), applies hard gates, computes a weighted marketability score, and returns a structured `ClassificationResult`. All tunables live in `ClassifierConfig`.

**Tech Stack:** Python 3.11+, stdlib dataclasses (core is dependency-free), `pytest` + `pytest-asyncio` for tests, `openai` SDK (lazy, optional) only inside the Grok adapter pointed at `https://api.x.ai/v1`.

## Global Constraints

- **Python >= 3.11** (uses `X | None` unions, `Self`, `tuple[...]` generics).
- **Core `classifier` package has zero third-party runtime deps.** `openai` is imported lazily *inside* `semantic/grok.py` only, and declared as the optional `[grok]` extra.
- **All `SemanticFeatures` and `NumericFeatures` values are clamped to `0.0`–`1.0`** at construction.
- **The classifier MUST NOT import any X API or Grok SDK at module top level** (except lazily inside `semantic/grok.py`).
- **`canonical_event` is a neutral phrase, never a question.** `query` is a search string, never a question.
- **No weights, thresholds, or gate cutoffs hardcoded outside `ClassifierConfig`.**
- **Every optional `CandidateTopic` field may be `None`; extraction must never raise on `None`.**
- **Package layout (all paths relative to repo root):**
  ```
  classifier/
  ├── __init__.py
  ├── models.py
  ├── config.py
  ├── numeric_features.py
  ├── scoring.py
  ├── gates.py
  ├── classifier.py
  └── semantic/
      ├── __init__.py
      ├── base.py
      ├── fake.py
      └── grok.py
  ingestion/         # SEPARATE package — live X ingest (NEVER imported by classifier/)
  ├── __init__.py
  ├── budget.py
  └── x_client.py
  tests/…            examples/…            docs/ingestion.md
  pyproject.toml     README.md
  ```
- **`ingestion/` is a separate top-level package, never imported by `classifier/`.** The classifier stays X-agnostic; ingestion depends on `classifier` (for `CandidateTopic`), not vice versa.
- **Billing safety (pay-per-use, no monthly cap):** the ingestion client MUST enforce a hard request-count budget (`RequestBudget`) that raises before exceeding the cap, MUST read `x-rate-limit-remaining`/`x-rate-limit-reset` headers at runtime (never hardcode limits), MUST default to bearer-token/read-only endpoints, and MUST NOT call `/2/tweets/search/all` unless explicitly enabled. Base URL is `https://api.x.com`. Secrets come only from env (`.env`, gitignored) — never hardcoded, never logged.
- **pyproject extras:** core `classifier` stays dep-free. `[grok]` = `openai`; `[ingest]` = `requests`; `[live]` = `requests` + `openai`; `[dev]` = `pytest` + `pytest-asyncio` + `ruff`. `requests`/`openai` are lazy-imported inside their modules so the core + unit tests run without them.
- **All network in tests is mocked** (injected fake HTTP session / injected fake client). Live paths (real X, real Grok) run only in opt-in demos or `@pytest.mark.skipif(no key/env)` smoke tests, never in the default suite.
- **Decision policy (single source of truth, implemented in Task 8):**
  1. Any hard-gate failure → `REJECT` (regardless of attention/engagement).
  2. Else if `score >= create_threshold` AND `specificity >= min_specificity_for_create` → `CREATE`.
  3. Else if `score >= wait_threshold` → `WAIT`.
  4. Else → `REJECT` (extremely weak / irrelevant signal).

---

## X API Research Summary (informs the input contract — not implemented here)

The classifier receives `CandidateTopic`; the **ingestion layer** (implemented as the separate `ingestion` package in Task 10 — live access confirmed 2026-08-08, see `docs/x-api-access.md`) builds it from these X API v2 endpoints:

| `CandidateTopic` field | X API source | Notes |
|---|---|---|
| `topic_name` (+ optional `tweet_count`) | `GET /2/trends/by/woeid/{woeid}` (`trend.fields=trend_name,tweet_count`) | Pro/Enterprise tier; `tweet_count` frequently empty |
| `representative_posts`, `engagement_count`, `unique_author_count` | `GET /2/tweets/search/recent` (`tweet.fields=public_metrics,created_at,author_id`, `max_results=100`, last 7 days) | Sum public_metrics for engagement; count distinct `author_id` |
| `post_count`, `volume_velocity`, `volume_growth` | `GET /2/tweets/counts/recent` (`granularity=minute\|hour\|day`) | velocity = latest bucket rate; growth = recent-window / prior-window slope |
| `topic_age_minutes` | min `created_at` over sampled posts | Approximate; no direct endpoint |
| `impression_count` | `public_metrics.impression_count` | Unreliable/`0` for tweets you don't own → **optional** |

**Design consequence:** velocity, growth, age, diversity, freshness are *computed by ingestion*, not returned raw by X — which is exactly why every deterministic field is optional and extraction must degrade gracefully.

---

### Task 1: Project scaffolding

**Files:**
- Create: `pyproject.toml`
- Create: `classifier/__init__.py` (empty for now)
- Create: `classifier/semantic/__init__.py` (empty)
- Create: `tests/__init__.py` (empty)
- Create: `tests/test_smoke.py`
- Modify: `.gitignore` (append Python ignores)

**Interfaces:**
- Consumes: nothing.
- Produces: an importable `classifier` package and a working `pytest` + `pytest-asyncio` toolchain.

- [ ] **Step 1: Write the failing test**

`tests/test_smoke.py`:
```python
import importlib


def test_classifier_package_importable():
    assert importlib.import_module("classifier") is not None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_smoke.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'classifier'` (package/deps not present yet).

- [ ] **Step 3: Create the package + config files**

`pyproject.toml`:
```toml
[project]
name = "market-candidate-classifier"
version = "0.1.0"
description = "Classifies X topics as CREATE/WAIT/REJECT for prediction-market creation."
requires-python = ">=3.11"
dependencies = []

[project.optional-dependencies]
grok = ["openai>=1.40"]
dev = ["pytest>=8", "pytest-asyncio>=0.23", "ruff>=0.5"]

[tool.pytest.ini_options]
asyncio_mode = "auto"
testpaths = ["tests"]

[build-system]
requires = ["setuptools>=68"]
build-backend = "setuptools.build_meta"

[tool.setuptools.packages.find]
where = ["."]
include = ["classifier*"]
```

Create empty `classifier/__init__.py`, `classifier/semantic/__init__.py`, `tests/__init__.py`.

Append to `.gitignore`:
```gitignore
# Python
__pycache__/
*.py[cod]
.venv/
venv/
.pytest_cache/
*.egg-info/
.ruff_cache/
```

- [ ] **Step 4: Install dev deps and run the test to verify it passes**

Run:
```bash
python -m venv .venv && . .venv/bin/activate && pip install -e ".[dev]" && python -m pytest tests/test_smoke.py -v
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add pyproject.toml classifier/__init__.py classifier/semantic/__init__.py tests/__init__.py tests/test_smoke.py .gitignore
git commit -m "chore: scaffold market-candidate-classifier python package"
```

---

### Task 2: Domain models

**Files:**
- Create: `classifier/models.py`
- Test: `tests/test_models.py`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `clamp01(x: float) -> float`
  - `Decision = Literal["CREATE", "WAIT", "REJECT"]`
  - `CandidateTopic(topic_id, topic_name, representative_posts=[], post_count=None, unique_author_count=None, engagement_count=None, impression_count=None, volume_velocity=None, volume_growth=None, topic_age_minutes=None, metadata={})` — frozen dataclass.
  - `SemanticFeatures(eventness, resolvability, unresolvedness, subjectivity, specificity, canonical_event=None, reasoning_summary=None)` — frozen; the five floats clamped to 0–1.
  - `NumericFeatures(attention, velocity, engagement, diversity, freshness)` — frozen; all clamped to 0–1.
  - `ClassificationResult(decision, score, canonical_event, query, semantic_features, numeric_features, reasons=[])` — frozen.

- [ ] **Step 1: Write the failing test**

`tests/test_models.py`:
```python
import pytest
from classifier.models import (
    clamp01, CandidateTopic, SemanticFeatures, NumericFeatures, ClassificationResult,
)


def test_clamp01_bounds():
    assert clamp01(-0.5) == 0.0
    assert clamp01(1.7) == 1.0
    assert clamp01(0.42) == 0.42


def test_candidate_optional_fields_default_none():
    c = CandidateTopic(topic_id="t1", topic_name="Warriors vs Lakers")
    assert c.post_count is None
    assert c.representative_posts == []
    assert c.metadata == {}


def test_semantic_features_clamped():
    s = SemanticFeatures(eventness=1.4, resolvability=-0.2, unresolvedness=0.9,
                         subjectivity=0.1, specificity=0.5)
    assert s.eventness == 1.0
    assert s.resolvability == 0.0
    assert s.unresolvedness == 0.9


def test_numeric_features_clamped():
    n = NumericFeatures(attention=2.0, velocity=-1.0, engagement=0.3,
                        diversity=0.5, freshness=0.8)
    assert n.attention == 1.0
    assert n.velocity == 0.0


def test_models_are_frozen():
    c = CandidateTopic(topic_id="t1", topic_name="x")
    with pytest.raises(Exception):
        c.topic_id = "t2"  # type: ignore[misc]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_models.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'classifier.models'`.

- [ ] **Step 3: Write minimal implementation**

`classifier/models.py`:
```python
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

Decision = Literal["CREATE", "WAIT", "REJECT"]


def clamp01(x: float) -> float:
    """Clamp a value into the inclusive range [0.0, 1.0]."""
    x = float(x)
    if x < 0.0:
        return 0.0
    if x > 1.0:
        return 1.0
    return x


@dataclass(frozen=True)
class CandidateTopic:
    """Normalized, X-agnostic description of a topic to be classified."""

    topic_id: str
    topic_name: str
    representative_posts: list[str] = field(default_factory=list)
    post_count: int | None = None
    unique_author_count: int | None = None
    engagement_count: int | None = None
    impression_count: int | None = None
    volume_velocity: float | None = None
    volume_growth: float | None = None
    topic_age_minutes: float | None = None
    metadata: dict = field(default_factory=dict)


@dataclass(frozen=True)
class SemanticFeatures:
    """Semantic judgments about a topic; the five scores are clamped to 0..1."""

    eventness: float
    resolvability: float
    unresolvedness: float
    subjectivity: float
    specificity: float
    canonical_event: str | None = None
    reasoning_summary: str | None = None

    def __post_init__(self) -> None:
        for name in ("eventness", "resolvability", "unresolvedness",
                     "subjectivity", "specificity"):
            object.__setattr__(self, name, clamp01(getattr(self, name)))


@dataclass(frozen=True)
class NumericFeatures:
    """Normalized deterministic signals; all values clamped to 0..1."""

    attention: float
    velocity: float
    engagement: float
    diversity: float
    freshness: float

    def __post_init__(self) -> None:
        for name in ("attention", "velocity", "engagement", "diversity", "freshness"):
            object.__setattr__(self, name, clamp01(getattr(self, name)))


@dataclass(frozen=True)
class ClassificationResult:
    """Structured output of the classifier."""

    decision: Decision
    score: float
    canonical_event: str | None
    query: str | None
    semantic_features: SemanticFeatures
    numeric_features: NumericFeatures
    reasons: list[str] = field(default_factory=list)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_models.py -v`
Expected: PASS (all 5 tests).

- [ ] **Step 5: Commit**

```bash
git add classifier/models.py tests/test_models.py
git commit -m "feat: add typed domain models with 0-1 clamping"
```

---

### Task 3: Configuration

**Files:**
- Create: `classifier/config.py`
- Test: `tests/test_config.py`

**Interfaces:**
- Consumes: nothing.
- Produces: `ClassifierConfig` frozen dataclass with defaults. Fields used by later tasks:
  - Weights: `attention_weight, velocity_weight, engagement_weight, eventness_weight, resolvability_weight, unresolvedness_weight, specificity_weight, subjectivity_penalty`
  - Thresholds: `create_threshold, wait_threshold`
  - Gates: `min_eventness, min_resolvability, min_unresolvedness, min_specificity_for_create`
  - Normalization: `attention_saturation_posts, velocity_saturation, growth_saturation, engagement_saturation, freshness_halflife_minutes, impression_saturation`
  - Missing-feature policy: `missing_feature_value`

- [ ] **Step 1: Write the failing test**

`tests/test_config.py`:
```python
from classifier.config import ClassifierConfig


def test_defaults_present_and_ordered():
    cfg = ClassifierConfig()
    # thresholds must be strictly ordered
    assert 0.0 < cfg.wait_threshold < cfg.create_threshold <= 1.0
    # positive scoring weights sum to 1.0 (keeps the normalized score intuitive)
    positive = (cfg.attention_weight + cfg.velocity_weight + cfg.engagement_weight
                + cfg.eventness_weight + cfg.resolvability_weight
                + cfg.unresolvedness_weight + cfg.specificity_weight)
    assert abs(positive - 1.0) < 1e-9


def test_config_is_overridable():
    cfg = ClassifierConfig(create_threshold=0.8)
    assert cfg.create_threshold == 0.8
    assert ClassifierConfig().create_threshold != 0.8  # default untouched
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_config.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'classifier.config'`.

- [ ] **Step 3: Write minimal implementation**

`classifier/config.py`:
```python
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class ClassifierConfig:
    """All tunables for the classifier. Nothing is hardcoded elsewhere."""

    # --- scoring weights (positive terms sum to 1.0) ---
    attention_weight: float = 0.10
    velocity_weight: float = 0.15
    engagement_weight: float = 0.10
    eventness_weight: float = 0.20
    resolvability_weight: float = 0.20
    unresolvedness_weight: float = 0.15
    specificity_weight: float = 0.10
    subjectivity_penalty: float = 0.25

    # --- decision thresholds (applied to the normalized 0..1 score) ---
    create_threshold: float = 0.62
    wait_threshold: float = 0.40

    # --- hard gates (a failure forces REJECT regardless of popularity) ---
    min_eventness: float = 0.50
    min_resolvability: float = 0.50
    min_unresolvedness: float = 0.35
    # specificity below this downgrades an otherwise-CREATE candidate to WAIT
    min_specificity_for_create: float = 0.45

    # --- normalization saturation constants (feature value that maps to ~0.5) ---
    attention_saturation_posts: float = 5000.0
    velocity_saturation: float = 200.0
    growth_saturation: float = 3.0
    engagement_saturation: float = 50000.0
    freshness_halflife_minutes: float = 720.0
    impression_saturation: float = 1_000_000.0

    # --- how a missing (None) deterministic feature normalizes ---
    missing_feature_value: float = 0.0
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_config.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add classifier/config.py tests/test_config.py
git commit -m "feat: add ClassifierConfig with tunable weights, gates, thresholds"
```

---

### Task 4: Numeric feature extraction + normalization

**Files:**
- Create: `classifier/numeric_features.py`
- Test: `tests/test_numeric_features.py`

**Interfaces:**
- Consumes: `CandidateTopic`, `NumericFeatures`, `clamp01` (Task 2); `ClassifierConfig` (Task 3).
- Produces: `extract_numeric_features(candidate: CandidateTopic, config: ClassifierConfig | None = None) -> NumericFeatures`.

- [ ] **Step 1: Write the failing test**

`tests/test_numeric_features.py`:
```python
from classifier.models import CandidateTopic
from classifier.config import ClassifierConfig
from classifier.numeric_features import extract_numeric_features


def test_missing_fields_use_missing_value():
    cfg = ClassifierConfig(missing_feature_value=0.0)
    n = extract_numeric_features(CandidateTopic(topic_id="t", topic_name="x"), cfg)
    assert n.attention == 0.0
    assert n.velocity == 0.0
    assert n.engagement == 0.0
    assert n.diversity == 0.0
    assert n.freshness == 0.0


def test_saturation_is_monotonic_and_bounded():
    cfg = ClassifierConfig()
    low = extract_numeric_features(
        CandidateTopic(topic_id="t", topic_name="x", post_count=100), cfg)
    high = extract_numeric_features(
        CandidateTopic(topic_id="t", topic_name="x", post_count=100_000), cfg)
    assert 0.0 <= low.attention < high.attention <= 1.0


def test_diversity_is_author_ratio_when_post_count_present():
    cfg = ClassifierConfig()
    n = extract_numeric_features(
        CandidateTopic(topic_id="t", topic_name="x",
                       post_count=100, unique_author_count=80), cfg)
    assert abs(n.diversity - 0.8) < 1e-9


def test_freshness_decays_with_age():
    cfg = ClassifierConfig()
    young = extract_numeric_features(
        CandidateTopic(topic_id="t", topic_name="x", topic_age_minutes=10), cfg)
    old = extract_numeric_features(
        CandidateTopic(topic_id="t", topic_name="x", topic_age_minutes=5000), cfg)
    assert young.freshness > old.freshness


def test_velocity_blends_velocity_and_growth():
    cfg = ClassifierConfig()
    vel_only = extract_numeric_features(
        CandidateTopic(topic_id="t", topic_name="x", volume_velocity=200), cfg)
    vel_and_growth = extract_numeric_features(
        CandidateTopic(topic_id="t", topic_name="x",
                       volume_velocity=200, volume_growth=3.0), cfg)
    assert 0.0 < vel_only.velocity <= 1.0
    assert 0.0 < vel_and_growth.velocity <= 1.0
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_numeric_features.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'classifier.numeric_features'`.

- [ ] **Step 3: Write minimal implementation**

`classifier/numeric_features.py`:
```python
from __future__ import annotations

import math

from .config import ClassifierConfig
from .models import CandidateTopic, NumericFeatures, clamp01


def _sat(value: float | None, k: float) -> float | None:
    """Saturating normalization value/(value+k) in [0,1); None if value absent."""
    if value is None:
        return None
    v = max(0.0, float(value))
    if k <= 0:
        return 1.0
    return v / (v + k)


def _mean(parts: list[float]) -> float:
    return sum(parts) / len(parts)


def _attention(c: CandidateTopic, cfg: ClassifierConfig) -> float:
    posts = _sat(c.post_count, cfg.attention_saturation_posts)
    impr = _sat(c.impression_count, cfg.impression_saturation)
    parts = [p for p in (posts, impr) if p is not None]
    return clamp01(_mean(parts)) if parts else cfg.missing_feature_value


def _velocity(c: CandidateTopic, cfg: ClassifierConfig) -> float:
    vel = _sat(c.volume_velocity, cfg.velocity_saturation)
    grow = _sat(c.volume_growth, cfg.growth_saturation)
    if vel is not None and grow is not None:
        return clamp01(0.7 * vel + 0.3 * grow)
    if vel is not None:
        return clamp01(vel)
    if grow is not None:
        return clamp01(grow)
    return cfg.missing_feature_value


def _engagement(c: CandidateTopic, cfg: ClassifierConfig) -> float:
    e = _sat(c.engagement_count, cfg.engagement_saturation)
    return clamp01(e) if e is not None else cfg.missing_feature_value


def _diversity(c: CandidateTopic, cfg: ClassifierConfig) -> float:
    if c.unique_author_count is None:
        return cfg.missing_feature_value
    if c.post_count and c.post_count > 0:
        return clamp01(c.unique_author_count / c.post_count)
    sat = _sat(c.unique_author_count, cfg.attention_saturation_posts)
    return clamp01(sat) if sat is not None else cfg.missing_feature_value


def _freshness(c: CandidateTopic, cfg: ClassifierConfig) -> float:
    if c.topic_age_minutes is None:
        return cfg.missing_feature_value
    age = max(0.0, float(c.topic_age_minutes))
    return clamp01(math.exp(-age / cfg.freshness_halflife_minutes))


def extract_numeric_features(
    candidate: CandidateTopic, config: ClassifierConfig | None = None
) -> NumericFeatures:
    """Convert deterministic X-derived signals into normalized 0..1 features.

    Every field is optional; a missing field normalizes to
    ``config.missing_feature_value`` rather than raising.
    """
    cfg = config or ClassifierConfig()
    return NumericFeatures(
        attention=_attention(candidate, cfg),
        velocity=_velocity(candidate, cfg),
        engagement=_engagement(candidate, cfg),
        diversity=_diversity(candidate, cfg),
        freshness=_freshness(candidate, cfg),
    )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_numeric_features.py -v`
Expected: PASS (all 5 tests).

- [ ] **Step 5: Commit**

```bash
git add classifier/numeric_features.py tests/test_numeric_features.py
git commit -m "feat: add normalized numeric feature extraction"
```

---

### Task 5: Scoring + query builder

**Files:**
- Create: `classifier/scoring.py`
- Test: `tests/test_scoring.py`

**Interfaces:**
- Consumes: `NumericFeatures`, `SemanticFeatures`, `CandidateTopic`, `clamp01` (Task 2); `ClassifierConfig` (Task 3).
- Produces:
  - `marketability_score(numeric: NumericFeatures, semantic: SemanticFeatures, config: ClassifierConfig | None = None) -> float` (returns 0..1).
  - `build_query(semantic: SemanticFeatures, candidate: CandidateTopic) -> str | None`.

- [ ] **Step 1: Write the failing test**

`tests/test_scoring.py`:
```python
from classifier.models import NumericFeatures, SemanticFeatures, CandidateTopic
from classifier.config import ClassifierConfig
from classifier.scoring import marketability_score, build_query


def _strong_numeric():
    return NumericFeatures(attention=0.7, velocity=0.8, engagement=0.7,
                           diversity=0.6, freshness=0.7)


def test_score_in_unit_range():
    s = marketability_score(_strong_numeric(),
                            SemanticFeatures(0.9, 0.95, 0.9, 0.1, 0.85))
    assert 0.0 <= s <= 1.0
    assert s > 0.6


def test_subjectivity_penalizes_score():
    numeric = _strong_numeric()
    low_subj = marketability_score(numeric, SemanticFeatures(0.9, 0.9, 0.9, 0.0, 0.8))
    high_subj = marketability_score(numeric, SemanticFeatures(0.9, 0.9, 0.9, 1.0, 0.8))
    assert low_subj > high_subj


def test_build_query_strips_stopwords_and_punctuation():
    s = SemanticFeatures(0.9, 0.9, 0.9, 0.1, 0.9,
                         canonical_event="Golden State Warriors vs Los Angeles Lakers, Aug 8 2026")
    q = build_query(s, CandidateTopic(topic_id="t", topic_name="ignored"))
    assert q == "Golden State Warriors Los Angeles Lakers Aug 8 2026"
    assert "?" not in q and "vs" not in q.split()


def test_build_query_falls_back_to_topic_name():
    s = SemanticFeatures(0.9, 0.9, 0.9, 0.1, 0.9, canonical_event=None)
    q = build_query(s, CandidateTopic(topic_id="t", topic_name="Fed rate decision"))
    assert q == "Fed rate decision"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_scoring.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'classifier.scoring'`.

- [ ] **Step 3: Write minimal implementation**

`classifier/scoring.py`:
```python
from __future__ import annotations

import re

from .config import ClassifierConfig
from .models import CandidateTopic, NumericFeatures, SemanticFeatures, clamp01

_STOPWORDS = {
    "the", "a", "an", "will", "is", "are", "be", "to", "of", "on", "in",
    "at", "vs", "versus", "and", "or", "game", "match", "for",
}


def marketability_score(
    numeric: NumericFeatures,
    semantic: SemanticFeatures,
    config: ClassifierConfig | None = None,
) -> float:
    """Weighted, subjectivity-penalized marketability score in [0, 1]."""
    cfg = config or ClassifierConfig()
    raw = (
        cfg.attention_weight * numeric.attention
        + cfg.velocity_weight * numeric.velocity
        + cfg.engagement_weight * numeric.engagement
        + cfg.eventness_weight * semantic.eventness
        + cfg.resolvability_weight * semantic.resolvability
        + cfg.unresolvedness_weight * semantic.unresolvedness
        + cfg.specificity_weight * semantic.specificity
    )
    positive_weight_sum = (
        cfg.attention_weight + cfg.velocity_weight + cfg.engagement_weight
        + cfg.eventness_weight + cfg.resolvability_weight
        + cfg.unresolvedness_weight + cfg.specificity_weight
    )
    normalized = raw / positive_weight_sum if positive_weight_sum > 0 else 0.0
    penalty = cfg.subjectivity_penalty * semantic.subjectivity
    return clamp01(normalized - penalty)


def build_query(semantic: SemanticFeatures, candidate: CandidateTopic) -> str | None:
    """Concise canonical search query (never a question) for the downstream layer."""
    source = semantic.canonical_event or candidate.topic_name
    if not source:
        return None
    tokens = re.findall(r"[A-Za-z0-9]+", source)
    kept = [t for t in tokens if t.lower() not in _STOPWORDS]
    query = " ".join(kept) if kept else " ".join(tokens)
    return query or None
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_scoring.py -v`
Expected: PASS (all 4 tests).

- [ ] **Step 5: Commit**

```bash
git add classifier/scoring.py tests/test_scoring.py
git commit -m "feat: add weighted marketability scoring and query builder"
```

---

### Task 6: Hard gates

**Files:**
- Create: `classifier/gates.py`
- Test: `tests/test_gates.py`

**Interfaces:**
- Consumes: `SemanticFeatures` (Task 2); `ClassifierConfig` (Task 3).
- Produces: `check_hard_gates(semantic: SemanticFeatures, config: ClassifierConfig | None = None) -> list[str]` — returns human-readable failure reasons; empty list means all gates pass.

- [ ] **Step 1: Write the failing test**

`tests/test_gates.py`:
```python
from classifier.models import SemanticFeatures
from classifier.config import ClassifierConfig
from classifier.gates import check_hard_gates


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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_gates.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'classifier.gates'`.

- [ ] **Step 3: Write minimal implementation**

`classifier/gates.py`:
```python
from __future__ import annotations

from .config import ClassifierConfig
from .models import SemanticFeatures


def check_hard_gates(
    semantic: SemanticFeatures, config: ClassifierConfig | None = None
) -> list[str]:
    """Return reasons any hard gate failed. Empty list means all gates pass.

    A non-empty result forces REJECT regardless of attention/engagement.
    """
    cfg = config or ClassifierConfig()
    failures: list[str] = []
    if semantic.eventness < cfg.min_eventness:
        failures.append(
            f"eventness {semantic.eventness:.2f} < min {cfg.min_eventness:.2f} "
            "(not a concrete real-world event)"
        )
    if semantic.resolvability < cfg.min_resolvability:
        failures.append(
            f"resolvability {semantic.resolvability:.2f} < min {cfg.min_resolvability:.2f} "
            "(outcome not objectively determinable)"
        )
    if semantic.unresolvedness < cfg.min_unresolvedness:
        failures.append(
            f"unresolvedness {semantic.unresolvedness:.2f} < min {cfg.min_unresolvedness:.2f} "
            "(outcome already known/resolved)"
        )
    return failures
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_gates.py -v`
Expected: PASS (all 4 tests).

- [ ] **Step 5: Commit**

```bash
git add classifier/gates.py tests/test_gates.py
git commit -m "feat: add hard gates for eventness/resolvability/unresolvedness"
```

---

### Task 7: Semantic interface + fake implementation

**Files:**
- Create: `classifier/semantic/base.py`
- Create: `classifier/semantic/fake.py`
- Test: `tests/test_semantic_fake.py`

**Interfaces:**
- Consumes: `CandidateTopic`, `SemanticFeatures` (Task 2).
- Produces:
  - `SemanticClassifier` — abstract base with `async def classify(self, candidate: CandidateTopic) -> SemanticFeatures`.
  - `FakeSemanticClassifier(features_by_topic_id: dict[str, SemanticFeatures] | None = None, default: SemanticFeatures | None = None)` — returns preset features per `topic_id`, else `default`.

- [ ] **Step 1: Write the failing test**

`tests/test_semantic_fake.py`:
```python
import pytest
from classifier.models import CandidateTopic, SemanticFeatures
from classifier.semantic.base import SemanticClassifier
from classifier.semantic.fake import FakeSemanticClassifier


async def test_fake_returns_preset_by_topic_id():
    preset = SemanticFeatures(0.9, 0.9, 0.9, 0.1, 0.8, canonical_event="E")
    fake = FakeSemanticClassifier(features_by_topic_id={"t1": preset})
    got = await fake.classify(CandidateTopic(topic_id="t1", topic_name="x"))
    assert got is preset


async def test_fake_returns_default_when_unknown():
    default = SemanticFeatures(0.4, 0.4, 0.4, 0.5, 0.3)
    fake = FakeSemanticClassifier(default=default)
    got = await fake.classify(CandidateTopic(topic_id="unknown", topic_name="x"))
    assert got is default


def test_fake_is_a_semantic_classifier():
    assert isinstance(FakeSemanticClassifier(), SemanticClassifier)


def test_base_cannot_be_instantiated():
    with pytest.raises(TypeError):
        SemanticClassifier()  # type: ignore[abstract]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_semantic_fake.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'classifier.semantic.base'`.

- [ ] **Step 3: Write minimal implementation**

`classifier/semantic/base.py`:
```python
from __future__ import annotations

from abc import ABC, abstractmethod

from ..models import CandidateTopic, SemanticFeatures


class SemanticClassifier(ABC):
    """Interface the classifier depends on for semantic judgments.

    Implementations must not leak transport/SDK details to callers.
    """

    @abstractmethod
    async def classify(self, candidate: CandidateTopic) -> SemanticFeatures:
        """Return semantic features for the given candidate topic."""
        raise NotImplementedError
```

`classifier/semantic/fake.py`:
```python
from __future__ import annotations

from ..models import CandidateTopic, SemanticFeatures
from .base import SemanticClassifier


class FakeSemanticClassifier(SemanticClassifier):
    """Deterministic semantic classifier for tests and offline demos."""

    def __init__(
        self,
        features_by_topic_id: dict[str, SemanticFeatures] | None = None,
        default: SemanticFeatures | None = None,
    ) -> None:
        self._by_id = features_by_topic_id or {}
        self._default = default or SemanticFeatures(
            eventness=0.5, resolvability=0.5, unresolvedness=0.5,
            subjectivity=0.5, specificity=0.5,
            canonical_event=None, reasoning_summary="fake default",
        )

    async def classify(self, candidate: CandidateTopic) -> SemanticFeatures:
        return self._by_id.get(candidate.topic_id, self._default)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_semantic_fake.py -v`
Expected: PASS (all 4 tests).

- [ ] **Step 5: Commit**

```bash
git add classifier/semantic/base.py classifier/semantic/fake.py tests/test_semantic_fake.py
git commit -m "feat: add semantic classifier interface and fake implementation"
```

---

### Task 8: Classifier orchestration + spec scenarios

**Files:**
- Create: `classifier/classifier.py`
- Modify: `classifier/__init__.py` (public exports)
- Test: `tests/test_classifier.py`

**Interfaces:**
- Consumes: everything from Tasks 2–7 (`extract_numeric_features`, `marketability_score`, `build_query`, `check_hard_gates`, `SemanticClassifier`).
- Produces:
  - `MarketCandidateClassifier(semantic_classifier: SemanticClassifier, config: ClassifierConfig | None = None)` with `async def classify(self, candidate: CandidateTopic) -> ClassificationResult`.
  - Package re-exports from `classifier/__init__.py`: `CandidateTopic, SemanticFeatures, NumericFeatures, ClassificationResult, ClassifierConfig, SemanticClassifier, FakeSemanticClassifier, MarketCandidateClassifier`.

- [ ] **Step 1: Write the failing test (the 5 spec scenarios + missing-features robustness)**

`tests/test_classifier.py`:
```python
from classifier import (
    CandidateTopic, SemanticFeatures, ClassifierConfig,
    FakeSemanticClassifier, MarketCandidateClassifier,
)


def _make(topic_id, semantic, **candidate_kwargs):
    fake = FakeSemanticClassifier(features_by_topic_id={topic_id: semantic})
    clf = MarketCandidateClassifier(semantic_classifier=fake, config=ClassifierConfig())
    cand = CandidateTopic(topic_id=topic_id, **candidate_kwargs)
    return clf, cand


async def test_create_warriors_vs_lakers_tonight():
    semantic = SemanticFeatures(eventness=0.9, resolvability=0.95, unresolvedness=0.9,
                                subjectivity=0.1, specificity=0.85,
                                canonical_event="Golden State Warriors vs Los Angeles Lakers, Aug 8 2026")
    clf, cand = _make(
        "warriors_lakers", semantic,
        topic_name="Warriors vs Lakers game tonight",
        representative_posts=["warriors lakers tonight", "huge game"],
        post_count=8000, unique_author_count=5000, engagement_count=60000,
        volume_velocity=250, volume_growth=2.5, topic_age_minutes=120,
    )
    result = await clf.classify(cand)
    assert result.decision == "CREATE"
    assert result.query and "?" not in result.query
    assert result.canonical_event == semantic.canonical_event


async def test_reject_subjective_opinion():
    semantic = SemanticFeatures(eventness=0.15, resolvability=0.1, unresolvedness=0.8,
                                subjectivity=0.95, specificity=0.3)
    clf, cand = _make(
        "goat", semantic,
        topic_name="Steph Curry is the GOAT",
        post_count=50000, engagement_count=900000, volume_velocity=800,
    )
    result = await clf.classify(cand)
    assert result.decision == "REJECT"
    assert any("eventness" in r for r in result.reasons)


async def test_reject_already_resolved():
    semantic = SemanticFeatures(eventness=0.9, resolvability=0.95, unresolvedness=0.05,
                                subjectivity=0.1, specificity=0.9)
    clf, cand = _make(
        "final_score", semantic,
        topic_name="Warriors defeated Lakers 118-109",
        post_count=40000, engagement_count=500000, volume_velocity=600,
    )
    result = await clf.classify(cand)
    assert result.decision == "REJECT"
    assert any("unresolvedness" in r for r in result.reasons)


async def test_wait_low_specificity():
    semantic = SemanticFeatures(eventness=0.55, resolvability=0.55, unresolvedness=0.9,
                                subjectivity=0.3, specificity=0.2)
    clf, cand = _make(
        "openai_cooking", semantic,
        topic_name="OpenAI is cooking something huge",
        post_count=3000, engagement_count=40000,
        volume_velocity=180, volume_growth=2.8, topic_age_minutes=60,
    )
    result = await clf.classify(cand)
    assert result.decision == "WAIT"
    assert any("specificity" in r for r in result.reasons)


async def test_create_despite_informal_language():
    # Informal wording, but the semantic layer recognizes a strong, objectively
    # resolvable prediction (low subjectivity) and the topic is genuinely active,
    # so it clears create_threshold -> CREATE. (Fixture calibrated so the real
    # normalized numeric features, not guessed ones, land the score above 0.62.)
    semantic = SemanticFeatures(eventness=0.85, resolvability=0.9, unresolvedness=0.9,
                                subjectivity=0.25, specificity=0.75,
                                canonical_event="Stephen Curry scoring 40+ points in an upcoming game")
    clf, cand = _make(
        "curry_40", semantic,
        topic_name="curry going crazy tonight",
        representative_posts=["steph dropping 40 tonight", "40 piece incoming",
                              "curry going crazy tonight"],
        post_count=7000, unique_author_count=4000, engagement_count=70000,
        volume_velocity=220, volume_growth=2.0, topic_age_minutes=90,
    )
    result = await clf.classify(cand)
    assert result.decision == "CREATE"
    assert result.query


async def test_wait_when_score_high_but_specificity_low():
    # Isolates the specificity gate: the score alone clears create_threshold,
    # but low specificity must still downgrade CREATE -> WAIT.
    semantic = SemanticFeatures(eventness=0.9, resolvability=0.9, unresolvedness=0.9,
                                subjectivity=0.1, specificity=0.3)
    clf, cand = _make(
        "high_score_low_spec", semantic,
        topic_name="something huge is definitely happening",
        post_count=100000, unique_author_count=60000, engagement_count=500000,
        volume_velocity=1000, volume_growth=5.0, topic_age_minutes=30,
    )
    result = await clf.classify(cand)
    assert result.score >= ClassifierConfig().create_threshold  # score alone would qualify
    assert result.decision == "WAIT"
    assert result.query is None
    assert any("specificity" in r for r in result.reasons)


async def test_missing_features_do_not_raise():
    semantic = SemanticFeatures(0.9, 0.9, 0.9, 0.1, 0.8, canonical_event="Some event")
    clf, cand = _make("bare", semantic, topic_name="bare topic")  # no numeric fields
    result = await clf.classify(cand)
    # strong semantics but zero activity signal -> not enough to CREATE -> WAIT
    assert result.decision == "WAIT"
    assert any("missing X features" in r for r in result.reasons)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_classifier.py -v`
Expected: FAIL — `ImportError` for `MarketCandidateClassifier` (not yet exported/implemented).

- [ ] **Step 3: Write minimal implementation**

`classifier/classifier.py`:
```python
from __future__ import annotations

from .config import ClassifierConfig
from .gates import check_hard_gates
from .models import CandidateTopic, ClassificationResult
from .numeric_features import extract_numeric_features
from .scoring import build_query, marketability_score
from .semantic.base import SemanticClassifier

_OPTIONAL_FIELDS = (
    "post_count", "unique_author_count", "engagement_count", "impression_count",
    "volume_velocity", "volume_growth", "topic_age_minutes",
)


class MarketCandidateClassifier:
    """Classify a CandidateTopic as CREATE / WAIT / REJECT.

    Dependencies are injected; this component never calls X or Grok directly.
    """

    def __init__(
        self,
        semantic_classifier: SemanticClassifier,
        config: ClassifierConfig | None = None,
    ) -> None:
        self._semantic = semantic_classifier
        self._config = config or ClassifierConfig()

    async def classify(self, candidate: CandidateTopic) -> ClassificationResult:
        cfg = self._config
        reasons: list[str] = []

        numeric = extract_numeric_features(candidate, cfg)
        semantic = await self._semantic.classify(candidate)
        canonical = semantic.canonical_event

        missing = [f for f in _OPTIONAL_FIELDS if getattr(candidate, f) is None]
        if missing:
            reasons.append(
                "missing X features (treated as low signal): " + ", ".join(missing)
            )

        score = marketability_score(numeric, semantic, cfg)

        gate_failures = check_hard_gates(semantic, cfg)
        if gate_failures:
            reasons.extend(gate_failures)
            reasons.append("hard gate failed -> REJECT regardless of attention")
            return ClassificationResult(
                decision="REJECT", score=score, canonical_event=canonical,
                query=None, semantic_features=semantic, numeric_features=numeric,
                reasons=reasons,
            )

        reasons.append(f"passed hard gates; marketability score {score:.2f}")

        if score >= cfg.create_threshold and semantic.specificity >= cfg.min_specificity_for_create:
            reasons.append(
                f"score >= create_threshold {cfg.create_threshold:.2f} and "
                f"specificity >= {cfg.min_specificity_for_create:.2f} -> CREATE"
            )
            return ClassificationResult(
                decision="CREATE", score=score, canonical_event=canonical,
                query=build_query(semantic, candidate),
                semantic_features=semantic, numeric_features=numeric, reasons=reasons,
            )

        if score >= cfg.wait_threshold:
            if semantic.specificity < cfg.min_specificity_for_create:
                reasons.append(
                    f"specificity {semantic.specificity:.2f} < "
                    f"{cfg.min_specificity_for_create:.2f} -> WAIT (need concrete info)"
                )
            else:
                reasons.append(
                    f"score < create_threshold {cfg.create_threshold:.2f} -> "
                    "WAIT (insufficient activity)"
                )
            return ClassificationResult(
                decision="WAIT", score=score, canonical_event=canonical,
                query=None, semantic_features=semantic, numeric_features=numeric,
                reasons=reasons,
            )

        reasons.append(
            f"score {score:.2f} < wait_threshold {cfg.wait_threshold:.2f} -> "
            "REJECT (extremely weak signal)"
        )
        return ClassificationResult(
            decision="REJECT", score=score, canonical_event=canonical,
            query=None, semantic_features=semantic, numeric_features=numeric,
            reasons=reasons,
        )
```

`classifier/__init__.py` (replace empty file):
```python
from .classifier import MarketCandidateClassifier
from .config import ClassifierConfig
from .models import (
    CandidateTopic,
    ClassificationResult,
    NumericFeatures,
    SemanticFeatures,
)
from .semantic.base import SemanticClassifier
from .semantic.fake import FakeSemanticClassifier

__all__ = [
    "CandidateTopic",
    "SemanticFeatures",
    "NumericFeatures",
    "ClassificationResult",
    "ClassifierConfig",
    "SemanticClassifier",
    "FakeSemanticClassifier",
    "MarketCandidateClassifier",
]
```

- [ ] **Step 4: Run the full suite to verify everything passes**

Run: `python -m pytest -v`
Expected: PASS — all scenario tests plus Tasks 2–7 tests green.

- [ ] **Step 5: Commit**

```bash
git add classifier/classifier.py classifier/__init__.py tests/test_classifier.py
git commit -m "feat: add MarketCandidateClassifier orchestration and spec scenario tests"
```

---

### Task 9: Grok semantic adapter

**Files:**
- Create: `classifier/semantic/grok.py`
- Test: `tests/test_grok_adapter.py`

**Interfaces:**
- Consumes: `CandidateTopic`, `SemanticFeatures`, `clamp01` (Task 2); `SemanticClassifier` (Task 7).
- Produces:
  - `GrokSemanticClassifier(*, api_key=None, model="grok-4-latest", base_url="https://api.x.ai/v1", client=None)` implementing the interface.
  - `_to_features(data: dict) -> SemanticFeatures` — pure parser, clamps values, coerces bad types to 0.0, maps empty strings to `None`.

- [ ] **Step 1: Write the failing test**

`tests/test_grok_adapter.py`:
```python
from classifier.models import CandidateTopic, SemanticFeatures
from classifier.semantic.base import SemanticClassifier
from classifier.semantic.grok import GrokSemanticClassifier, _to_features


def test_to_features_clamps_and_maps_empty_strings():
    data = {
        "eventness": 1.5, "resolvability": -0.2, "unresolvedness": 0.7,
        "subjectivity": "not-a-number", "specificity": 0.6,
        "canonical_event": "", "reasoning_summary": "because",
    }
    f = _to_features(data)
    assert f.eventness == 1.0
    assert f.resolvability == 0.0
    assert f.subjectivity == 0.0          # bad type coerced to 0.0
    assert f.canonical_event is None       # empty string -> None
    assert f.reasoning_summary == "because"


async def test_grok_uses_injected_client_and_parses_response():
    class _Msg:
        content = (
            '{"eventness":0.9,"resolvability":0.9,"unresolvedness":0.9,'
            '"subjectivity":0.1,"specificity":0.8,'
            '"canonical_event":"Some Event 2026","reasoning_summary":"ok"}'
        )

    class _Choice:
        message = _Msg()

    class _Resp:
        choices = [_Choice()]

    class _Completions:
        async def create(self, **kwargs):
            # assert we ask for deterministic, schema-constrained output
            assert kwargs["temperature"] == 0
            assert kwargs["response_format"]["type"] == "json_schema"
            return _Resp()

    class _Chat:
        completions = _Completions()

    class _FakeClient:
        chat = _Chat()

    grok = GrokSemanticClassifier(client=_FakeClient())
    assert isinstance(grok, SemanticClassifier)
    got = await grok.classify(CandidateTopic(topic_id="t", topic_name="x",
                                             representative_posts=["a", "b"]))
    assert isinstance(got, SemanticFeatures)
    assert got.eventness == 0.9
    assert got.canonical_event == "Some Event 2026"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_grok_adapter.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'classifier.semantic.grok'`.

- [ ] **Step 3: Write minimal implementation**

`classifier/semantic/grok.py`:
```python
from __future__ import annotations

import json
import os
from typing import Any

from ..models import CandidateTopic, SemanticFeatures, clamp01
from .base import SemanticClassifier

_SYSTEM = (
    "You evaluate whether an X (Twitter) conversation describes a concrete, "
    "objectively resolvable, currently-unresolved real-world event suitable for a "
    "prediction market. Informal or opinionated wording can still contain an "
    "objectively resolvable prediction (e.g. 'steph dropping 40 tonight' -> did the "
    "player score 40+ in the game?). Respond ONLY with strict JSON matching the schema."
)

_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": [
        "eventness", "resolvability", "unresolvedness", "subjectivity",
        "specificity", "canonical_event", "reasoning_summary",
    ],
    "properties": {
        "eventness": {"type": "number", "minimum": 0, "maximum": 1},
        "resolvability": {"type": "number", "minimum": 0, "maximum": 1},
        "unresolvedness": {"type": "number", "minimum": 0, "maximum": 1},
        "subjectivity": {"type": "number", "minimum": 0, "maximum": 1},
        "specificity": {"type": "number", "minimum": 0, "maximum": 1},
        "canonical_event": {"type": ["string", "null"]},
        "reasoning_summary": {"type": ["string", "null"]},
    },
}


def _to_features(data: dict) -> SemanticFeatures:
    """Pure, defensive parser: clamp scores, coerce bad types, empty str -> None."""
    def num(key: str) -> float:
        try:
            return clamp01(float(data.get(key, 0.0)))
        except (TypeError, ValueError):
            return 0.0

    def text(key: str) -> str | None:
        val = data.get(key)
        if val is None:
            return None
        val = str(val).strip()
        return val or None

    return SemanticFeatures(
        eventness=num("eventness"),
        resolvability=num("resolvability"),
        unresolvedness=num("unresolvedness"),
        subjectivity=num("subjectivity"),
        specificity=num("specificity"),
        canonical_event=text("canonical_event"),
        reasoning_summary=text("reasoning_summary"),
    )


class GrokSemanticClassifier(SemanticClassifier):
    """Semantic classifier backed by xAI Grok (OpenAI-compatible endpoint)."""

    def __init__(
        self,
        *,
        api_key: str | None = None,
        model: str = "grok-4-latest",
        base_url: str = "https://api.x.ai/v1",
        client: Any | None = None,
    ) -> None:
        self._model = model
        self._base_url = base_url
        self._api_key = api_key or os.environ.get("XAI_API_KEY") or os.environ.get("GROK_API_KEY")
        self._client = client

    def _get_client(self) -> Any:
        if self._client is None:
            if not self._api_key:
                raise RuntimeError("XAI_API_KEY / GROK_API_KEY not set")
            from openai import AsyncOpenAI  # lazy, optional dependency

            self._client = AsyncOpenAI(api_key=self._api_key, base_url=self._base_url)
        return self._client

    def _build_user_prompt(self, candidate: CandidateTopic) -> str:
        posts = "\n".join(f"- {p}" for p in candidate.representative_posts[:10])
        return (
            f"Topic: {candidate.topic_name}\n"
            f"Representative posts:\n{posts or '- (none)'}\n\n"
            "Score eventness, resolvability, unresolvedness, subjectivity, specificity "
            "in [0,1]. canonical_event is a NEUTRAL phrase describing the underlying "
            "real-world event (NOT a question), or null if none. reasoning_summary is one short sentence."
        )

    async def classify(self, candidate: CandidateTopic) -> SemanticFeatures:
        client = self._get_client()
        resp = await client.chat.completions.create(
            model=self._model,
            messages=[
                {"role": "system", "content": _SYSTEM},
                {"role": "user", "content": self._build_user_prompt(candidate)},
            ],
            response_format={
                "type": "json_schema",
                "json_schema": {"name": "semantic_features", "schema": _SCHEMA, "strict": True},
            },
            temperature=0,
        )
        content = resp.choices[0].message.content
        return _to_features(json.loads(content))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_grok_adapter.py -v`
Expected: PASS (both tests — no network, injected fake client).

- [ ] **Step 4b: Add an opt-in live Grok smoke test (skipped unless a key is present)**

Append to `tests/test_grok_adapter.py`:
```python
import os
import pytest


@pytest.mark.skipif(
    not (os.environ.get("XAI_API_KEY") or os.environ.get("GROK_API_KEY")),
    reason="no XAI_API_KEY/GROK_API_KEY in env — skipping live Grok call",
)
async def test_grok_live_smoke():
    # Opt-in: only runs when a key is exported (e.g. `set -a; source .env`) and
    # `pip install -e ".[grok]"` has been done. Makes one real, billable call.
    from classifier.semantic.grok import GrokSemanticClassifier

    grok = GrokSemanticClassifier()
    feats = await grok.classify(
        CandidateTopic(
            topic_id="live",
            topic_name="Warriors vs Lakers game tonight",
            representative_posts=["warriors lakers tonight", "steph vs lebron"],
        )
    )
    for v in (feats.eventness, feats.resolvability, feats.unresolvedness,
              feats.subjectivity, feats.specificity):
        assert 0.0 <= v <= 1.0
    # A concrete scheduled game should read as eventful and resolvable.
    assert feats.eventness > 0.5
    assert feats.resolvability > 0.5
```

Run (offline, confirms it SKIPS cleanly without a key):
`python -m pytest tests/test_grok_adapter.py -v`
Expected: the two mocked tests PASS, `test_grok_live_smoke` SKIPPED.

- [ ] **Step 5: Commit**

```bash
git add classifier/semantic/grok.py tests/test_grok_adapter.py
git commit -m "feat: add Grok semantic adapter with defensive parsing + opt-in live smoke test"
```

---

### Task 10: X ingestion client (budget-guarded)

**Files:**
- Create: `ingestion/__init__.py` (empty)
- Create: `ingestion/budget.py`
- Create: `ingestion/x_client.py`
- Modify: `pyproject.toml` (add `ingest`/`live` extras; include `ingestion*` in packages)
- Test: `tests/test_ingestion_budget.py`
- Test: `tests/test_x_client.py`

**Interfaces:**
- Consumes: `CandidateTopic` from the `classifier` package (Task 2/8).
- Produces:
  - `BudgetExceeded(RuntimeError)` and `RequestBudget(max_requests: int, per_endpoint_costs: dict[str,int] = {})` with `.spend(endpoint="", cost=None)`, `.spent`, `.remaining`.
  - `XIngestionClient(*, budget: RequestBudget, bearer_token: str|None=None, session=None, base_url="https://api.x.com", sleep=time.sleep, now=time.time, min_rate_limit_remaining=2)` with `fetch_counts(query) -> tuple[int, list[int]]`, `search_recent(query, max_results=100) -> list[dict]`, and `build_candidate_topic(*, topic_id, topic_name, query, max_posts=100, min_volume=0, representative_count=5) -> CandidateTopic | None`.

- [ ] **Step 1: Write the failing budget test**

`tests/test_ingestion_budget.py`:
```python
import pytest
from ingestion.budget import RequestBudget, BudgetExceeded


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
    # _spent is init=False, so it always starts at 0 and cannot be preset.
    with pytest.raises(TypeError):
        RequestBudget(max_requests=5, _spent=999)  # type: ignore[call-arg]
    assert RequestBudget(max_requests=5).spent == 0
```

- [ ] **Step 2: Run it to verify RED**

Run: `. .venv/bin/activate && python -m pytest tests/test_ingestion_budget.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'ingestion'`.

- [ ] **Step 3: Implement the budget**

`ingestion/__init__.py`: empty file.

`ingestion/budget.py`:
```python
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
    _spent: int = field(default=0, init=False)  # internal counter; never a constructor arg

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
```

- [ ] **Step 4: Run it to verify GREEN**

Run: `python -m pytest tests/test_ingestion_budget.py -v`
Expected: PASS (4 tests).

- [ ] **Step 5: Write the failing X-client test**

`tests/test_x_client.py`:
```python
from datetime import datetime, timezone

import pytest

from classifier import CandidateTopic
from ingestion.budget import RequestBudget, BudgetExceeded
from ingestion.x_client import XIngestionClient

_NOW = datetime(2026, 8, 8, 20, 0, tzinfo=timezone.utc).timestamp()

COUNTS = {
    "data": [{"tweet_count": 100}, {"tweet_count": 200}, {"tweet_count": 600}],
    "meta": {"total_tweet_count": 9000},
}
SEARCH = {
    "data": [
        {"id": "1", "text": "warriors lakers tonight", "author_id": "a1",
         "created_at": "2026-08-08T18:00:00.000Z",
         "public_metrics": {"like_count": 100, "reply_count": 10, "retweet_count": 20,
                            "quote_count": 5, "bookmark_count": 3, "impression_count": 0}},
        {"id": "2", "text": "steph going off", "author_id": "a2",
         "created_at": "2026-08-08T19:00:00.000Z",
         "public_metrics": {"like_count": 50, "reply_count": 2, "retweet_count": 4,
                            "quote_count": 1, "bookmark_count": 0, "impression_count": 0}},
        {"id": "3", "text": "dup author low engagement", "author_id": "a1",
         "created_at": "2026-08-08T19:30:00.000Z",
         "public_metrics": {"like_count": 5, "reply_count": 0, "retweet_count": 0,
                            "quote_count": 0, "bookmark_count": 0}},
    ]
}


class _Resp:
    def __init__(self, payload, status=200, headers=None, text=""):
        self._payload = payload
        self.status_code = status
        self.headers = headers or {"x-rate-limit-remaining": "100", "x-rate-limit-reset": "0"}
        self.text = text

    def json(self):
        return self._payload


class _FakeSession:
    def __init__(self, counts=COUNTS, search=SEARCH, headers=None):
        self._counts = counts
        self._search = search
        self._headers = headers
        self.calls = []

    def get(self, url, headers=None, params=None):
        self.calls.append((url, params))
        payload = self._counts if "counts/recent" in url else self._search
        return _Resp(payload, headers=self._headers)


def _client(session, budget=None, sleep=None):
    return XIngestionClient(
        budget=budget or RequestBudget(max_requests=10),
        bearer_token="fake-bearer",
        session=session,
        now=lambda: _NOW,
        sleep=sleep or (lambda s: None),
    )


def test_build_candidate_topic_derives_features():
    sess = _FakeSession()
    ct = _client(sess).build_candidate_topic(
        topic_id="t", topic_name="Warriors vs Lakers", query="warriors lakers")
    assert isinstance(ct, CandidateTopic)
    assert ct.post_count == 9000
    assert ct.unique_author_count == 2
    assert ct.engagement_count == 200            # 138 + 57 + 5, excludes impressions
    assert ct.impression_count is None           # all impressions 0 -> None
    assert ct.volume_velocity == 600.0           # last hourly bucket
    assert ct.volume_growth == 4.0               # 600 / mean(100,200)
    assert ct.topic_age_minutes == 120.0         # oldest post at 18:00Z vs now 20:00Z
    assert ct.representative_posts[0] == "warriors lakers tonight"  # highest engagement
    assert len(sess.calls) == 2                  # one counts + one search


def test_min_volume_prefilter_skips_expensive_search():
    sess = _FakeSession(counts={"data": [], "meta": {"total_tweet_count": 5}})
    ct = _client(sess).build_candidate_topic(
        topic_id="t", topic_name="tiny", query="tiny", min_volume=1000)
    assert ct is None
    assert len(sess.calls) == 1                  # search skipped -> cost saved


def test_budget_blocks_before_second_call():
    sess = _FakeSession()
    client = _client(sess, budget=RequestBudget(max_requests=1))
    with pytest.raises(BudgetExceeded):
        client.build_candidate_topic(topic_id="t", topic_name="x", query="x")
    assert len(sess.calls) == 1                  # counts spent the only unit


def test_low_rate_limit_triggers_backoff_sleep():
    slept = []
    sess = _FakeSession(headers={"x-rate-limit-remaining": "1",
                                 "x-rate-limit-reset": "9999999999"})
    client = XIngestionClient(budget=RequestBudget(10), bearer_token="b",
                              session=sess, now=lambda: 0.0, sleep=lambda s: slept.append(s))
    client.fetch_counts("q")
    assert slept and slept[0] > 0


def test_missing_bearer_raises_before_spending(monkeypatch):
    monkeypatch.delenv("X_BEARER_TOKEN", raising=False)
    budget = RequestBudget(10)
    client = XIngestionClient(budget=budget, bearer_token=None, session=_FakeSession())
    with pytest.raises(RuntimeError):
        client.fetch_counts("q")
    assert budget.spent == 0


def test_non_200_raises():
    class _ErrSession(_FakeSession):
        def get(self, url, headers=None, params=None):
            self.calls.append((url, params))
            return _Resp({}, status=429, text="rate limited")

    with pytest.raises(RuntimeError):
        _client(_ErrSession()).fetch_counts("q")


def test_counts_buckets_sorted_by_start():
    # Out-of-order buckets must be sorted oldest->newest so series[-1] is latest.
    counts = {"data": [
        {"start": "2026-08-08T19:00:00Z", "tweet_count": 600},
        {"start": "2026-08-08T17:00:00Z", "tweet_count": 100},
        {"start": "2026-08-08T18:00:00Z", "tweet_count": 200},
    ], "meta": {"total_tweet_count": 900}}
    total, series = _client(_FakeSession(counts=counts)).fetch_counts("q")
    assert total == 900
    assert series == [100, 200, 600]


def test_zero_engagement_is_measured_not_missing():
    # A sampled topic with genuinely zero engagement reports 0, not None.
    zero_search = {"data": [
        {"id": "1", "text": "quiet post", "author_id": "a1",
         "created_at": "2026-08-08T18:00:00.000Z",
         "public_metrics": {"like_count": 0, "reply_count": 0, "retweet_count": 0,
                            "quote_count": 0, "bookmark_count": 0, "impression_count": 0}},
    ]}
    ct = _client(_FakeSession(search=zero_search)).build_candidate_topic(
        topic_id="t", topic_name="quiet", query="quiet")
    assert ct.engagement_count == 0          # measured zero, NOT None
    assert ct.unique_author_count == 1
    assert ct.impression_count is None       # impressions still None when all zero
```

- [ ] **Step 6: Run it to verify RED**

Run: `python -m pytest tests/test_x_client.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'ingestion.x_client'`.

- [ ] **Step 7: Implement the X client**

`ingestion/x_client.py`:
```python
from __future__ import annotations

import os
import time
from datetime import datetime
from typing import Any, Callable

from classifier import CandidateTopic

from .budget import RequestBudget

_BASE_URL = "https://api.x.com"
_SEARCH_RECENT = "tweets/search/recent"
_COUNTS_RECENT = "tweets/counts/recent"


def _parse_iso(ts: str) -> datetime:
    # X returns e.g. "2026-08-08T19:06:00.000Z"; normalize 'Z' for fromisoformat.
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))


class XIngestionClient:
    """Read-only X ingestion (app-only bearer). Builds CandidateTopic from live data.

    Enforces a hard RequestBudget and honors x-rate-limit headers. Only touches
    read endpoints (search/recent, counts/recent); never writes and never calls
    search/all.
    """

    def __init__(
        self,
        *,
        budget: RequestBudget,
        bearer_token: str | None = None,
        session: Any | None = None,
        base_url: str = _BASE_URL,
        sleep: Callable[[float], None] = time.sleep,
        now: Callable[[], float] = time.time,
        min_rate_limit_remaining: int = 2,
    ) -> None:
        self._budget = budget
        self._bearer = bearer_token or os.environ.get("X_BEARER_TOKEN")
        self._session = session
        self._base_url = base_url.rstrip("/")
        self._sleep = sleep
        self._now = now
        self._min_remaining = min_rate_limit_remaining

    # --- transport ---

    def _get_session(self) -> Any:
        if self._session is None:
            import requests  # lazy, optional [ingest] dependency

            self._session = requests.Session()
        return self._session

    def _get(self, path: str, params: dict[str, Any], endpoint: str) -> dict:
        if not self._bearer:
            raise RuntimeError("X_BEARER_TOKEN not set")
        self._budget.spend(endpoint)
        resp = self._get_session().get(
            f"{self._base_url}/2/{path}",
            headers={"Authorization": f"Bearer {self._bearer}"},
            params=params,
        )
        self._respect_rate_limit(resp.headers)
        if resp.status_code != 200:
            raise RuntimeError(
                f"X API {endpoint} returned {resp.status_code}: {resp.text[:300]}"
            )
        return resp.json()

    def _respect_rate_limit(self, headers: Any) -> None:
        try:
            remaining = int(headers.get("x-rate-limit-remaining", "1"))
            reset = int(headers.get("x-rate-limit-reset", "0"))
        except (TypeError, ValueError):
            return
        if remaining <= self._min_remaining and reset:
            wait = max(0.0, reset - self._now())
            if wait > 0:
                self._sleep(wait)

    # --- endpoints ---

    def fetch_counts(self, query: str) -> tuple[int, list[int]]:
        """Return (total_tweet_count, hourly counts oldest->newest) for a query."""
        data = self._get(_COUNTS_RECENT, {"query": query, "granularity": "hour"}, "counts/recent")
        total = int(data.get("meta", {}).get("total_tweet_count", 0))
        # Do not trust response array order; sort by each bucket's start time so
        # series[-1] is genuinely the most recent hour (velocity/growth depend on it).
        buckets = sorted(data.get("data", []), key=lambda b: b.get("start", ""))
        series = [int(b.get("tweet_count", 0)) for b in buckets]
        return total, series

    def search_recent(self, query: str, max_results: int = 100) -> list[dict]:
        data = self._get(
            _SEARCH_RECENT,
            {
                "query": query,
                "max_results": max(10, min(100, max_results)),
                "tweet.fields": "created_at,public_metrics,author_id",
                "sort_order": "relevancy",
            },
            "search/recent",
        )
        return list(data.get("data", []))

    # --- orchestration ---

    def build_candidate_topic(
        self,
        *,
        topic_id: str,
        topic_name: str,
        query: str,
        max_posts: int = 100,
        min_volume: int = 0,
        representative_count: int = 5,
    ) -> CandidateTopic | None:
        """counts/recent (cheap pre-filter) -> search/recent -> derived CandidateTopic.

        Returns None when total volume is below ``min_volume`` (skips the more
        expensive search). Never raises on missing post fields.
        """
        total, series = self.fetch_counts(query)
        if total < min_volume:
            return None
        posts = self.search_recent(query, max_posts)

        authors: set[str] = set()
        engagement_total = 0
        impression_total = 0
        has_impressions = False
        scored: list[tuple[int, str]] = []
        oldest: float | None = None

        for p in posts:
            pm = p.get("public_metrics") or {}
            eng = sum(
                int(v) for k, v in pm.items()
                if k != "impression_count" and isinstance(v, (int, float))
            )
            engagement_total += eng
            if "impression_count" in pm:
                imp = int(pm.get("impression_count") or 0)
                impression_total += imp
                has_impressions = has_impressions or imp > 0
            author = p.get("author_id")
            if author:
                authors.add(str(author))
            text = p.get("text", "")
            if text:
                scored.append((eng, text))
            created = p.get("created_at")
            if created:
                try:
                    ts = _parse_iso(created).timestamp()
                    oldest = ts if oldest is None else min(oldest, ts)
                except ValueError:
                    pass

        scored.sort(key=lambda t: t[0], reverse=True)
        representative_posts = [text for _, text in scored[:representative_count]]

        velocity = float(series[-1]) if series else None
        growth: float | None = None
        if len(series) >= 2:
            prior = series[:-1]
            avg_prior = sum(prior) / len(prior)
            if avg_prior > 0:
                growth = series[-1] / avg_prior

        age_minutes: float | None = None
        if oldest is not None:
            age_minutes = max(0.0, (self._now() - oldest) / 60.0)

        return CandidateTopic(
            topic_id=topic_id,
            topic_name=topic_name,
            representative_posts=representative_posts,
            # measured values are kept as ints (including 0); None means "not
            # measured". Only impression_count uses None-on-zero (often absent).
            post_count=total,
            unique_author_count=len(authors),
            engagement_count=engagement_total,
            impression_count=impression_total if has_impressions else None,
            volume_velocity=velocity,
            volume_growth=growth,
            topic_age_minutes=age_minutes,
            metadata={
                "query": query,
                "sampled_posts": len(posts),
                "budget_spent": self._budget.spent,
            },
        )
```

- [ ] **Step 8: Update pyproject extras + package discovery**

In `pyproject.toml`, replace the `[project.optional-dependencies]` block and the packages `include` line:
```toml
[project.optional-dependencies]
grok = ["openai>=1.40"]
ingest = ["requests>=2.31"]
live = ["requests>=2.31", "openai>=1.40"]
dev = ["pytest>=8", "pytest-asyncio>=0.23", "ruff>=0.5"]
```
```toml
[tool.setuptools.packages.find]
where = ["."]
include = ["classifier*", "ingestion*"]
```

- [ ] **Step 9: Run the full suite to verify GREEN**

Run: `python -m pytest -v`
Expected: PASS — the new budget (4) + x_client (6) tests plus all prior tests. Pristine output. (Tests inject a fake session, so `requests` need not be installed.)

- [ ] **Step 10: Commit**

```bash
git add ingestion/ tests/test_ingestion_budget.py tests/test_x_client.py pyproject.toml
git commit -m "feat: add budget-guarded X ingestion client (bearer-only, counts pre-filter)"
```

---

### Task 11: Docs, runnable demos, live end-to-end

**Files:**
- Modify: `docs/ingestion.md` (real client, billing safeguards, mapping)
- Create: `examples/demo.py` (offline — Fake semantic, no network)
- Create: `examples/live_e2e.py` (real X ingest -> Grok -> classifier, budget-capped, loads `.env`)
- Create: `classifier/README.md`

**Interfaces:**
- Consumes: `classifier` public exports (Task 8), `ingestion` (Task 10), `GrokSemanticClassifier` (Task 9).
- Produces: documentation + two runnable scripts. `python examples/demo.py` prints a `{decision, event, query}` dict offline. No unit tests (docs/demo task); the offline demo is exercised in Step 4.

- [ ] **Step 1: Write the offline demo**

`examples/demo.py`:
```python
"""Offline end-to-end demo (no network): Fake semantic -> classifier.

Run: python examples/demo.py
"""
from __future__ import annotations

import asyncio

from classifier import (
    CandidateTopic,
    ClassifierConfig,
    FakeSemanticClassifier,
    MarketCandidateClassifier,
    SemanticFeatures,
)


async def main() -> None:
    candidate = CandidateTopic(
        topic_id="warriors_lakers",
        topic_name="Warriors vs Lakers game tonight",
        representative_posts=["warriors lakers tonight", "steph vs lebron one more time"],
        post_count=8000, unique_author_count=5200, engagement_count=64000,
        volume_velocity=250.0, volume_growth=2.4, topic_age_minutes=110.0,
        metadata={"source": "demo"},
    )
    semantic = FakeSemanticClassifier(features_by_topic_id={
        candidate.topic_id: SemanticFeatures(
            eventness=0.9, resolvability=0.95, unresolvedness=0.9,
            subjectivity=0.1, specificity=0.85,
            canonical_event="Golden State Warriors vs Los Angeles Lakers, Aug 8 2026",
        )
    })
    classifier = MarketCandidateClassifier(
        semantic_classifier=semantic, config=ClassifierConfig())
    result = await classifier.classify(candidate)
    print({
        "decision": result.decision,
        "event": result.canonical_event,
        "query": result.query,
    })


if __name__ == "__main__":
    asyncio.run(main())
```

- [ ] **Step 2: Write the live end-to-end demo**

`examples/live_e2e.py`:
```python
"""Live end-to-end demo: X ingest -> Grok -> classifier. Makes REAL, billable calls.

    pip install -e ".[live]"
    python examples/live_e2e.py "warriors lakers -is:retweet lang:en"

Reads XAI_API_KEY and X_BEARER_TOKEN from .env. Hard-capped by RequestBudget so
it cannot run away on pay-per-use billing. Falls back to the fake semantic
classifier if no XAI/Grok key is present.
"""
from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

from classifier import ClassifierConfig, MarketCandidateClassifier
from classifier.semantic.fake import FakeSemanticClassifier
from classifier.semantic.grok import GrokSemanticClassifier
from ingestion.budget import RequestBudget
from ingestion.x_client import XIngestionClient


def _load_dotenv(path: str = ".env") -> None:
    p = Path(path)
    if not p.exists():
        return
    for line in p.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        os.environ.setdefault(key.strip(), val.strip())


async def main() -> None:
    _load_dotenv()
    query = sys.argv[1] if len(sys.argv) > 1 else "prediction market -is:retweet lang:en"

    budget = RequestBudget(max_requests=4, per_endpoint_costs={"search/all": 10})
    client = XIngestionClient(budget=budget)  # bearer from env
    candidate = client.build_candidate_topic(
        topic_id="live-1", topic_name=query, query=query, min_volume=10)
    if candidate is None:
        print({"decision": "skipped", "reason": "volume below min_volume"})
        return

    if os.environ.get("XAI_API_KEY") or os.environ.get("GROK_API_KEY"):
        semantic = GrokSemanticClassifier()
    else:
        print("[no XAI_API_KEY] falling back to FakeSemanticClassifier")
        semantic = FakeSemanticClassifier()

    classifier = MarketCandidateClassifier(
        semantic_classifier=semantic, config=ClassifierConfig())
    result = await classifier.classify(candidate)
    print({
        "decision": result.decision,
        "event": result.canonical_event,
        "query": result.query,
        "score": round(result.score, 3),
        "requests_spent": budget.spent,
    })
    for r in result.reasons:
        print("  -", r)


if __name__ == "__main__":
    asyncio.run(main())
```

- [ ] **Step 3: Rewrite the ingestion doc**

`docs/ingestion.md`:
```markdown
# X API -> CandidateTopic ingestion

The `ingestion` package builds a normalized `CandidateTopic` from live X API v2
data. It is separate from `classifier`, which never calls X. Read-only, app-only
bearer token; the OAuth 1.0a session (publishing) is intentionally not used here.

## Billing safety (pay-per-use, no monthly cap)

`XIngestionClient` takes a `RequestBudget` that raises `BudgetExceeded` before the
request count is exceeded. It reads `x-rate-limit-remaining` / `x-rate-limit-reset`
at runtime and backs off. It only calls read endpoints and never `/2/tweets/search/all`.
Full-archive search is priced well above recent search — keep it off the default path.

## Endpoint mapping

| CandidateTopic field | X API v2 source | Derivation |
|---|---|---|
| post_count | GET /2/tweets/counts/recent | meta.total_tweet_count |
| volume_velocity | counts/recent (granularity=hour) | most recent hourly bucket |
| volume_growth | counts/recent buckets | last bucket / mean(prior buckets) |
| representative_posts | GET /2/tweets/search/recent | top posts by per-post engagement |
| engagement_count | search public_metrics | sum of all public metrics except impression_count |
| unique_author_count | search author_id | count of distinct author_id |
| topic_age_minutes | search created_at | now - oldest sampled post |
| impression_count | public_metrics.impression_count | OPTIONAL; None when absent/all-zero |

Base URL: `https://api.x.com`. Credentials come from `.env` (gitignored).

## Usage

    from ingestion.budget import RequestBudget
    from ingestion.x_client import XIngestionClient

    client = XIngestionClient(budget=RequestBudget(max_requests=4))  # bearer from env
    candidate = client.build_candidate_topic(
        topic_id="t1", topic_name="Warriors vs Lakers",
        query="warriors lakers -is:retweet lang:en", min_volume=50)
```

- [ ] **Step 4: Verify demos compile and the offline demo runs**

Run:
```bash
. .venv/bin/activate
python -m py_compile examples/demo.py examples/live_e2e.py
python examples/demo.py
```
Expected: `py_compile` is silent (both parse). The demo prints:
`{'decision': 'CREATE', 'event': 'Golden State Warriors vs Los Angeles Lakers, Aug 8 2026', 'query': 'Golden State Warriors Los Angeles Lakers Aug 8 2026'}`

(Do NOT run `examples/live_e2e.py` as part of this task — it makes billable calls. It is for manual use.)

- [ ] **Step 5: Write the README**

`classifier/README.md`:
```markdown
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

## Test
    python -m pytest -v          # all mocked; no network, no spend
```

- [ ] **Step 6: Commit**

```bash
git add docs/ingestion.md examples/demo.py examples/live_e2e.py classifier/README.md
git commit -m "docs: ingestion mapping, offline + live demos, README"
```

## Self-Review

**1. Spec coverage:**
- CREATE/WAIT/REJECT decision → Task 8 (policy in Global Constraints). ✅
- Deterministic X features + normalization isolated → Task 4. ✅
- Missing optional features handled gracefully → Task 4 (`missing_feature_value`), Task 8 (reasons note). ✅
- Semantic interface, Grok via adapter only → Task 7 (interface) + Task 9 (adapter, lazy import). ✅
- `CandidateTopic`, `SemanticFeatures`, `NumericFeatures`, `ClassificationResult` typed models → Task 2. ✅
- `canonical_event` neutral (not a question); `query` a search string → Task 5 `build_query` + Grok prompt/schema (Task 9). ✅
- Weighted scoring, config-driven weights → Task 5 + Task 3. ✅
- Hard gates (eventness/resolvability/unresolvedness), config-driven → Task 6 + Task 3. ✅
- DI (`MarketCandidateClassifier(semantic_classifier=..., config=...)`) → Task 8. ✅
- Suggested project structure → Global Constraints layout + Tasks 1–9. ✅
- Modularity boundaries (no X/persistence/routes/question-gen) → classifier package imports none; ingestion stub lives in `examples/`. ✅
- Required tests: CREATE, REJECT subjective, REJECT resolved, WAIT, CREATE-informal → Task 8. ✅
- Output shape `{decision, event, query}` → Task 10 demo prints exactly this. ✅

**2. Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to Task N". Every code step is complete. ✅

**3. Type consistency:** `SemanticClassifier.classify`, `MarketCandidateClassifier.classify`, `extract_numeric_features`, `marketability_score`, `build_query`, `check_hard_gates`, `_to_features` signatures match across Interfaces blocks and usage. Config field names referenced in Tasks 4–8 all exist in Task 3. ✅

---

## Execution Notes

- Run each task's tests before committing; run the full `python -m pytest -v` after Tasks 8 and 9.
- The core `classifier` package must stay import-clean without `openai` installed — only `tests/test_grok_adapter.py`'s network path needs it, and it uses an injected fake client, so the suite passes with just `[dev]`.
