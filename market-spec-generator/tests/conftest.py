from __future__ import annotations

import re
import zlib
from typing import Any

import numpy as np
import pytest

from app.embeddings import normalize
from app.prompts import (
    CLASSIFIER_SYSTEM,
    GROUNDING_SYSTEM,
    JUDGE_SYSTEM,
    QUESTION_SYSTEM,
    RESOLVER_SYSTEM,
)
from app.store import VectorStore

DIM = 64
_TOKEN = re.compile(r"[a-z0-9]+")


class FakeEmbedder:
    """Deterministic hashed bag-of-words. Shares no code with the real embedder,
    but text overlap still produces high cosine similarity, which is all the
    dedup logic depends on."""

    dim = DIM

    def __init__(self) -> None:
        self.calls: list[str] = []

    async def embed(self, texts: list[str]) -> np.ndarray:
        self.calls.extend(texts)
        vecs = np.zeros((len(texts), DIM), dtype=np.float32)
        for i, text in enumerate(texts):
            for token in _TOKEN.findall(text.lower()):
                vecs[i, zlib.crc32(token.encode()) % DIM] += 1.0
        return normalize(vecs)

    async def embed_one(self, text: str) -> np.ndarray:
        return (await self.embed([text]))[0]


class FakeLLM:
    """Returns queued responses in order; raises if a call is unexpected."""

    def __init__(self, responses: list[dict[str, Any]] | None = None) -> None:
        self.responses = list(responses or [])
        self.calls: list[tuple[str, str]] = []

    def queue(self, response: dict[str, Any]) -> None:
        self.responses.append(response)

    async def json(self, *, system: str, user: str, temperature: float = 0.1) -> dict[str, Any]:
        self.calls.append((system, user))
        if not self.responses:
            raise AssertionError(f"FakeLLM got an unexpected call:\n{user[:400]}")
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response


class RoutingLLM:
    """Answers based on WHICH prompt it was given, not call order.

    FakeLLM's FIFO queue is fine sequentially, but under concurrency two runs
    interleave and steal each other's responses. Routing by prompt makes
    concurrent tests deterministic.
    """

    def __init__(self, *, classify=None, judge=None, question=None, resolve=None,
                 ground=None) -> None:
        self._routes = {
            CLASSIFIER_SYSTEM: classify,
            GROUNDING_SYSTEM: ground,
            JUDGE_SYSTEM: judge,
            QUESTION_SYSTEM: question,
            RESOLVER_SYSTEM: resolve,
        }
        self.calls: list[str] = []

    async def json(self, *, system: str, user: str, temperature: float = 0.1) -> dict[str, Any]:
        self.calls.append(system[:40])
        response = self._routes.get(system)
        if response is None:
            raise AssertionError(f"RoutingLLM has no response for prompt: {system[:60]!r}")
        return response


@pytest.fixture
def store(tmp_path) -> VectorStore:
    s = VectorStore(tmp_path / "test.db", dim=DIM)
    yield s
    s.close()


@pytest.fixture
def embedder() -> FakeEmbedder:
    return FakeEmbedder()
