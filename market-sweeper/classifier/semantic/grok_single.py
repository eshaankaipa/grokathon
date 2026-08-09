from __future__ import annotations

import json
import os
from typing import Any

from classifier.models import CandidateTopic, SemanticFeatures
from classifier.semantic.base import SemanticClassifier
from classifier.models import clamp01
from context.models import TopicContext


_SYSTEM = (
    "You analyze an X (Twitter) conversation for prediction-market creation. "
    "Given a topic and representative posts, return a single strict JSON object "
    "containing both an event-level context and semantic features. "
    "All float scores must be in [0, 1]. canonical_event is a NEUTRAL phrase, not a question."
)

_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["context", "semantic_features"],
    "properties": {
        "context": {
            "type": "object",
            "additionalProperties": False,
            "required": ["summary", "entities", "key_developments", "unresolved_events"],
            "properties": {
                "summary": {"type": "string"},
                "entities": {"type": "array", "items": {"type": "string"}},
                "key_developments": {"type": "array", "items": {"type": "string"}},
                "unresolved_events": {"type": "array", "items": {"type": "string"}},
            },
        },
        "semantic_features": {
            "type": "object",
            "additionalProperties": False,
            "required": [
                "eventness", "resolvability", "unresolvedness",
                "subjectivity", "specificity", "canonical_event", "reasoning_summary",
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
        },
    },
}


def _text(val: Any) -> str | None:
    if val is None:
        return None
    val = str(val).strip()
    return val or None


def _tuples(val: Any) -> tuple[str, ...]:
    if not isinstance(val, list):
        return ()
    return tuple(str(x) for x in val if x is not None)


def _to_features(data: dict) -> SemanticFeatures:
    def num(key: str) -> float:
        try:
            return clamp01(float(data.get(key, 0.0)))
        except (TypeError, ValueError):
            return 0.0

    return SemanticFeatures(
        eventness=num("eventness"),
        resolvability=num("resolvability"),
        unresolvedness=num("unresolvedness"),
        subjectivity=num("subjectivity"),
        specificity=num("specificity"),
        canonical_event=_text(data.get("canonical_event")),
        reasoning_summary=_text(data.get("reasoning_summary")),
    )


def _to_context(data: dict) -> TopicContext:
    return TopicContext(
        summary=_text(data.get("summary")) or "(no summary)",
        entities=_tuples(data.get("entities")),
        key_developments=_tuples(data.get("key_developments")),
        unresolved_events=_tuples(data.get("unresolved_events")),
        source_post_ids=(),
    )


class GrokSingleShotClassifier(SemanticClassifier):
    """Single Grok call that both builds TopicContext and returns SemanticFeatures."""

    def __init__(
        self,
        *,
        api_key: str | None = None,
        model: str = "grok-4.5",
        base_url: str = "https://api.x.ai/v1",
        client: Any | None = None,
    ) -> None:
        self._model = model
        self._base_url = base_url
        self._api_key = api_key or os.environ.get("XAI_API_KEY") or os.environ.get("GROK_API_KEY")
        self._client = client
        self._cache: dict[int, tuple[TopicContext, SemanticFeatures]] = {}

    def _get_client(self) -> Any:
        if self._client is None:
            if not self._api_key:
                raise RuntimeError("XAI_API_KEY / GROK_API_KEY not set")
            from openai import AsyncOpenAI

            self._client = AsyncOpenAI(api_key=self._api_key, base_url=self._base_url)
        return self._client

    def _build_prompt(self, candidate: CandidateTopic) -> str:
        posts = "\n".join(f"- {p}" for p in candidate.representative_posts[:10])
        return (
            f"Topic: {candidate.topic_name}\n"
            f"Representative posts:\n{posts or '- (none)'}\n"
            f"Post count: {candidate.post_count or 'unknown'}\n"
            f"Unique authors: {candidate.unique_author_count or 'unknown'}\n"
            f"Engagement: {candidate.engagement_count or 'unknown'}\n"
            "Produce context and semantic features in the requested JSON schema."
        )

    async def _call(self, candidate: CandidateTopic) -> tuple[TopicContext, SemanticFeatures]:
        client = self._get_client()
        resp = await client.chat.completions.create(
            model=self._model,
            messages=[
                {"role": "system", "content": _SYSTEM},
                {"role": "user", "content": self._build_prompt(candidate)},
            ],
            response_format={
                "type": "json_schema",
                "json_schema": {"name": "single_shot", "schema": _SCHEMA, "strict": True},
            },
            temperature=0,
        )
        content = resp.choices[0].message.content
        data = json.loads(content)
        return _to_context(data.get("context", {})), _to_features(data.get("semantic_features", {}))

    async def build(self, candidate: CandidateTopic) -> TopicContext:
        key = id(candidate)
        if key not in self._cache:
            context, features = await self._call(candidate)
            self._cache[key] = (context, features)
        return self._cache[key][0]

    async def classify(
        self, candidate: CandidateTopic, context: TopicContext | None = None
    ) -> SemanticFeatures:
        key = id(candidate)
        if key not in self._cache:
            _, features = await self._call(candidate)
            self._cache[key] = (_, features)
        return self._cache[key][1]
