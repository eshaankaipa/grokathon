from __future__ import annotations

from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Literal

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from pydantic import BaseModel, Field

from . import deps
from .auth import require_token, verify_configuration
from .embeddings import canonical_text
from .spec_validation import MarketSpecValidationError, validate_market_spec
from .models import (
    Classification,
    EventSpec,
    MarketSpec,
    DuplicateCheck,
    Market,
    PipelineResult,
    SearchHit,
    SweepResult,
    TweetCluster,
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Tests inject their own Services (fakes, temp DB) before startup; only build
    # the real API-key-backed stack when nothing has been set.
    if getattr(app.state, "services", None) is None:
        app.state.services = deps.build()
    verify_configuration(app.state.services.settings)
    try:
        yield
    finally:
        app.state.services.close()


app = FastAPI(
    title="Prediction Market Vector DB",
    description="Classifies tweet clusters into markets and blocks duplicates via vector search.",
    version="0.1.0",
    lifespan=lifespan,
)


def services(request: Request) -> deps.Services:
    return request.app.state.services


# --------------------------------------------------------------------------- #
# Request bodies
# --------------------------------------------------------------------------- #


class IngestRequest(BaseModel):
    cluster: TweetCluster
    dry_run: bool = Field(default=False, description="Run every stage but don't persist the market")


class CheckRequest(BaseModel):
    """Dedup a market you already have — no classifier call."""

    event: str
    query: str = ""
    entities: list[str] = Field(default_factory=list)
    category: str = "other"
    resolution_date: str | None = None


class SearchRequest(BaseModel):
    query: str
    k: int = 5
    statuses: list[str] = Field(default_factory=lambda: ["open"])
    min_similarity: float = 0.0


class StatusRequest(BaseModel):
    status: Literal["open", "pending_resolution", "resolved", "cancelled"]


class SweepRequest(BaseModel):
    on_date: str | None = Field(default=None, description="ISO date; defaults to today (UTC)")
    limit: int = 100


class SettleRequest(BaseModel):
    outcome: Literal["YES", "NO", "VOID"]
    evidence: str = ""


# --------------------------------------------------------------------------- #
# Routes
# --------------------------------------------------------------------------- #


@app.get("/health")
async def health(svc: deps.Services = Depends(services)) -> dict:
    return {
        "ok": True,
        "markets": svc.store.count(),
        "open": svc.store.count(status="open"),
        "pending_resolution": svc.store.count(status="pending_resolution"),
        "resolved": svc.store.count(status="resolved"),
        "auto_settle": svc.settings.auto_settle,
        "llm_provider": svc.settings.llm_provider,
        "llm_model": svc.settings.llm_model,
        "embedding_model": svc.settings.embedding_model,
        "judge": svc.settings.judge_enabled,
    }


@app.post("/spec", response_model=MarketSpec, dependencies=[Depends(require_token)])
async def generate_spec(event: EventSpec, svc: deps.Services = Depends(services)) -> MarketSpec:
    """The integration boundary: EventSpec JSON in, validated MarketSpec JSON out.

    Nothing about this repository's classifier, tweet models, or storage is
    exposed here — an upstream system on another machine only needs these two
    schemas.
    """
    try:
        return await svc.pipeline.generator.generate(event)
    except MarketSpecValidationError as exc:
        raise HTTPException(
            status_code=422,
            detail={"error": "market spec failed validation",
                    "issues": [str(i) for i in exc.issues]},
        ) from exc


@app.post("/spec/validate", dependencies=[Depends(require_token)])
async def validate_spec(spec: MarketSpec) -> dict:
    """Run the deterministic validator against a spec produced anywhere."""
    issues = validate_market_spec(spec)
    return {
        "valid": not any(i.severity == "error" for i in issues),
        "issues": [
            {"field": i.field, "code": i.code, "message": i.message, "severity": i.severity}
            for i in issues
        ],
    }


@app.post("/ingest", response_model=PipelineResult, dependencies=[Depends(require_token)])
async def ingest(body: IngestRequest, svc: deps.Services = Depends(services)) -> PipelineResult:
    """Full pipeline: tweet cluster -> CREATE / WAIT / REJECT / DUPLICATE."""
    return await svc.pipeline.run(body.cluster, dry_run=body.dry_run)


@app.post("/classify", response_model=Classification, dependencies=[Depends(require_token)])
async def classify(cluster: TweetCluster, svc: deps.Services = Depends(services)) -> Classification:
    """Stage 1 only."""
    return await svc.pipeline.classifier.classify(cluster)


@app.post("/markets/check", response_model=DuplicateCheck, dependencies=[Depends(require_token)])
async def check(body: CheckRequest, svc: deps.Services = Depends(services)) -> DuplicateCheck:
    """Stage 2 only: would this market be a duplicate?"""
    return await svc.pipeline.check_only(
        Classification(
            decision="CREATE",  # type: ignore[arg-type]
            event=body.event,
            query=body.query,
            entities=body.entities,
            category=body.category,
            resolution_date=body.resolution_date,
        )
    )


@app.post("/markets/search", response_model=list[SearchHit], dependencies=[Depends(require_token)])
async def search(body: SearchRequest, svc: deps.Services = Depends(services)) -> list[SearchHit]:
    vector = await svc.embedder.embed_one(canonical_text(event=body.query))
    return svc.store.search(
        vector, k=body.k, statuses=tuple(body.statuses), min_similarity=body.min_similarity
    )


@app.post("/markets", response_model=Market, status_code=201, dependencies=[Depends(require_token)])
async def create_market(market: Market, svc: deps.Services = Depends(services)) -> Market:
    """Index a market created elsewhere so it participates in dedup."""
    return await svc.pipeline.add_existing(market)


@app.get("/markets", response_model=list[Market], dependencies=[Depends(require_token)])
async def list_markets(
    status: str | None = None,
    limit: int = 50,
    offset: int = 0,
    svc: deps.Services = Depends(services),
) -> list[Market]:
    return svc.store.list(status=status, limit=min(limit, 200), offset=offset)


@app.get("/markets/{market_id}", response_model=Market, dependencies=[Depends(require_token)])
async def get_market(market_id: str, svc: deps.Services = Depends(services)) -> Market:
    market = svc.store.get(market_id)
    if market is None:
        raise HTTPException(status_code=404, detail=f"no market {market_id}")
    return market


@app.post("/resolve/sweep", response_model=SweepResult, dependencies=[Depends(require_token)])
async def sweep(body: SweepRequest, svc: deps.Services = Depends(services)) -> SweepResult:
    """Stage 4: settle every market whose resolution date has arrived.

    Anything the outcome source can't answer confidently becomes
    `pending_resolution` for a human — nothing settles on a guess.
    """
    return await svc.resolver.sweep(on_date=body.on_date, limit=min(body.limit, 500))


@app.get("/resolve/due", response_model=list[Market], dependencies=[Depends(require_token)])
async def due(
    on_date: str | None = None, limit: int = 100, svc: deps.Services = Depends(services)
) -> list[Market]:
    on_date = on_date or datetime.now(timezone.utc).date().isoformat()
    return svc.store.due_for_resolution(on_date=on_date, limit=min(limit, 500))


@app.get("/resolve/pending", response_model=list[Market], dependencies=[Depends(require_token)])
async def pending(limit: int = 100, svc: deps.Services = Depends(services)) -> list[Market]:
    """Markets awaiting a human decision."""
    return svc.store.list(status="pending_resolution", limit=min(limit, 500))


@app.post("/markets/{market_id}/settle", response_model=Market, dependencies=[Depends(require_token)])
async def settle(
    market_id: str, body: SettleRequest, svc: deps.Services = Depends(services)
) -> Market:
    market = svc.resolver.settle_manually(
        market_id, outcome=body.outcome, evidence=body.evidence
    )
    if market is None:
        raise HTTPException(status_code=404, detail=f"no market {market_id}")
    return market


@app.patch("/markets/{market_id}/status", response_model=Market, dependencies=[Depends(require_token)])
async def set_status(
    market_id: str, body: StatusRequest, svc: deps.Services = Depends(services)
) -> Market:
    market = svc.store.set_status(market_id, body.status)
    if market is None:
        raise HTTPException(status_code=404, detail=f"no market {market_id}")
    return market


@app.delete("/markets/{market_id}", status_code=204, response_class=Response, dependencies=[Depends(require_token)])
async def delete_market(market_id: str, svc: deps.Services = Depends(services)) -> Response:
    if not svc.store.delete(market_id):
        raise HTTPException(status_code=404, detail=f"no market {market_id}")
    return Response(status_code=204)
