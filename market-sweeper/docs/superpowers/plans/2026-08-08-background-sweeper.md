# Background Sweeper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Turn the validated manual-query pipeline into an autonomous Background Sweeper exposing `await sweeper.run_once() -> SweepResult`, which discovers X topics, ingests them, builds event-level context, and classifies them CREATE / WAIT / REJECT — reusing the existing ingestion/budget/classifier.

**Architecture:** Three new packages — `discovery/` (find topic seeds), `context/` (event-level understanding via hierarchical Grok), `sweeper/` (orchestration) — plus a minimal extension of the existing semantic boundary to optionally accept `TopicContext`. Discovery and ingestion share ONE `RequestBudget`. The sweeper contains no scoring/semantic logic; it coordinates injected components.

**Tech Stack:** Python 3.11+, existing `classifier`/`ingestion` packages, `openai` (lazy, `[grok]`), `requests` (lazy, `[ingest]`), pytest + pytest-asyncio. All tests mocked; live paths are opt-in demos.

## Global Constraints

- **Python >= 3.11.** Follow existing style (frozen dataclasses, `from __future__ import annotations`, type hints, small focused files).
- **Reuse, do not duplicate.** Use the existing `ingestion.x_client.XIngestionClient.build_candidate_topic` (counts → min-volume pre-filter → search → `CandidateTopic`), `ingestion.budget.RequestBudget` / `BudgetExceeded`, and `classifier.MarketCandidateClassifier`. Do NOT re-implement X search/counts anywhere.
- **One shared budget per sweep.** Discovery (trends) and ingestion (counts/search) spend from the SAME `RequestBudget`. Never silently exceed it; on `BudgetExceeded`, stop cleanly and return the partial `SweepResult`.
- **Cheap before expensive.** A seed failing the min-volume pre-filter must never trigger a `search/recent`. (Already guaranteed by `build_candidate_topic` returning `None` after counts.)
- **Raw X parsing stays in adapters.** Discovery/ingestion adapters convert raw X JSON to typed models; the rest of the app sees only `TopicSeed` / `CandidateTopic` / `TopicContext`.
- **Separation of concerns:** Context Builder *understands* the conversation; Classifier *decides* market-worthiness. Never move classification into the Context Builder or vice versa.
- **The classifier core stays X/Grok/ingestion-agnostic.** The only classifier change is an optional `context` parameter typed via `TYPE_CHECKING` (no runtime import of `context`).
- **All new logic has deterministic mocked tests; no network in the default suite.** Live demos require explicit env vars, use a tiny default budget, print request counts, warn before billable calls, and make no writes. They are never run by tests.
- **Scope boundary — STOP at CREATE/WAIT/REJECT + canonical event/query.** Do NOT implement question generation, market spec/persistence/matching, trading, payments, resolution, frontend, or persistent scheduling/retry.
- **Package layout (new, all at repo root):**
  ```
  discovery/   __init__.py base.py fake.py configured.py x_trends.py composite.py
  context/     __init__.py models.py config.py base.py fake.py grok.py
  sweeper/     __init__.py models.py config.py dedup.py ingestion.py sweeper.py
  examples/    sweeper_demo.py  live_sweeper.py
  docs/        sweeper.md
  ```
- **Existing signatures to build on (verbatim):**
  - `XIngestionClient(*, budget, bearer_token=None, session=None, base_url="https://api.x.com", sleep=time.sleep, now=time.time, min_rate_limit_remaining=2)`; methods `fetch_counts(query)`, `search_recent(query, max_results=100)`, `build_candidate_topic(*, topic_id, topic_name, query, max_posts=100, min_volume=0, representative_count=5) -> CandidateTopic | None`, plus generic `_get(path, params, endpoint)`.
  - `RequestBudget(max_requests, per_endpoint_costs={})` → `.spend(endpoint="", cost=None)`, `.spent`, `.remaining`; `BudgetExceeded`.
  - `MarketCandidateClassifier(semantic_classifier, config=None)` → `async classify(candidate) -> ClassificationResult` (this plan adds optional `context`).
  - `SemanticClassifier.classify(self, candidate) -> SemanticFeatures` (this plan adds optional `context`).
  - `CandidateTopic(topic_id, topic_name, representative_posts=[], post_count=None, ..., metadata={})`.

---

### Task 1: Extend the semantic boundary to accept optional TopicContext

**Files:**
- Modify: `classifier/semantic/base.py`
- Modify: `classifier/semantic/fake.py`
- Modify: `classifier/semantic/grok.py`
- Modify: `classifier/classifier.py`
- Test: `tests/test_context_passthrough.py`

**Interfaces:**
- Produces: `SemanticClassifier.classify(self, candidate, context=None)`, `MarketCandidateClassifier.classify(self, candidate, context=None)`. `context` is an optional `TopicContext` (defined later in `context/models.py`); referenced only via `TYPE_CHECKING` so there is no runtime import.
- Consumes: nothing new.

- [ ] **Step 1: Write the failing test**

`tests/test_context_passthrough.py`:
```python
from types import SimpleNamespace

from classifier import (
    CandidateTopic, ClassifierConfig, MarketCandidateClassifier, SemanticFeatures,
)
from classifier.semantic.base import SemanticClassifier


class _SpySemantic(SemanticClassifier):
    def __init__(self, features):
        self.features = features
        self.received_context = "UNSET"

    async def classify(self, candidate, context=None):
        self.received_context = context
        return self.features


async def test_classifier_forwards_context_to_semantic():
    feats = SemanticFeatures(0.9, 0.9, 0.9, 0.1, 0.8, canonical_event="E")
    spy = _SpySemantic(feats)
    clf = MarketCandidateClassifier(semantic_classifier=spy, config=ClassifierConfig())
    ctx = SimpleNamespace(summary="ctx")  # duck-typed stand-in for TopicContext
    await clf.classify(CandidateTopic(topic_id="t", topic_name="x"), context=ctx)
    assert spy.received_context is ctx


async def test_classifier_works_without_context():
    feats = SemanticFeatures(0.9, 0.9, 0.9, 0.1, 0.8, canonical_event="E")
    spy = _SpySemantic(feats)
    clf = MarketCandidateClassifier(semantic_classifier=spy)
    await clf.classify(CandidateTopic(topic_id="t", topic_name="x"))
    assert spy.received_context is None
```

- [ ] **Step 2: Run to verify RED**

Run: `. .venv/bin/activate && python -m pytest tests/test_context_passthrough.py -v`
Expected: FAIL — `MarketCandidateClassifier.classify()` got an unexpected keyword argument `context`.

- [ ] **Step 3: Apply the minimal changes**

`classifier/semantic/base.py` — replace the file with:
```python
from __future__ import annotations

from abc import ABC, abstractmethod
from typing import TYPE_CHECKING

from ..models import CandidateTopic, SemanticFeatures

if TYPE_CHECKING:
    from context.models import TopicContext


class SemanticClassifier(ABC):
    """Interface the classifier depends on for semantic judgments.

    Implementations must not leak transport/SDK details to callers.
    """

    @abstractmethod
    async def classify(
        self, candidate: CandidateTopic, context: "TopicContext | None" = None
    ) -> SemanticFeatures:
        """Return semantic features for the candidate, optionally enriched by context."""
        raise NotImplementedError
```

`classifier/semantic/fake.py` — change the `classify` signature to accept and ignore context:
```python
    async def classify(self, candidate: CandidateTopic, context=None) -> SemanticFeatures:
        return self._by_id.get(candidate.topic_id, self._default)
```

`classifier/semantic/grok.py` — accept context and, when present, enrich the prompt. Change the signature and `_build_user_prompt`:
```python
    def _build_user_prompt(self, candidate: CandidateTopic, context=None) -> str:
        posts = "\n".join(f"- {p}" for p in candidate.representative_posts[:10])
        context_block = ""
        if context is not None:
            devs = "\n".join(f"  * {d}" for d in getattr(context, "key_developments", ()))
            unresolved = "\n".join(f"  * {u}" for u in getattr(context, "unresolved_events", ()))
            context_block = (
                f"\nEvent context summary: {getattr(context, 'summary', '')}\n"
                f"Key developments:\n{devs or '  * (none)'}\n"
                f"Unresolved outcomes:\n{unresolved or '  * (none)'}\n"
            )
        return (
            f"Topic: {candidate.topic_name}\n"
            f"Representative posts:\n{posts or '- (none)'}\n"
            f"{context_block}\n"
            "Score eventness, resolvability, unresolvedness, subjectivity, specificity "
            "in [0,1]. canonical_event is a NEUTRAL phrase describing the underlying "
            "real-world event (NOT a question), or null if none. reasoning_summary is one short sentence."
        )

    async def classify(self, candidate: CandidateTopic, context=None) -> SemanticFeatures:
        client = self._get_client()
        resp = await client.chat.completions.create(
            model=self._model,
            messages=[
                {"role": "system", "content": _SYSTEM},
                {"role": "user", "content": self._build_user_prompt(candidate, context)},
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

`classifier/classifier.py` — accept optional context and forward it:
```python
    async def classify(self, candidate: CandidateTopic, context=None) -> ClassificationResult:
        cfg = self._config
        reasons: list[str] = []

        numeric = extract_numeric_features(candidate, cfg)
        semantic = await self._semantic.classify(candidate, context)
        canonical = semantic.canonical_event
```
(Leave the rest of the method unchanged.)

- [ ] **Step 4: Run the full suite to verify GREEN**

Run: `python -m pytest -v`
Expected: PASS — the 2 new tests plus ALL existing tests (the existing Grok mock test calls `create(...)` the same way; `_build_user_prompt` still returns a string with `context=None`).

- [ ] **Step 5: Commit**

```bash
git add classifier/semantic/base.py classifier/semantic/fake.py classifier/semantic/grok.py classifier/classifier.py tests/test_context_passthrough.py
git commit -m "feat: allow optional TopicContext through the semantic boundary"
```

---

### Task 2: Context package — models, config, interface, fake

**Files:**
- Create: `context/__init__.py`, `context/models.py`, `context/config.py`, `context/base.py`, `context/fake.py`
- Test: `tests/test_context_fake.py`

**Interfaces:**
- Produces:
  - `TopicContext(summary, entities=(), key_developments=(), unresolved_events=(), source_post_ids=())` — frozen dataclass, tuple fields.
  - `ContextConfig(max_posts=40, chunk_size=10, max_synthesis_inputs=8, max_grok_calls_per_topic=6, model="grok-4-latest")` — frozen.
  - `ContextBuilder` Protocol: `async build(self, candidate: CandidateTopic) -> TopicContext`.
  - `FakeContextBuilder(by_topic_id=None, default=None)`.
- Consumes: `classifier.CandidateTopic`.

- [ ] **Step 1: Write the failing test**

`tests/test_context_fake.py`:
```python
from classifier import CandidateTopic
from context.base import ContextBuilder
from context.fake import FakeContextBuilder
from context.models import TopicContext


async def test_fake_returns_preset_by_topic_id():
    preset = TopicContext(summary="preset", entities=("A",))
    fake = FakeContextBuilder(by_topic_id={"t1": preset})
    got = await fake.build(CandidateTopic(topic_id="t1", topic_name="x"))
    assert got is preset


async def test_fake_derives_default_context_from_posts():
    fake = FakeContextBuilder()
    cand = CandidateTopic(topic_id="t2", topic_name="Warriors vs Lakers",
                          representative_posts=["p1", "p2", "p3", "p4"])
    got = await fake.build(cand)
    assert isinstance(got, TopicContext)
    assert "Warriors vs Lakers" in got.summary
    assert got.key_developments == ("p1", "p2", "p3")


def test_fake_is_a_context_builder():
    assert isinstance(FakeContextBuilder(), ContextBuilder)


def test_topic_context_is_frozen():
    import pytest
    ctx = TopicContext(summary="s")
    with pytest.raises(AttributeError):
        ctx.summary = "x"  # type: ignore[misc]
```

- [ ] **Step 2: Run to verify RED**

Run: `python -m pytest tests/test_context_fake.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'context'`.

- [ ] **Step 3: Implement**

`context/__init__.py`:
```python
from .base import ContextBuilder
from .config import ContextConfig
from .fake import FakeContextBuilder
from .models import TopicContext

__all__ = ["TopicContext", "ContextConfig", "ContextBuilder", "FakeContextBuilder"]
```

`context/models.py`:
```python
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class TopicContext:
    """Event-level understanding of a conversation (factual, not a decision)."""

    summary: str
    entities: tuple[str, ...] = ()
    key_developments: tuple[str, ...] = ()
    unresolved_events: tuple[str, ...] = ()
    source_post_ids: tuple[str, ...] = ()
```

`context/config.py`:
```python
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class ContextConfig:
    """Tunables for hierarchical context construction."""

    max_posts: int = 40
    chunk_size: int = 10
    max_synthesis_inputs: int = 8
    max_grok_calls_per_topic: int = 6
    model: str = "grok-4-latest"

    def __post_init__(self) -> None:
        # The reduce tree only shrinks when the branching factor is >= 2.
        if self.chunk_size < 1:
            raise ValueError("chunk_size must be >= 1")
        if self.max_synthesis_inputs < 2:
            raise ValueError("max_synthesis_inputs must be >= 2 (reduce tree must shrink)")
        if self.max_grok_calls_per_topic < 1:
            raise ValueError("max_grok_calls_per_topic must be >= 1")
        if self.max_posts < 1:
            raise ValueError("max_posts must be >= 1")
```

`context/base.py`:
```python
from __future__ import annotations

from typing import Protocol, runtime_checkable

from classifier import CandidateTopic

from .models import TopicContext


@runtime_checkable
class ContextBuilder(Protocol):
    """Builds an event-level TopicContext from a CandidateTopic. Understand, don't decide."""

    async def build(self, candidate: CandidateTopic) -> TopicContext: ...
```

`context/fake.py`:
```python
from __future__ import annotations

from classifier import CandidateTopic

from .models import TopicContext


class FakeContextBuilder:
    """Deterministic context builder for tests and offline demos."""

    def __init__(
        self,
        by_topic_id: dict[str, TopicContext] | None = None,
        default: TopicContext | None = None,
    ) -> None:
        self._by_id = by_topic_id or {}
        self._default = default

    async def build(self, candidate: CandidateTopic) -> TopicContext:
        if candidate.topic_id in self._by_id:
            return self._by_id[candidate.topic_id]
        if self._default is not None:
            return self._default
        posts = tuple(candidate.representative_posts)
        return TopicContext(
            summary=f"Discussion about {candidate.topic_name}",
            entities=(candidate.topic_name,),
            key_developments=posts[:3],
            unresolved_events=(),
            source_post_ids=(),
        )
```

- [ ] **Step 4: Run to verify GREEN**

Run: `python -m pytest tests/test_context_fake.py -v`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add context/__init__.py context/models.py context/config.py context/base.py context/fake.py tests/test_context_fake.py
git commit -m "feat: add context package (TopicContext, ContextBuilder interface, fake)"
```

---

### Task 3: Grok hierarchical Context Builder

**Files:**
- Create: `context/grok.py`
- Modify: `context/__init__.py` (export `GrokContextBuilder`)
- Test: `tests/test_context_grok.py`

**Interfaces:**
- Produces: `GrokContextBuilder(*, api_key=None, model=None, base_url="https://api.x.ai/v1", client=None, config: ContextConfig | None = None)` implementing `async build(candidate) -> TopicContext`. Single-pass when `len(posts) <= chunk_size`; hierarchical (per-chunk summarize → synthesize) otherwise; total Grok calls capped by `config.max_grok_calls_per_topic`.
- Consumes: `ContextConfig`, `TopicContext`, `classifier.CandidateTopic`.

- [ ] **Step 1: Write the failing test**

`tests/test_context_grok.py`:
```python
import json

from classifier import CandidateTopic
from context.config import ContextConfig
from context.grok import GrokContextBuilder
from context.models import TopicContext


class _Msg:
    def __init__(self, content):
        self.content = content


class _Choice:
    def __init__(self, content):
        self.message = _Msg(content)


class _Resp:
    def __init__(self, content):
        self.choices = [_Choice(content)]


class _FakeClient:
    """Returns queued JSON strings; records each call's messages."""

    def __init__(self, payloads):
        self._payloads = list(payloads)
        self.calls = []
        self.chat = self  # so client.chat.completions.create resolves
        self.completions = self

    async def create(self, **kwargs):
        self.calls.append(kwargs)
        return _Resp(self._payloads.pop(0))


def _ctx_json(summary, entities=(), devs=(), unresolved=()):
    return json.dumps({
        "summary": summary, "entities": list(entities),
        "key_developments": list(devs), "unresolved_events": list(unresolved),
    })


async def test_small_post_set_single_pass():
    client = _FakeClient([_ctx_json("one-pass summary", entities=["A"])])
    cfg = ContextConfig(chunk_size=10)
    builder = GrokContextBuilder(client=client, config=cfg)
    cand = CandidateTopic(topic_id="t", topic_name="x",
                          representative_posts=["p1", "p2", "p3"])
    ctx = await builder.build(cand)
    assert isinstance(ctx, TopicContext)
    assert ctx.summary == "one-pass summary"
    assert len(client.calls) == 1  # single pass


async def test_large_post_set_hierarchical_then_synthesize():
    # 25 posts, chunk_size 10 -> 3 chunk calls + 1 synthesis = 4 calls
    payloads = [
        _ctx_json("chunk1", devs=["d1"]),
        _ctx_json("chunk2", devs=["d2"]),
        _ctx_json("chunk3", devs=["d3"]),
        _ctx_json("final synthesis", entities=["A", "B"], devs=["d1", "d2", "d3"],
                  unresolved=["will X happen?"]),
    ]
    client = _FakeClient(payloads)
    cfg = ContextConfig(chunk_size=10, max_synthesis_inputs=8, max_grok_calls_per_topic=6)
    builder = GrokContextBuilder(client=client, config=cfg)
    cand = CandidateTopic(topic_id="t", topic_name="x",
                          representative_posts=[f"p{i}" for i in range(25)])
    ctx = await builder.build(cand)
    assert len(client.calls) == 4                      # 3 chunks + 1 synthesis
    assert ctx.summary == "final synthesis"            # synthesis output wins
    assert ctx.unresolved_events == ("will X happen?",)


async def test_grok_call_cap_is_respected():
    # cap = 3 -> at most 2 chunk calls then 1 synthesis
    payloads = [_ctx_json(f"c{i}") for i in range(10)]
    client = _FakeClient(payloads)
    cfg = ContextConfig(chunk_size=5, max_grok_calls_per_topic=3)
    builder = GrokContextBuilder(client=client, config=cfg)
    cand = CandidateTopic(topic_id="t", topic_name="x",
                          representative_posts=[f"p{i}" for i in range(40)])
    await builder.build(cand)
    assert len(client.calls) <= 3


async def test_recursive_reduce_tree_for_many_summaries():
    # chunk_size=2 over 8 posts -> 4 chunk summaries; max_synthesis_inputs=2 forces a
    # multi-level reduce tree: 4 -> (2 synth) -> 2 -> (1 synth) -> 1  = 4 map + 3 reduce = 7 calls.
    payloads = [_ctx_json(f"c{i}") for i in range(4)] + [
        _ctx_json("r1"), _ctx_json("r2"), _ctx_json("final"),
    ]
    client = _FakeClient(payloads)
    cfg = ContextConfig(chunk_size=2, max_synthesis_inputs=2, max_grok_calls_per_topic=20)
    builder = GrokContextBuilder(client=client, config=cfg)
    cand = CandidateTopic(topic_id="t", topic_name="x",
                          representative_posts=[f"p{i}" for i in range(8)])
    ctx = await builder.build(cand)
    assert len(client.calls) == 7        # genuine multi-level recursion, not a flat 2-level
    assert ctx.summary == "final"


async def test_reduce_falls_back_to_raw_merge_when_budget_exhausted():
    # Tiny budget: after chunk maps, no calls left -> reduce must merge without crashing.
    payloads = [_ctx_json("c0", entities=["A"]), _ctx_json("c1", entities=["B"])]
    client = _FakeClient(payloads)
    cfg = ContextConfig(chunk_size=1, max_synthesis_inputs=2, max_grok_calls_per_topic=2)
    builder = GrokContextBuilder(client=client, config=cfg)
    cand = CandidateTopic(topic_id="t", topic_name="x",
                          representative_posts=["p0", "p1"])
    ctx = await builder.build(cand)
    assert len(client.calls) == 2                 # both budget units spent on the map step
    assert set(ctx.entities) == {"A", "B"}        # raw merge combined the chunk outputs


async def test_empty_posts_degrades_without_calling_grok():
    client = _FakeClient([])
    builder = GrokContextBuilder(client=client, config=ContextConfig())
    ctx = await builder.build(CandidateTopic(topic_id="t", topic_name="Quiet Topic"))
    assert len(client.calls) == 0
    assert isinstance(ctx, TopicContext)
    assert "Quiet Topic" in ctx.summary


async def test_map_budget_exhaustion_keeps_remaining_posts_raw():
    # cap=1 -> only the first chunk is LLM-summarized; the rest must still appear
    # (raw) in the final context rather than being silently dropped.
    client = _FakeClient([_ctx_json("c0", devs=["from-llm"])])
    cfg = ContextConfig(chunk_size=1, max_synthesis_inputs=2, max_grok_calls_per_topic=1)
    builder = GrokContextBuilder(client=client, config=cfg)
    cand = CandidateTopic(topic_id="t", topic_name="x",
                          representative_posts=["p0", "p1", "p2"])
    ctx = await builder.build(cand)
    assert len(client.calls) == 1
    assert "p1" in ctx.key_developments and "p2" in ctx.key_developments


def test_context_config_rejects_degenerate_values():
    import pytest
    with pytest.raises(ValueError):
        ContextConfig(max_synthesis_inputs=1)   # reduce tree could not shrink
    with pytest.raises(ValueError):
        ContextConfig(chunk_size=0)
    with pytest.raises(ValueError):
        ContextConfig(max_grok_calls_per_topic=0)
```

- [ ] **Step 2: Run to verify RED**

Run: `python -m pytest tests/test_context_grok.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'context.grok'`.

- [ ] **Step 3: Implement**

`context/grok.py`:
```python
from __future__ import annotations

import json
import os
from typing import Any

from classifier import CandidateTopic

from .config import ContextConfig
from .models import TopicContext

_CHUNK_SYSTEM = (
    "You extract factual event information from a batch of X (Twitter) posts. "
    "Identify the underlying real-world event(s), entities, meaningful developments, "
    "and unresolved outcomes. Do NOT decide if it deserves a market. "
    "Respond ONLY with strict JSON matching the schema."
)
_SYNTH_SYSTEM = (
    "You synthesize several partial summaries of one X conversation into a single "
    "factual event-level understanding. Merge entities/developments, keep it factual, "
    "do NOT decide market-worthiness. Respond ONLY with strict JSON matching the schema."
)

_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["summary", "entities", "key_developments", "unresolved_events"],
    "properties": {
        "summary": {"type": "string"},
        "entities": {"type": "array", "items": {"type": "string"}},
        "key_developments": {"type": "array", "items": {"type": "string"}},
        "unresolved_events": {"type": "array", "items": {"type": "string"}},
    },
}


class GrokContextBuilder:
    """Hierarchical Grok-backed context builder (single-pass for small post sets)."""

    def __init__(
        self,
        *,
        api_key: str | None = None,
        model: str | None = None,
        base_url: str = "https://api.x.ai/v1",
        client: Any | None = None,
        config: ContextConfig | None = None,
    ) -> None:
        self._config = config or ContextConfig()
        self._model = model or self._config.model
        self._base_url = base_url
        self._api_key = api_key or os.environ.get("XAI_API_KEY") or os.environ.get("GROK_API_KEY")
        self._client = client
        self._calls_made = 0

    def _get_client(self) -> Any:
        if self._client is None:
            if not self._api_key:
                raise RuntimeError("XAI_API_KEY / GROK_API_KEY not set")
            from openai import AsyncOpenAI  # lazy, optional dependency

            self._client = AsyncOpenAI(api_key=self._api_key, base_url=self._base_url)
        return self._client

    async def _call(self, system: str, user: str) -> dict:
        """One Grok JSON call; increments the per-build call counter."""
        self._calls_made += 1
        resp = await self._get_client().chat.completions.create(
            model=self._model,
            messages=[{"role": "system", "content": system},
                      {"role": "user", "content": user}],
            response_format={
                "type": "json_schema",
                "json_schema": {"name": "topic_context", "schema": _SCHEMA, "strict": True},
            },
            temperature=0,
        )
        return json.loads(resp.choices[0].message.content)

    def _remaining_calls(self) -> int:
        return self._config.max_grok_calls_per_topic - self._calls_made

    def _chunk_prompt(self, candidate: CandidateTopic, posts: list[str]) -> str:
        body = "\n".join(f"- {p}" for p in posts)
        return f"Topic: {candidate.topic_name}\nPosts:\n{body}\n"

    def _synth_prompt(self, candidate: CandidateTopic, parts: list[dict]) -> str:
        body = "\n---\n".join(json.dumps(p) for p in parts)
        return f"Topic: {candidate.topic_name}\nPartial summaries (JSON):\n{body}\n"

    def _merge_raw(self, parts: list[dict]) -> dict:
        """Deterministic non-LLM merge — base combiner / budget-exhaustion fallback."""
        def uniq(key: str) -> list[str]:
            seen: list[str] = []
            for p in parts:
                for x in p.get(key) or []:
                    if str(x) not in seen:
                        seen.append(str(x))
            return seen

        summaries = [str(p.get("summary", "")).strip() for p in parts if p.get("summary")]
        return {
            "summary": " ".join(summaries),
            "entities": uniq("entities"),
            "key_developments": uniq("key_developments"),
            "unresolved_events": uniq("unresolved_events"),
        }

    def _to_context(self, data: dict) -> TopicContext:
        def strs(key: str) -> tuple[str, ...]:
            val = data.get(key) or []
            return tuple(str(x) for x in val)

        return TopicContext(
            summary=str(data.get("summary", "")).strip(),
            entities=strs("entities"),
            key_developments=strs("key_developments"),
            unresolved_events=strs("unresolved_events"),
            source_post_ids=(),
        )

    async def _reduce(self, candidate: CandidateTopic, parts: list[dict]) -> dict:
        """Recursively synthesize partial summaries into one (RLM reduce tree).

        Branching factor is ``max_synthesis_inputs``; recurses until a single
        summary remains. Falls back to a non-LLM merge when the Grok-call budget
        is exhausted, so it always terminates and returns something.
        """
        cfg = self._config
        if not parts:
            return {"summary": "", "entities": [], "key_developments": [], "unresolved_events": []}
        if len(parts) == 1:
            return parts[0]
        if len(parts) <= cfg.max_synthesis_inputs:
            if self._remaining_calls() >= 1:
                return await self._call(_SYNTH_SYSTEM, self._synth_prompt(candidate, parts))
            return self._merge_raw(parts)

        reduced: list[dict] = []
        for i in range(0, len(parts), cfg.max_synthesis_inputs):
            group = parts[i:i + cfg.max_synthesis_inputs]
            if len(group) == 1:
                reduced.append(group[0])
            elif self._remaining_calls() >= 1:
                reduced.append(await self._call(_SYNTH_SYSTEM, self._synth_prompt(candidate, group)))
            else:
                reduced.append(self._merge_raw(group))
        return await self._reduce(candidate, reduced)

    async def build(self, candidate: CandidateTopic) -> TopicContext:
        cfg = self._config
        self._calls_made = 0
        posts = list(candidate.representative_posts)[: cfg.max_posts]
        if not posts:
            return TopicContext(
                summary=f"No posts available for {candidate.topic_name}",
                entities=(candidate.topic_name,),
            )

        # Single pass for a small post set.
        if len(posts) <= cfg.chunk_size:
            return self._to_context(
                await self._call(_CHUNK_SYSTEM, self._chunk_prompt(candidate, posts))
            )

        # MAP: summarize each chunk; when the call budget runs out mid-loop, fold the
        # remaining raw posts in (below) so nothing is dropped, then REDUCE.
        chunks = [posts[i:i + cfg.chunk_size] for i in range(0, len(posts), cfg.chunk_size)]
        summaries: list[dict] = []
        for idx, chunk in enumerate(chunks):
            if self._remaining_calls() < 1:
                # Budget exhausted: fold the remaining RAW posts in (as key_developments)
                # so they're represented in the reduced context rather than dropped.
                remaining = [p for c in chunks[idx:] for p in c]
                summaries.append({
                    "summary": "", "entities": [],
                    "key_developments": remaining, "unresolved_events": [],
                })
                break
            summaries.append(await self._call(_CHUNK_SYSTEM, self._chunk_prompt(candidate, chunk)))

        # REDUCE: recursively synthesize (RLM tree) down to a single summary.
        return self._to_context(await self._reduce(candidate, summaries))
```

Add to `context/__init__.py`:
```python
from .grok import GrokContextBuilder
```
and add `"GrokContextBuilder"` to `__all__`.

Also fix package discovery in `pyproject.toml` so the new top-level packages are installed (not just importable via cwd). Change the `include` line to:
```toml
[tool.setuptools.packages.find]
where = ["."]
include = ["classifier*", "ingestion*", "context*", "discovery*", "sweeper*"]
```
Then re-run the editable install so the finder is regenerated: `pip install -e ".[dev]" -q`. (`discovery`/`sweeper` dirs don't exist yet — they'll be picked up on the next install once created; adding them now avoids a later edit.)

- [ ] **Step 4: Run to verify GREEN**

Run: `python -m pytest tests/test_context_grok.py -v`
Expected: PASS (4 tests). `openai` is never imported (client injected).

- [ ] **Step 5: Commit**

```bash
git add context/grok.py context/__init__.py tests/test_context_grok.py
git commit -m "feat: add hierarchical Grok context builder"
```

---

### Task 4: Discovery package + trends endpoint

**Files:**
- Modify: `ingestion/x_client.py` (add `fetch_trends`)
- Create: `discovery/__init__.py`, `discovery/base.py`, `discovery/fake.py`, `discovery/configured.py`, `discovery/x_trends.py`, `discovery/composite.py`
- Test: `tests/test_discovery.py`, `tests/test_fetch_trends.py`

**Interfaces:**
- Produces:
  - `XIngestionClient.fetch_trends(woeid=1) -> list[dict]` (budget label `"trends"`).
  - `TopicSeed(topic_id, name, source, metadata={})` — frozen; `source: Literal["trend","news","configured"]`.
  - `TopicDiscovery` Protocol: `async discover(self) -> list[TopicSeed]`.
  - `FakeTopicDiscovery(seeds)`, `ConfiguredDiscovery(queries)`, `XTrendDiscovery(client, *, woeid=1, limit=20)`, `CompositeDiscovery(discoveries)`.
- Consumes: `XIngestionClient`.

- [ ] **Step 1: Write the failing tests**

`tests/test_fetch_trends.py`:
```python
from ingestion.budget import RequestBudget
from ingestion.x_client import XIngestionClient


class _Resp:
    def __init__(self, payload):
        self._payload = payload
        self.status_code = 200
        self.headers = {"x-rate-limit-remaining": "100", "x-rate-limit-reset": "0"}
        self.text = ""

    def json(self):
        return self._payload


class _FakeSession:
    def __init__(self, payload):
        self._payload = payload
        self.calls = []

    def get(self, url, headers=None, params=None):
        self.calls.append((url, params))
        return _Resp(self._payload)


def test_fetch_trends_parses_and_spends_budget():
    payload = {"data": [{"trend_name": "#AI", "tweet_count": 1000},
                        {"trend_name": "Warriors", "tweet_count": None}]}
    budget = RequestBudget(max_requests=5)
    client = XIngestionClient(budget=budget, bearer_token="b", session=_FakeSession(payload))
    trends = client.fetch_trends(woeid=1)
    assert trends[0]["trend_name"] == "#AI"
    assert budget.spent == 1
```

`tests/test_discovery.py`:
```python
from discovery.base import TopicDiscovery, TopicSeed
from discovery.composite import CompositeDiscovery
from discovery.configured import ConfiguredDiscovery
from discovery.fake import FakeTopicDiscovery
from discovery.x_trends import XTrendDiscovery


class _TrendClient:
    def __init__(self, raw):
        self._raw = raw
        self.trend_calls = 0

    def fetch_trends(self, woeid=1):
        self.trend_calls += 1
        return self._raw


async def test_fake_discovery_returns_seeds():
    seeds = [TopicSeed(topic_id="a", name="A", source="configured", metadata={})]
    disc = FakeTopicDiscovery(seeds)
    assert await disc.discover() == seeds
    assert isinstance(disc, TopicDiscovery)


async def test_configured_discovery_builds_seeds():
    disc = ConfiguredDiscovery(["Fed rate decision", "Warriors Lakers"])
    seeds = await disc.discover()
    assert all(isinstance(s, TopicSeed) for s in seeds)
    assert all(s.source == "configured" for s in seeds)
    assert seeds[0].metadata["query"] == "Fed rate decision"


async def test_x_trend_discovery_parses_raw_into_seeds_no_leak():
    raw = [{"trend_name": "#AI", "tweet_count": 5000},
           {"trend_name": "Warriors", "tweet_count": None},
           {"not_a_trend": "ignored"}]  # malformed entry dropped
    disc = XTrendDiscovery(_TrendClient(raw), woeid=1, limit=10)
    seeds = await disc.discover()
    assert [s.name for s in seeds] == ["#AI", "Warriors"]
    assert all(isinstance(s, TopicSeed) for s in seeds)
    assert all(s.source == "trend" for s in seeds)
    assert seeds[0].metadata["query"] == "#AI"       # query derived from trend name


async def test_composite_merges_sources():
    a = FakeTopicDiscovery([TopicSeed("a", "A", "trend", {})])
    b = FakeTopicDiscovery([TopicSeed("b", "B", "configured", {})])
    merged = await CompositeDiscovery([a, b]).discover()
    assert {s.name for s in merged} == {"A", "B"}
```

- [ ] **Step 2: Run to verify RED**

Run: `python -m pytest tests/test_discovery.py tests/test_fetch_trends.py -v`
Expected: FAIL — missing `fetch_trends` / `No module named 'discovery'`.

- [ ] **Step 3: Add `fetch_trends` to `ingestion/x_client.py`**

Add a constant near the other endpoint constants:
```python
_TRENDS_BY_WOEID = "trends/by/woeid"
```
Add this method to `XIngestionClient` (after `search_recent`):
```python
    def fetch_trends(self, woeid: int = 1) -> list[dict]:
        """Return the raw trend objects for a WOEID (1 = global). Spends 1 budget unit."""
        data = self._get(
            f"{_TRENDS_BY_WOEID}/{woeid}",
            {"trend.fields": "trend_name,tweet_count"},
            "trends",
        )
        return list(data.get("data", []))
```

- [ ] **Step 4: Implement the discovery package**

`discovery/base.py`:
```python
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal, Protocol, runtime_checkable

SeedSource = Literal["trend", "news", "configured"]


@dataclass(frozen=True)
class TopicSeed:
    """A potentially interesting topic to investigate. Discovery does NOT classify."""

    topic_id: str
    name: str
    source: SeedSource
    metadata: dict = field(default_factory=dict)


@runtime_checkable
class TopicDiscovery(Protocol):
    async def discover(self) -> list[TopicSeed]: ...
```

`discovery/__init__.py`:
```python
from .base import TopicDiscovery, TopicSeed
from .composite import CompositeDiscovery
from .configured import ConfiguredDiscovery
from .fake import FakeTopicDiscovery
from .x_trends import XTrendDiscovery

__all__ = [
    "TopicSeed", "TopicDiscovery", "FakeTopicDiscovery",
    "ConfiguredDiscovery", "XTrendDiscovery", "CompositeDiscovery",
]
```

`discovery/_slug.py` (shared helper):
```python
from __future__ import annotations

import re


def slug(name: str) -> str:
    """Stable topic_id from a display name: lowercase alnum tokens joined by '-'."""
    tokens = re.findall(r"[a-z0-9]+", name.lower())
    return "-".join(tokens) or "topic"
```

`discovery/fake.py`:
```python
from __future__ import annotations

from .base import TopicSeed


class FakeTopicDiscovery:
    """Deterministic discovery for tests/offline demos."""

    def __init__(self, seeds: list[TopicSeed]) -> None:
        self._seeds = list(seeds)

    async def discover(self) -> list[TopicSeed]:
        return list(self._seeds)
```

`discovery/configured.py`:
```python
from __future__ import annotations

from ._slug import slug
from .base import TopicSeed


class ConfiguredDiscovery:
    """Turns a static list of query strings into configured TopicSeeds (no API)."""

    def __init__(self, queries: list[str]) -> None:
        self._queries = list(queries)

    async def discover(self) -> list[TopicSeed]:
        return [
            TopicSeed(topic_id=slug(q), name=q, source="configured",
                      metadata={"query": q})
            for q in self._queries
        ]
```

`discovery/x_trends.py`:
```python
from __future__ import annotations

from typing import Any

from ._slug import slug
from .base import TopicSeed


class XTrendDiscovery:
    """Discovers trend seeds via the X trends endpoint. Raw parsing stays here.

    ``client`` is any object exposing ``fetch_trends(woeid) -> list[dict]``
    (the shared XIngestionClient), so trend requests spend the same budget.
    """

    def __init__(self, client: Any, *, woeid: int = 1, limit: int = 20) -> None:
        self._client = client
        self._woeid = woeid
        self._limit = limit

    async def discover(self) -> list[TopicSeed]:
        raw = self._client.fetch_trends(self._woeid)
        seeds: list[TopicSeed] = []
        for t in raw[: self._limit]:
            name = t.get("trend_name") or t.get("name")
            if not name:
                continue
            seeds.append(TopicSeed(
                topic_id=slug(name),
                name=name,
                source="trend",
                metadata={"query": name, "tweet_count": t.get("tweet_count"),
                          "woeid": self._woeid},
            ))
        return seeds
```

`discovery/composite.py`:
```python
from __future__ import annotations

from typing import Any

from .base import TopicSeed


class CompositeDiscovery:
    """Runs several discoveries and concatenates their seeds (dedup happens later)."""

    def __init__(self, discoveries: list[Any]) -> None:
        self._discoveries = list(discoveries)

    async def discover(self) -> list[TopicSeed]:
        out: list[TopicSeed] = []
        for d in self._discoveries:
            out.extend(await d.discover())
        return out
```

- [ ] **Step 5: Run to verify GREEN**

Run: `python -m pytest tests/test_discovery.py tests/test_fetch_trends.py -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add ingestion/x_client.py discovery/ tests/test_discovery.py tests/test_fetch_trends.py
git commit -m "feat: add topic discovery package + X trends endpoint"
```

---

### Task 5: Sweeper models, config, dedup, ingestion adapter

**Files:**
- Create: `sweeper/__init__.py`, `sweeper/models.py`, `sweeper/config.py`, `sweeper/dedup.py`, `sweeper/ingestion.py`
- Test: `tests/test_sweeper_dedup.py`, `tests/test_sweeper_ingestion.py`

**Interfaces:**
- Produces:
  - `SweepCandidate(topic_seed, candidate_topic, topic_context, classification_result)` and `SweepResult(create, wait, rejected_count, requests_spent)` — frozen; `create`/`wait` are tuples.
  - `SweeperConfig(max_topics_per_sweep=10, max_x_requests_per_sweep=20, max_posts_per_topic=40, max_context_grok_calls_per_topic=6, min_volume=10, debug=False)`.
  - `dedupe_seeds(seeds) -> list[TopicSeed]` (token-set normalization; keeps first occurrence).
  - `SeedIngestion` Protocol: `async ingest(self, seed) -> CandidateTopic | None`; `XSeedIngestion(client, config)`, `FakeSeedIngestion(by_topic_id)`.
- Consumes: `discovery.TopicSeed`, `classifier.CandidateTopic`/`ClassificationResult`, `context.models.TopicContext`, `ingestion.x_client.XIngestionClient`.

- [ ] **Step 1: Write the failing tests**

`tests/test_sweeper_dedup.py`:
```python
from discovery.base import TopicSeed
from sweeper.dedup import dedupe_seeds


def _seed(name):
    return TopicSeed(topic_id=name.lower().replace(" ", "-"), name=name,
                     source="trend", metadata={})


def test_token_set_dedup_collapses_reorderings():
    seeds = [_seed("Warriors Lakers"), _seed("Lakers vs Warriors"), _seed("Fed rate")]
    out = dedupe_seeds(seeds)
    names = [s.name for s in out]
    assert names == ["Warriors Lakers", "Fed rate"]  # 2nd collapsed, first kept


def test_distinct_topics_are_kept():
    seeds = [_seed("OpenAI launch"), _seed("Bitcoin ETF")]
    assert len(dedupe_seeds(seeds)) == 2
```

`tests/test_sweeper_ingestion.py`:
```python
from classifier import CandidateTopic
from discovery.base import TopicSeed
from sweeper.config import SweeperConfig
from sweeper.ingestion import FakeSeedIngestion, SeedIngestion, XSeedIngestion


class _Client:
    def __init__(self, result):
        self._result = result
        self.calls = []

    def build_candidate_topic(self, **kwargs):
        self.calls.append(kwargs)
        return self._result


async def test_x_seed_ingestion_maps_seed_to_client_call():
    cand = CandidateTopic(topic_id="t", topic_name="Warriors Lakers")
    client = _Client(cand)
    cfg = SweeperConfig(max_posts_per_topic=30, min_volume=50)
    ing = XSeedIngestion(client, cfg)
    seed = TopicSeed(topic_id="t", name="Warriors Lakers", source="trend",
                     metadata={"query": "warriors lakers"})
    got = await ing.ingest(seed)
    assert got is cand
    assert client.calls[0]["query"] == "warriors lakers"
    assert client.calls[0]["min_volume"] == 50
    assert client.calls[0]["max_posts"] == 30
    assert isinstance(ing, SeedIngestion)


async def test_x_seed_ingestion_falls_back_to_seed_name_as_query():
    client = _Client(None)
    ing = XSeedIngestion(client, SweeperConfig())
    await ing.ingest(TopicSeed(topic_id="t", name="Fed rate", source="configured", metadata={}))
    assert client.calls[0]["query"] == "Fed rate"


async def test_fake_seed_ingestion_returns_presets():
    cand = CandidateTopic(topic_id="t", topic_name="x")
    ing = FakeSeedIngestion({"t": cand, "low": None})
    assert await ing.ingest(TopicSeed("t", "x", "trend", {})) is cand
    assert await ing.ingest(TopicSeed("low", "y", "trend", {})) is None
```

- [ ] **Step 2: Run to verify RED**

Run: `python -m pytest tests/test_sweeper_dedup.py tests/test_sweeper_ingestion.py -v`
Expected: FAIL — `No module named 'sweeper'`.

- [ ] **Step 3: Implement**

`sweeper/models.py`:
```python
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
```

`sweeper/config.py`:
```python
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class SweeperConfig:
    max_topics_per_sweep: int = 10
    max_x_requests_per_sweep: int = 20
    max_posts_per_topic: int = 40
    max_context_grok_calls_per_topic: int = 6
    min_volume: int = 10
    debug: bool = False
```

`sweeper/dedup.py`:
```python
from __future__ import annotations

import re

from discovery.base import TopicSeed

_STOP = {"vs", "versus", "the", "a", "an", "and", "of", "at", "in", "on", "game", "match"}


def _key(name: str) -> frozenset[str]:
    tokens = re.findall(r"[a-z0-9]+", name.lower())
    meaningful = [t for t in tokens if t not in _STOP]
    return frozenset(meaningful or tokens)


def dedupe_seeds(seeds: list[TopicSeed]) -> list[TopicSeed]:
    """Collapse obvious duplicate seeds by normalized token set. Keeps first seen.

    Lightweight only — alias resolution (e.g. GSW == Warriors) is downstream.
    """
    seen: dict[frozenset[str], TopicSeed] = {}
    for s in seeds:
        k = _key(s.name)
        if k not in seen:
            seen[k] = s
    return list(seen.values())
```

`sweeper/ingestion.py`:
```python
from __future__ import annotations

from typing import Any, Protocol, runtime_checkable

from classifier import CandidateTopic
from discovery.base import TopicSeed

from .config import SweeperConfig


@runtime_checkable
class SeedIngestion(Protocol):
    async def ingest(self, seed: TopicSeed) -> CandidateTopic | None: ...


class XSeedIngestion:
    """Adapts a TopicSeed to the existing XIngestionClient.build_candidate_topic."""

    def __init__(self, client: Any, config: SweeperConfig) -> None:
        self._client = client
        self._config = config

    async def ingest(self, seed: TopicSeed) -> CandidateTopic | None:
        cfg = self._config
        query = seed.metadata.get("query") or seed.name
        # representative_count == max_posts_per_topic so the context builder has material.
        return self._client.build_candidate_topic(
            topic_id=seed.topic_id,
            topic_name=seed.name,
            query=query,
            max_posts=cfg.max_posts_per_topic,
            min_volume=cfg.min_volume,
            representative_count=cfg.max_posts_per_topic,
        )


class FakeSeedIngestion:
    """Deterministic ingestion for tests/offline demos (None == below min-volume)."""

    def __init__(self, by_topic_id: dict[str, CandidateTopic | None]) -> None:
        self._by_id = by_topic_id

    async def ingest(self, seed: TopicSeed) -> CandidateTopic | None:
        return self._by_id.get(seed.topic_id)
```

`sweeper/__init__.py`:
```python
from .config import SweeperConfig
from .dedup import dedupe_seeds
from .ingestion import FakeSeedIngestion, SeedIngestion, XSeedIngestion
from .models import SweepCandidate, SweepResult

__all__ = [
    "SweeperConfig", "dedupe_seeds", "SeedIngestion", "XSeedIngestion",
    "FakeSeedIngestion", "SweepCandidate", "SweepResult",
]
```

- [ ] **Step 4: Run to verify GREEN**

Run: `python -m pytest tests/test_sweeper_dedup.py tests/test_sweeper_ingestion.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add sweeper/__init__.py sweeper/models.py sweeper/config.py sweeper/dedup.py sweeper/ingestion.py tests/test_sweeper_dedup.py tests/test_sweeper_ingestion.py
git commit -m "feat: add sweeper models, config, dedup, and seed-ingestion adapter"
```

---

### Task 6: BackgroundSweeper orchestration

**Files:**
- Create: `sweeper/sweeper.py`
- Modify: `sweeper/__init__.py` (export `BackgroundSweeper`)
- Test: `tests/test_sweeper.py`

**Interfaces:**
- Produces: `BackgroundSweeper(*, discovery, ingestion, context_builder, classifier, budget, config=None)` with `async run_once() -> SweepResult`. Flow: discover → dedupe → cap at `max_topics_per_sweep` → per seed: ingest (skip if `None`) → build context → classify → bucket. On `BudgetExceeded`, stop and return partial. `requests_spent = budget.spent`.
- Consumes: everything from Tasks 1–5 + `ingestion.budget`.

- [ ] **Step 1: Write the failing test**

`tests/test_sweeper.py`:
```python
from classifier import (
    CandidateTopic, ClassifierConfig, FakeSemanticClassifier,
    MarketCandidateClassifier, SemanticFeatures,
)
from context.fake import FakeContextBuilder
from discovery.base import TopicSeed
from discovery.fake import FakeTopicDiscovery
from ingestion.budget import BudgetExceeded, RequestBudget
from sweeper.config import SweeperConfig
from sweeper.ingestion import FakeSeedIngestion
from sweeper.sweeper import BackgroundSweeper


def _cand(tid, **kw):
    return CandidateTopic(topic_id=tid, topic_name=tid, post_count=9000,
                          engagement_count=60000, volume_velocity=250.0,
                          volume_growth=2.5, unique_author_count=5000,
                          topic_age_minutes=120.0, **kw)


_CREATE = SemanticFeatures(0.9, 0.95, 0.9, 0.1, 0.85, canonical_event="Big Game 2026")
_WAIT = SemanticFeatures(0.6, 0.6, 0.9, 0.3, 0.2, canonical_event="Vague thing")
_REJECT = SemanticFeatures(0.1, 0.1, 0.8, 0.9, 0.3)


def _sweeper(seeds, ingest_map, features_map, *, budget=None, config=None,
             context_builder=None):
    budget = budget or RequestBudget(max_requests=1000)
    classifier = MarketCandidateClassifier(
        semantic_classifier=FakeSemanticClassifier(features_by_topic_id=features_map),
        config=ClassifierConfig())
    return BackgroundSweeper(
        discovery=FakeTopicDiscovery(seeds),
        ingestion=FakeSeedIngestion(ingest_map),
        context_builder=context_builder or FakeContextBuilder(),
        classifier=classifier,
        budget=budget,
        config=config or SweeperConfig(),
    )


async def test_buckets_by_decision():
    seeds = [TopicSeed("c", "c", "trend", {}), TopicSeed("w", "w", "trend", {}),
             TopicSeed("r", "r", "trend", {})]
    ingest = {"c": _cand("c"), "w": _cand("w"), "r": _cand("r")}
    feats = {"c": _CREATE, "w": _WAIT, "r": _REJECT}
    result = await _sweeper(seeds, ingest, feats).run_once()
    assert [sc.topic_seed.topic_id for sc in result.create] == ["c"]
    assert [sc.topic_seed.topic_id for sc in result.wait] == ["w"]
    assert result.rejected_count == 1
    assert result.create[0].classification_result.decision == "CREATE"
    assert result.create[0].topic_context is not None


async def test_low_volume_seed_skips_context_and_classify():
    calls = {"built": 0}

    class _CountingContext(FakeContextBuilder):
        async def build(self, candidate):
            calls["built"] += 1
            return await super().build(candidate)

    seeds = [TopicSeed("low", "low", "trend", {})]
    result = await _sweeper(seeds, {"low": None}, {},
                            context_builder=_CountingContext()).run_once()
    assert calls["built"] == 0
    assert result.rejected_count == 1
    assert result.create == () and result.wait == ()


async def test_duplicate_seeds_ingested_once():
    ingested = []

    class _CountingIngest(FakeSeedIngestion):
        async def ingest(self, seed):
            ingested.append(seed.topic_id)
            return await super().ingest(seed)

    seeds = [TopicSeed("wl", "Warriors Lakers", "trend", {}),
             TopicSeed("lw", "Lakers vs Warriors", "configured", {})]
    sw = BackgroundSweeper(
        discovery=FakeTopicDiscovery(seeds),
        ingestion=_CountingIngest({"wl": _cand("wl")}),
        context_builder=FakeContextBuilder(),
        classifier=MarketCandidateClassifier(
            semantic_classifier=FakeSemanticClassifier(features_by_topic_id={"wl": _CREATE})),
        budget=RequestBudget(max_requests=1000),
        config=SweeperConfig(),
    )
    result = await sw.run_once()
    assert ingested == ["wl"]                 # duplicate collapsed before ingestion
    assert len(result.create) == 1


async def test_max_topics_per_sweep_caps_processing():
    seeds = [TopicSeed(f"t{i}", f"topic {i}", "trend", {}) for i in range(5)]
    ingest = {f"t{i}": _cand(f"t{i}") for i in range(5)}
    feats = {f"t{i}": _CREATE for i in range(5)}
    cfg = SweeperConfig(max_topics_per_sweep=2)
    result = await _sweeper(seeds, ingest, feats, config=cfg).run_once()
    assert len(result.create) == 2


async def test_budget_exhaustion_returns_partial():
    budget = RequestBudget(max_requests=2)

    class _SpendingIngest(FakeSeedIngestion):
        def __init__(self, by_id, budget):
            super().__init__(by_id)
            self._budget = budget

        async def ingest(self, seed):
            self._budget.spend("search/recent")  # raises BudgetExceeded when exhausted
            return await super().ingest(seed)

    seeds = [TopicSeed(f"t{i}", f"t{i}", "trend", {}) for i in range(5)]
    ingest_map = {f"t{i}": _cand(f"t{i}") for i in range(5)}
    feats = {f"t{i}": _CREATE for i in range(5)}
    sw = BackgroundSweeper(
        discovery=FakeTopicDiscovery(seeds),
        ingestion=_SpendingIngest(ingest_map, budget),
        context_builder=FakeContextBuilder(),
        classifier=MarketCandidateClassifier(
            semantic_classifier=FakeSemanticClassifier(features_by_topic_id=feats)),
        budget=budget,
        config=SweeperConfig(),
    )
    result = await sw.run_once()
    assert len(result.create) == 2          # only 2 processed before budget ran out
    assert result.requests_spent == 2       # partial, no crash
```

- [ ] **Step 2: Run to verify RED**

Run: `python -m pytest tests/test_sweeper.py -v`
Expected: FAIL — `No module named 'sweeper.sweeper'`.

- [ ] **Step 3: Implement**

`sweeper/sweeper.py`:
```python
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
```

Add to `sweeper/__init__.py`:
```python
from .sweeper import BackgroundSweeper
```
and add `"BackgroundSweeper"` to `__all__`.

- [ ] **Step 4: Run the full suite to verify GREEN**

Run: `python -m pytest -v`
Expected: PASS — all sweeper tests plus every prior test.

- [ ] **Step 5: Commit**

```bash
git add sweeper/sweeper.py sweeper/__init__.py tests/test_sweeper.py
git commit -m "feat: add BackgroundSweeper.run_once autonomous orchestration"
```

---

### Task 7: Demos + docs

**Files:**
- Create: `examples/sweeper_demo.py` (offline), `examples/live_sweeper.py` (live, not run in tests)
- Create: `docs/sweeper.md`
- Modify: `classifier/README.md` (add a Background Sweeper section)

**Interfaces:**
- Consumes: all packages. Produces runnable demos. No unit tests; the offline demo is exercised in Step 3.

- [ ] **Step 1: Write the offline demo**

`examples/sweeper_demo.py`:
```python
"""Offline Background Sweeper demo (no network, no keys).

Run: python -m examples.sweeper_demo
"""
from __future__ import annotations

import asyncio

from classifier import (
    CandidateTopic, ClassifierConfig, FakeSemanticClassifier,
    MarketCandidateClassifier, SemanticFeatures,
)
from context.fake import FakeContextBuilder
from discovery.base import TopicSeed
from discovery.fake import FakeTopicDiscovery
from ingestion.budget import RequestBudget
from sweeper.config import SweeperConfig
from sweeper.ingestion import FakeSeedIngestion
from sweeper.sweeper import BackgroundSweeper


def _cand(topic_id: str, name: str) -> CandidateTopic:
    return CandidateTopic(
        topic_id=topic_id, topic_name=name,
        representative_posts=[f"{name} is happening", f"everyone talking about {name}"],
        post_count=8000, unique_author_count=5000, engagement_count=64000,
        volume_velocity=250.0, volume_growth=2.4, topic_age_minutes=120.0,
    )


async def main() -> None:
    seeds = [
        TopicSeed("warriors-lakers", "Warriors Lakers", "trend", {}),
        TopicSeed("lakers-vs-warriors", "Lakers vs Warriors", "configured", {}),  # dup
        TopicSeed("openai-announcement", "OpenAI announcement", "trend", {}),
        TopicSeed("steph-is-the-goat", "Steph is the GOAT", "trend", {}),
        TopicSeed("quiet-topic", "Quiet Topic", "configured", {}),  # below min-volume
    ]
    ingest = {
        "warriors-lakers": _cand("warriors-lakers", "Warriors Lakers"),
        "openai-announcement": _cand("openai-announcement", "OpenAI announcement"),
        "steph-is-the-goat": _cand("steph-is-the-goat", "Steph is the GOAT"),
        "quiet-topic": None,  # below min-volume -> skipped after counts
    }
    features = {
        "warriors-lakers": SemanticFeatures(0.9, 0.95, 0.9, 0.1, 0.85,
                                            canonical_event="Golden State Warriors vs Los Angeles Lakers, Aug 8 2026"),
        "openai-announcement": SemanticFeatures(0.55, 0.55, 0.9, 0.3, 0.2,
                                                canonical_event="Upcoming OpenAI product announcement"),
        "steph-is-the-goat": SemanticFeatures(0.15, 0.1, 0.8, 0.95, 0.3),
    }

    sweeper = BackgroundSweeper(
        discovery=FakeTopicDiscovery(seeds),
        ingestion=FakeSeedIngestion(ingest),
        context_builder=FakeContextBuilder(),
        classifier=MarketCandidateClassifier(
            semantic_classifier=FakeSemanticClassifier(features_by_topic_id=features),
            config=ClassifierConfig()),
        budget=RequestBudget(max_requests=1000),
        config=SweeperConfig(),
    )
    result = await sweeper.run_once()

    print(f"Discovered {len(seeds)} topics\n")
    print("CREATE")
    for sc in result.create:
        print(f"  {sc.topic_seed.name}")
        print(f"    canonical event: {sc.classification_result.canonical_event}")
        print(f"    query: {sc.classification_result.query}")
        print(f"    score: {sc.classification_result.score:.2f}")
    print("\nWAIT")
    for sc in result.wait:
        print(f"  {sc.topic_seed.name}")
        print(f"    canonical event: {sc.classification_result.canonical_event}")
        print(f"    score: {sc.classification_result.score:.2f}")
    print(f"\nRejected: {result.rejected_count}")
    print(f"Requests spent: {result.requests_spent}")


if __name__ == "__main__":
    asyncio.run(main())
```

- [ ] **Step 2: Write the live demo**

`examples/live_sweeper.py`:
```python
"""Live Background Sweeper — makes REAL, billable X + Grok calls.

    pip install -e ".[live]"
    python -m examples.live_sweeper

Requires X_BEARER_TOKEN and XAI_API_KEY in .env. Uses a tiny X request budget
by default, prints the request count, and makes NO write calls. Never run by tests.
"""
from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

from classifier import ClassifierConfig, MarketCandidateClassifier
from classifier.semantic.grok import GrokSemanticClassifier
from context.config import ContextConfig
from context.grok import GrokContextBuilder
from discovery.composite import CompositeDiscovery
from discovery.configured import ConfiguredDiscovery
from discovery.x_trends import XTrendDiscovery
from ingestion.budget import RequestBudget
from ingestion.x_client import XIngestionClient
from sweeper.config import SweeperConfig
from sweeper.ingestion import XSeedIngestion
from sweeper.sweeper import BackgroundSweeper


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
    if not os.environ.get("X_BEARER_TOKEN") or not (
        os.environ.get("XAI_API_KEY") or os.environ.get("GROK_API_KEY")
    ):
        print("Set X_BEARER_TOKEN and XAI_API_KEY (in .env) to run the live sweeper.")
        sys.exit(1)

    cfg = SweeperConfig(
        max_topics_per_sweep=3, max_x_requests_per_sweep=8,
        max_posts_per_topic=40, min_volume=25,
    )
    print("WARNING: this makes REAL, billable X + Grok API calls.")
    print(f"  max X requests this sweep: {cfg.max_x_requests_per_sweep}")
    print("  press Ctrl-C within 3s to abort...")
    await asyncio.sleep(3)

    budget = RequestBudget(max_requests=cfg.max_x_requests_per_sweep)
    client = XIngestionClient(budget=budget)  # bearer from env
    discovery = CompositeDiscovery([
        XTrendDiscovery(client, woeid=1, limit=cfg.max_topics_per_sweep),
        ConfiguredDiscovery(["fed rate decision -is:retweet lang:en"]),
    ])
    sweeper = BackgroundSweeper(
        discovery=discovery,
        ingestion=XSeedIngestion(client, cfg),
        context_builder=GrokContextBuilder(
            config=ContextConfig(max_grok_calls_per_topic=cfg.max_context_grok_calls_per_topic)),
        classifier=MarketCandidateClassifier(
            semantic_classifier=GrokSemanticClassifier(), config=ClassifierConfig()),
        budget=budget,
        config=cfg,
    )
    result = await sweeper.run_once()

    print(f"\nX requests spent: {result.requests_spent}")
    print(f"CREATE: {len(result.create)}  WAIT: {len(result.wait)}  "
          f"REJECT/skip: {result.rejected_count}")
    for label, bucket in (("CREATE", result.create), ("WAIT", result.wait)):
        for sc in bucket:
            r = sc.classification_result
            print(f"  [{label}] {sc.topic_seed.name} -> {r.canonical_event} "
                  f"(score {r.score:.2f}, query={r.query})")


if __name__ == "__main__":
    asyncio.run(main())
```

- [ ] **Step 3: Verify demos compile and the offline demo runs**

Run:
```bash
. .venv/bin/activate
python -m py_compile examples/sweeper_demo.py examples/live_sweeper.py
python -m examples.sweeper_demo
```
Expected: `py_compile` silent; the demo prints `Discovered 5 topics`, a CREATE section containing `Warriors Lakers` with its canonical event + query, a WAIT section containing `OpenAI announcement`, and `Rejected: 3` (Steph=REJECT, quiet-topic=below-volume skip, the duplicate Lakers seed collapsed so 5 seeds → 4 unique → one CREATE + one WAIT + two rejected... confirm the printed counts and adjust the narrative text only if the dedup/skip math differs). Do NOT run `examples/live_sweeper.py`.

- [ ] **Step 4: Write docs + README section**

`docs/sweeper.md`:
```markdown
# Background Sweeper

Autonomous vertical slice:

    X -> Topic Discovery -> activity pre-filter -> representative posts
      -> event-level Context Builder -> Market Candidate Classifier
      -> CREATE / WAIT / REJECT (+ canonical event/query)

Entry point: `await BackgroundSweeper.run_once() -> SweepResult`.

## Components (all injected)
- `discovery/` — finds `TopicSeed`s (X trends via the shared client, configured queries, fakes). Discovery never classifies.
- `ingestion` (reused) — `TopicSeed -> XIngestionClient.build_candidate_topic -> CandidateTopic` (counts pre-filter before the costly search).
- `context/` — `GrokContextBuilder` builds an event-level `TopicContext` (single pass for few posts; hierarchical chunk→synthesize for many). Understands, does not decide.
- `classifier` (reused) — decides CREATE/WAIT/REJECT, now optionally enriched by `TopicContext`.

## Budget & cost controls (`SweeperConfig`)
`max_topics_per_sweep`, `max_x_requests_per_sweep`, `max_posts_per_topic`,
`max_context_grok_calls_per_topic`, `min_volume`. Discovery and ingestion share ONE
`RequestBudget`; a low-volume seed never triggers a search; on budget exhaustion the
sweep stops cleanly and returns partial results.

## Run
    python -m examples.sweeper_demo    # offline, no keys
    python -m examples.live_sweeper    # real X + Grok (billable), tiny budget

## Scope
Stops at CREATE/WAIT/REJECT + canonical event/query. Question generation, market
creation/persistence/matching, trading, resolution, and frontend are later stages.
```

Add a short "Background Sweeper" section to `classifier/README.md` pointing to `docs/sweeper.md` and the two demo commands.

- [ ] **Step 5: Commit**

```bash
git add examples/sweeper_demo.py examples/live_sweeper.py docs/sweeper.md classifier/README.md
git commit -m "docs: add offline + live Background Sweeper demos and docs"
```

---

## Self-Review

**Spec coverage:** Topic Discovery (Task 4: TopicSeed, Protocol, fake + X trends + configured + composite). Reuse ingestion (Task 5: XSeedIngestion wraps build_candidate_topic; shared budget). Context Builder (Tasks 2–3: TopicContext, ContextBuilder, fake, hierarchical Grok). Classifier integration minimal + optional (Task 1). BackgroundSweeper + run_once (Task 6). SweepResult/SweepCandidate (Task 5). Seed dedup (Task 5). Budget/cost controls (Task 5 config + Task 6 enforcement + partial-on-exhaustion). Tests for discovery/budget/context/sweeper (Tasks 2–6). Demos offline + live (Task 7). Scope boundary respected (no downstream stages).

**Placeholder scan:** none — every step has complete code.

**Type consistency:** `TopicSeed`, `TopicContext`, `SweepResult`, `SweepCandidate`, `SeedIngestion`, `dedupe_seeds`, `build`/`discover`/`ingest`/`run_once` signatures are consistent across tasks. `context` param is optional everywhere it appears. `budget` is injected into the sweeper and shared with the client used by both discovery and ingestion.

**Existing tests:** Task 1 keeps them green (only additive optional params); later tasks add new files only.
