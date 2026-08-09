"""Score the pipeline against the labelled corpora in evals/.

    python -m scripts.eval sweep      # thresholds only — embeddings, no LLM calls
    python -m scripts.eval dedup      # full dedup stack incl. the judge
    python -m scripts.eval classify   # classifier decisions
    python -m scripts.eval spec       # EventSpec -> validated MarketSpec
    python -m scripts.eval all

Runs against a scratch store, never your real markets.db.
"""

from __future__ import annotations

import asyncio
import sys
import tempfile
from pathlib import Path

from app.classifier import Classifier
from app.config import get_settings
from app.dedup import Deduplicator
from app.embeddings import OpenAIEmbedder
from app.grounding import Grounder
from app.llm import LLMClient
from app.question import QuestionGenerator
from app.store import VectorStore
from evals.runner import (
    eval_classifier,
    eval_dedup,
    eval_grounding,
    eval_spec,
    load,
    seed_corpus,
    sweep_thresholds,
)

GREEN, RED, DIM, RESET = "\033[32m", "\033[31m", "\033[2m", "\033[0m"


def _pct(x: float) -> str:
    colour = GREEN if x >= 0.9 else RED if x < 0.75 else ""
    return f"{colour}{x:6.1%}{RESET}"


async def _scratch_store(settings, embedder):
    tmp = Path(tempfile.mkdtemp(prefix="eval-")) / "eval.db"
    store = VectorStore(tmp, dim=settings.embedding_dim)
    data = load("cases_dedup.json")
    await seed_corpus(store, embedder, data["markets"])
    return store, data


async def run_sweep(settings, embedder) -> None:
    store, data = await _scratch_store(settings, embedder)
    try:
        rows = await sweep_thresholds(
            store, embedder, data["cases"],
            floors=[0.40, 0.50, 0.55, 0.60, 0.70, 0.80],
            auto_threshold=settings.auto_duplicate_threshold,
        )
        print(f"\nTHRESHOLD SWEEP  (embeddings only, auto_threshold="
              f"{settings.auto_duplicate_threshold})\n")
        print(f"  {'floor':>6}  {'recall':>8}  {'avg cands':>10}  "
              f"{'auto-dup ok':>12}  {'auto-dup WRONG':>15}")
        for r in rows:
            wrong = f"{RED}{r.auto_dup_wrong:>15}{RESET}" if r.auto_dup_wrong else f"{r.auto_dup_wrong:>15}"
            print(f"  {r.floor:>6.2f}  {_pct(r.retrieval_recall)}  "
                  f"{r.mean_candidates:>10.1f}  {r.auto_dup_correct:>12}  {wrong}")
        print(f"\n  {DIM}recall = true duplicate present in the candidate set; below the floor")
        print(f"  the judge never sees it. auto-dup WRONG = similarity alone would have")
        print(f"  blocked a legitimate market.{RESET}")
    finally:
        store.close()


async def run_dedup(settings, embedder, llm) -> None:
    store, data = await _scratch_store(settings, embedder)
    try:
        dedup = Deduplicator(
            store, embedder, llm if settings.judge_enabled else None,
            recall_k=settings.recall_k,
            candidate_floor=settings.candidate_floor,
            auto_duplicate_threshold=settings.auto_duplicate_threshold,
        )
        report = await eval_dedup(dedup, data["cases"])
        s = report.score

        print(f"\nDEDUP  ({len(data['cases'])} cases, judge="
              f"{'on' if settings.judge_enabled else 'off'}, model={settings.llm_model})\n")
        print(f"  retrieval recall  {_pct(report.retrieval_recall)}   "
              f"({report.recall_hits}/{report.recall_total} true duplicates surfaced)")
        print(f"  accuracy          {_pct(s.accuracy)}")
        print(f"  precision         {_pct(s.precision)}   {DIM}of markets blocked, how many really were dupes{RESET}")
        print(f"  recall            {_pct(s.recall)}   {DIM}of real dupes, how many got blocked{RESET}")
        print(f"  f1                {_pct(s.f1)}")
        print(f"  {DIM}tp={s.tp} fp={s.fp} tn={s.tn} fn={s.fn}{RESET}")

        if report.failures:
            print(f"\n  {RED}{len(report.failures)} failure(s):{RESET}")
            for c in report.failures:
                print(f"    {RED}✗{RESET} {c.name}")
                print(f"        expected {c.expected}, got {c.got}")
                print(f"        {DIM}{c.detail}{RESET}")
        else:
            print(f"\n  {GREEN}all cases passed{RESET}")
    finally:
        store.close()


async def run_classify(settings, llm) -> None:
    data = load("cases_classify.json")
    classifier = Classifier(llm, min_engagement=settings.min_engagement)
    report = await eval_classifier(classifier, data["cases"])

    print(f"\nCLASSIFIER  ({report.total} cases, model={settings.llm_model})\n")
    print(f"  decision accuracy  {_pct(report.accuracy)}  ({report.correct}/{report.total})")
    if report.date_total:
        print(f"  date accuracy      {_pct(report.date_accuracy)}  "
              f"({report.date_correct}/{report.date_total})")

    print(f"\n  {DIM}confusion (expected -> got){RESET}")
    for expected in ("CREATE", "WAIT", "REJECT"):
        got = report.confusion.get(expected, {})
        if got:
            cells = "  ".join(f"{k}:{v}" for k, v in sorted(got.items()))
            print(f"    {expected:>7} -> {cells}")

    if report.failures:
        print(f"\n  {RED}{len(report.failures)} failure(s):{RESET}")
        for c in report.failures:
            print(f"    {RED}✗{RESET} {c.name}: expected {c.expected}, got {c.got}")
            print(f"        {DIM}{c.detail}{RESET}")
    else:
        print(f"\n  {GREEN}all cases passed{RESET}")


async def run_grounding(settings, llm) -> None:
    data = load("cases_grounding.json")
    grounder = Grounder(llm, strict=settings.grounding_strict)
    report = await eval_grounding(grounder, data["cases"])
    s = report.score

    print(f"\nGROUNDING  ({len(data['cases'])} cases, model={settings.llm_model})\n")
    print(f"  accuracy          {_pct(s.accuracy)}")
    print(f"  precision         {_pct(s.precision)}   {DIM}of markets blocked, how many were really unfounded{RESET}")
    print(f"  recall            {_pct(s.recall)}   {DIM}of unfounded markets, how many got blocked{RESET}")
    if report.support_total:
        print(f"  date_support       {_pct(report.support_correct / report.support_total)}  "
              f"({report.support_correct}/{report.support_total})")
    print(f"  {DIM}{report.llm_calls_saved}/{len(data['cases'])} decided without an LLM call{RESET}")

    if report.failures:
        print(f"\n  {RED}{len(report.failures)} failure(s):{RESET}")
        for c in report.failures:
            print(f"    {RED}X{RESET} {c.name}: expected {c.expected}, got {c.got}")
            print(f"        {DIM}{c.detail}{RESET}")
    else:
        print(f"\n  {GREEN}all cases passed{RESET}")


async def run_spec(settings, llm) -> None:
    data = load("cases_spec.json")
    report = await eval_spec(QuestionGenerator(llm), data["cases"])

    print(f"\nMARKET SPEC  ({report.generated} events, model={settings.llm_model})\n")
    print(f"  spec validity      {_pct(report.validity)}  "
          f"({report.valid}/{report.generated} passed deterministic validation)")
    print(f"  property checks    {_pct(report.property_accuracy)}  "
          f"({report.property_passes}/{report.property_checks})")
    if report.rejected:
        print(f"  {DIM}{report.rejected} rejected outright after the repair pass{RESET}")

    if report.failures:
        print(f"\n  {RED}{len(report.failures)} failure(s):{RESET}")
        for c in report.failures:
            print(f"    {RED}X{RESET} {c.name}: expected {c.expected}, got {c.got}")
            print(f"        {DIM}{c.detail}{RESET}")
    else:
        print(f"\n  {GREEN}all cases passed{RESET}")


async def main() -> None:
    what = sys.argv[1] if len(sys.argv) > 1 else "all"
    settings = get_settings()
    embedder = OpenAIEmbedder(settings)
    llm = LLMClient(settings)

    if what in ("sweep", "all"):
        await run_sweep(settings, embedder)
    if what in ("dedup", "all"):
        await run_dedup(settings, embedder, llm)
    if what in ("classify", "all"):
        await run_classify(settings, llm)
    if what in ("grounding", "all"):
        await run_grounding(settings, llm)
    if what in ("spec", "all"):
        await run_spec(settings, llm)
    print()


if __name__ == "__main__":
    asyncio.run(main())
