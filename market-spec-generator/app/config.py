from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

ROOT = Path(__file__).resolve().parent.parent


def _bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


# Per-provider defaults. Both speak the OpenAI chat-completions wire format, so
# the only thing that changes between them is the base URL, model, and key.
PROVIDERS = {
    "openai": {"base_url": "https://api.openai.com/v1", "model": "gpt-4o"},
    "xai": {"base_url": "https://api.x.ai/v1", "model": "grok-4"},
}


@dataclass(frozen=True)
class Settings:
    # LLM
    llm_provider: str
    llm_api_key: str
    llm_base_url: str
    llm_model: str

    # Embeddings
    openai_api_key: str
    embedding_base_url: str
    embedding_model: str
    embedding_dim: int

    # Auth
    admin_token: str
    allow_unauthenticated: bool

    # Storage
    store_backend: str
    db_path: Path
    supabase_url: str
    supabase_service_key: str

    # Dedup
    recall_k: int
    candidate_floor: float
    auto_duplicate_threshold: float
    judge_enabled: bool

    # Classifier
    min_engagement: int

    # Grounding
    grounding_enabled: bool
    grounding_strict: bool

    # Resolution
    auto_settle: bool
    auto_settle_confidence: float

    def require_llm(self) -> None:
        if not self.llm_api_key:
            fallback = "OPENAI_API_KEY" if self.llm_provider == "openai" else "XAI_API_KEY"
            raise RuntimeError(
                f"No LLM key for provider {self.llm_provider!r}. Set LLM_API_KEY "
                f"(or {fallback}) in .env."
            )

    def require_embeddings(self) -> None:
        if not self.openai_api_key:
            raise RuntimeError("OPENAI_API_KEY is not set — copy .env.example to .env and fill it in.")


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    db_path = Path(os.getenv("DB_PATH", "data/markets.db"))
    if not db_path.is_absolute():
        db_path = ROOT / db_path

    provider = os.getenv("LLM_PROVIDER", "openai").strip().lower()
    if provider not in PROVIDERS:
        raise RuntimeError(
            f"LLM_PROVIDER={provider!r} is not one of {sorted(PROVIDERS)}. "
            "Any OpenAI-compatible endpoint also works: pick either provider and "
            "override LLM_BASE_URL and LLM_MODEL."
        )
    defaults = PROVIDERS[provider]
    openai_key = os.getenv("OPENAI_API_KEY", "")

    # Explicit LLM_API_KEY wins; otherwise fall back to whichever provider key is
    # already configured, so a single OPENAI_API_KEY runs the whole pipeline.
    llm_key = os.getenv("LLM_API_KEY") or (
        openai_key if provider == "openai" else os.getenv("XAI_API_KEY", "")
    )

    return Settings(
        llm_provider=provider,
        llm_api_key=llm_key,
        llm_base_url=os.getenv("LLM_BASE_URL") or defaults["base_url"],
        llm_model=os.getenv("LLM_MODEL") or defaults["model"],
        openai_api_key=openai_key,
        embedding_base_url=os.getenv("EMBEDDING_BASE_URL", "https://api.openai.com/v1"),
        embedding_model=os.getenv("EMBEDDING_MODEL", "text-embedding-3-small"),
        embedding_dim=int(os.getenv("EMBEDDING_DIM", "1536")),
        admin_token=os.getenv("ADMIN_TOKEN", "").strip(),
        allow_unauthenticated=_bool("ALLOW_UNAUTHENTICATED", False),
        store_backend=os.getenv("STORE_BACKEND", "sqlite").strip().lower(),
        db_path=db_path,
        supabase_url=os.getenv("SUPABASE_URL", "").strip()
        or os.getenv("NEXT_PUBLIC_SUPABASE_URL", "").strip(),
        supabase_service_key=os.getenv("SUPABASE_SERVICE_KEY", "").strip(),
        recall_k=int(os.getenv("RECALL_K", "8")),
        candidate_floor=float(os.getenv("CANDIDATE_FLOOR", "0.55")),
        auto_duplicate_threshold=float(os.getenv("AUTO_DUPLICATE_THRESHOLD", "0.97")),
        judge_enabled=_bool("JUDGE_ENABLED", True),
        min_engagement=int(os.getenv("MIN_ENGAGEMENT", "500")),
        grounding_enabled=_bool("GROUNDING_ENABLED", True),
        grounding_strict=_bool("GROUNDING_STRICT", True),
        auto_settle=_bool("AUTO_SETTLE", False),
        auto_settle_confidence=float(os.getenv("AUTO_SETTLE_CONFIDENCE", "0.9")),
    )
