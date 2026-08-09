from __future__ import annotations

import json
import re
from typing import Any, Protocol

from openai import AsyncOpenAI

from .config import Settings

_FENCE = re.compile(r"^```(?:json)?\s*|\s*```$", re.MULTILINE)


class LLMError(RuntimeError):
    pass


class JSONLLM(Protocol):
    async def json(self, *, system: str, user: str, temperature: float = 0.1) -> dict[str, Any]: ...


class LLMClient:
    """Chat completions in JSON mode against any OpenAI-compatible endpoint.

    OpenAI and xAI (Grok) both speak this wire format, so switching providers is
    a base URL and a model name — see `LLM_PROVIDER` in .env.
    """

    def __init__(self, settings: Settings) -> None:
        # Built lazily so the vector-store half of the service still starts (and
        # /markets, /markets/search, threshold-only dedup still work) when no LLM
        # key is configured yet. The failure surfaces on the first LLM call.
        self._settings = settings
        self._model = settings.llm_model
        self._client: AsyncOpenAI | None = None

    def _ensure_client(self) -> AsyncOpenAI:
        if self._client is None:
            self._settings.require_llm()
            self._client = AsyncOpenAI(
                api_key=self._settings.llm_api_key, base_url=self._settings.llm_base_url
            )
        return self._client

    async def json(self, *, system: str, user: str, temperature: float = 0.1) -> dict[str, Any]:
        client = self._ensure_client()
        messages: list[dict[str, str]] = [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ]

        last_err: Exception | None = None
        for attempt in range(3):
            resp = await client.chat.completions.create(
                model=self._model,
                messages=messages,  # type: ignore[arg-type]
                temperature=temperature,
                response_format={"type": "json_object"},
            )
            raw = (resp.choices[0].message.content or "").strip()
            try:
                parsed = json.loads(_FENCE.sub("", raw).strip())
            except json.JSONDecodeError as exc:
                last_err = exc
            else:
                if isinstance(parsed, dict):
                    return parsed
                last_err = LLMError(f"expected a JSON object, got {type(parsed).__name__}")

            # Feed the bad output back so the retry has something to correct.
            messages.append({"role": "assistant", "content": raw})
            messages.append(
                {
                    "role": "user",
                    "content": (
                        f"That was not a valid JSON object ({last_err}). "
                        "Reply with the JSON object only — no prose, no code fences."
                    ),
                }
            )

        raise LLMError(f"model did not return valid JSON after 3 attempts: {last_err}")
