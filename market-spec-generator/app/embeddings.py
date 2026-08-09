from __future__ import annotations

import re
from typing import Protocol

import numpy as np
from openai import AsyncOpenAI

from .config import Settings

_WS = re.compile(r"\s+")


def canonical_text(
    *,
    event: str,
    query: str = "",
    entities: list[str] | None = None,
    category: str = "",
    resolution_date: str | None = None,
) -> str:
    """Build the string that actually gets embedded.

    Both writes and lookups go through this, so stored markets and incoming
    candidates always land in the same vector space. Entities are sorted so that
    "Warriors vs Lakers" and "Lakers vs Warriors" produce identical text.
    """
    parts = [_WS.sub(" ", event).strip()]
    if query:
        parts.append(_WS.sub(" ", query).strip())
    if entities:
        parts.append(" | ".join(sorted({e.strip().lower() for e in entities if e.strip()})))
    if category:
        parts.append(f"category: {category.strip().lower()}")
    if resolution_date:
        parts.append(f"resolves: {resolution_date}")
    return "\n".join(p for p in parts if p)


class Embedder(Protocol):
    dim: int

    async def embed(self, texts: list[str]) -> np.ndarray: ...

    async def embed_one(self, text: str) -> np.ndarray: ...


class OpenAIEmbedder:
    """text-embedding-3-small by default. Vectors come back L2-normalized, so a
    dot product is the cosine similarity."""

    def __init__(self, settings: Settings) -> None:
        settings.require_embeddings()
        self._client = AsyncOpenAI(api_key=settings.openai_api_key)
        self._model = settings.embedding_model
        self.dim = settings.embedding_dim

    async def embed(self, texts: list[str]) -> np.ndarray:
        if not texts:
            return np.zeros((0, self.dim), dtype=np.float32)
        cleaned = [t.strip() or " " for t in texts]
        resp = await self._client.embeddings.create(model=self._model, input=cleaned)
        vecs = np.array([d.embedding for d in resp.data], dtype=np.float32)
        return normalize(vecs)

    async def embed_one(self, text: str) -> np.ndarray:
        return (await self.embed([text]))[0]


def normalize(vecs: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(vecs, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return (vecs / norms).astype(np.float32)
