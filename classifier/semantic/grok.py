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
