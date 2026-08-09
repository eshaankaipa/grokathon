from __future__ import annotations

from dataclasses import dataclass

from .classifier import Classifier
from .config import Settings, get_settings
from .dedup import Deduplicator
from .embeddings import OpenAIEmbedder
from .grounding import Grounder
from .llm import LLMClient
from .pipeline import Pipeline
from .question import QuestionGenerator
from .resolver import LLMOutcomeSource, ManualOutcomeSource, Resolver
from .store import VectorStore
from .supabase_store import SupabaseStore


def build_store(settings: Settings):
    """SQLite by default; Supabase when STORE_BACKEND=supabase.

    Both satisfy the same interface, so nothing downstream changes. SQLite stays
    the default so the test suite and local development need no network.
    """
    if settings.store_backend == "supabase":
        return SupabaseStore(
            settings.supabase_url, settings.supabase_service_key,
            dim=settings.embedding_dim,
        )
    if settings.store_backend != "sqlite":
        raise RuntimeError(
            f"STORE_BACKEND={settings.store_backend!r} is not one of ('sqlite', 'supabase')."
        )
    return VectorStore(settings.db_path, dim=settings.embedding_dim)


@dataclass
class Services:
    settings: Settings
    store: VectorStore
    pipeline: Pipeline
    resolver: Resolver
    embedder: OpenAIEmbedder

    def close(self) -> None:
        self.store.close()


def build(settings: Settings | None = None) -> Services:
    settings = settings or get_settings()

    llm = LLMClient(settings)
    embedder = OpenAIEmbedder(settings)
    store = build_store(settings)

    pipeline = Pipeline(
        classifier=Classifier(llm, min_engagement=settings.min_engagement),
        deduplicator=Deduplicator(
            store,
            embedder,
            llm if settings.judge_enabled else None,
            recall_k=settings.recall_k,
            candidate_floor=settings.candidate_floor,
            auto_duplicate_threshold=settings.auto_duplicate_threshold,
        ),
        generator=QuestionGenerator(llm),
        grounder=Grounder(llm, strict=settings.grounding_strict)
        if settings.grounding_enabled else None,
        store=store,
        embedder=embedder,
        embedding_model=settings.embedding_model,
    )
    source = (
        LLMOutcomeSource(llm, min_confidence=settings.auto_settle_confidence)
        if settings.auto_settle
        else ManualOutcomeSource()
    )

    return Services(
        settings=settings,
        store=store,
        pipeline=pipeline,
        resolver=Resolver(store, source),
        embedder=embedder,
    )
