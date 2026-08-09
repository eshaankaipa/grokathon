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
