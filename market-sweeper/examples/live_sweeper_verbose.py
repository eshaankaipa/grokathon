"""Verbose live Background Sweeper — REAL, billable X + Grok calls, pretty terminal view.

    pip install -e ".[live]"
    python -m examples.live_sweeper_verbose

Renders the autonomous pipeline stage by stage:
  DISCOVERY -> DEDUPE -> (per topic) INGEST -> RLM CONTEXT -> CLASSIFY -> decision.
Every topic is shown as a colored card (incl. rejects/skips the plain summary hides).
Tiny X-request budget; read-only (no write/post calls).

This is an INSPECTION script: it runs the same real components as the sweeper but
orchestrates the loop inline so it can render every topic (BackgroundSweeper.run_once
only returns CREATE/WAIT). Behavior mirrors run_once exactly.
"""
from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

from classifier import ClassifierConfig, MarketCandidateClassifier
from classifier.semantic.grok import GrokSemanticClassifier
from context.config import ContextConfig
from context.grok import GrokContextBuilder
from discovery.x_trends import XTrendDiscovery
from ingestion.budget import BudgetExceeded, RequestBudget
from ingestion.x_client import XIngestionClient
from sweeper.config import SweeperConfig
from sweeper.dedup import dedupe_seeds
from sweeper.ingestion import XSeedIngestion

# ---------------------------------------------------------------- styling ----
_USE_COLOR = sys.stdout.isatty() and os.environ.get("NO_COLOR") is None
_C = {
    "reset": "\033[0m", "bold": "\033[1m", "dim": "\033[2m",
    "red": "\033[31m", "green": "\033[32m", "yellow": "\033[33m",
    "blue": "\033[34m", "magenta": "\033[35m", "cyan": "\033[36m", "grey": "\033[90m",
}


def c(text: str, *styles: str) -> str:
    if not _USE_COLOR:
        return text
    return "".join(_C[s] for s in styles) + text + _C["reset"]


_DECISION = {
    "CREATE": ("green", "🟢", "CREATE"),
    "WAIT": ("yellow", "🟡", "WAIT"),
    "REJECT": ("red", "🔴", "REJECT"),
    "SKIP": ("grey", "⚪", "SKIP (low volume)"),
}
_RULE = "─" * 72


def banner(title: str) -> None:
    print("\n" + c("▶ " + title, "bold", "cyan"))


def label(k: str, v: str) -> str:
    return f"  {c(k + ':', 'dim')} {v}"


def num(v) -> str:
    if v is None:
        return c("—", "grey")
    if isinstance(v, float):
        return f"{v:,.2f}"
    return f"{v:,}"


def _load_dotenv(path: str = ".env") -> None:
    p = Path(path)
    if not p.exists():
        return
    for line in p.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        os.environ.setdefault(key.strip(), val.strip())


def card(seed, candidate, context, result, decision_key: str) -> None:
    color, icon, word = _DECISION[decision_key]
    print("\n" + c("┌" + _RULE, color))
    head = f"{icon} {c(word, 'bold', color)}  ·  {c(seed.name, 'bold')}  {c('[' + seed.source + ']', 'grey')}"
    print(head)

    if result is not None:
        print(label("canonical event", c(str(result.canonical_event), color)))
        print(label("query", str(result.query)))
        print(label("score", f"{result.score:.3f}"))

    if candidate is not None:
        print(c("  ── ingest · X signals ──", "dim"))
        print("   " + "  ".join([
            f"{c('posts', 'dim')} {num(candidate.post_count)}",
            f"{c('authors', 'dim')} {num(candidate.unique_author_count)}",
            f"{c('engagement', 'dim')} {num(candidate.engagement_count)}",
        ]))
        print("   " + "  ".join([
            f"{c('velocity', 'dim')} {num(candidate.volume_velocity)}/hr",
            f"{c('growth', 'dim')} x{num(candidate.volume_growth)}",
            f"{c('age', 'dim')} {num(candidate.topic_age_minutes)} min",
        ]))
        if candidate.representative_posts:
            print(f"   {c('sample posts:', 'dim')}")
            for p in candidate.representative_posts[:2]:
                print(f"     {c('“' + p[:110] + '”', 'grey')}")

    if context is not None:
        print(c("  ── context · Grok RLM ──", "dim"))
        print(f"   {context.summary[:340]}")
        if context.entities:
            print(f"   {c('entities:', 'dim')} {', '.join(context.entities[:8])}")
        if context.unresolved_events:
            print(f"   {c('unresolved:', 'dim')}")
            for u in context.unresolved_events[:4]:
                print(f"     • {u[:130]}")

    if result is not None and result.reasons:
        print(c("  ── decision · why ──", "dim"))
        for r in result.reasons:
            print(f"   {c('·', color)} {r}")
    print(c("└" + _RULE, color))


async def main() -> None:
    _load_dotenv()
    if not os.environ.get("X_BEARER_TOKEN") or not (
        os.environ.get("XAI_API_KEY") or os.environ.get("GROK_API_KEY")
    ):
        print("Set X_BEARER_TOKEN and XAI_API_KEY (in .env) to run this.")
        sys.exit(1)

    cfg = SweeperConfig(
        max_topics_per_sweep=3, max_x_requests_per_sweep=8,
        max_posts_per_topic=40, min_volume=25, debug=True,
    )

    print(c("╔" + "═" * 72, "bold", "magenta"))
    print(c("  X MARKETS · AUTONOMOUS BACKGROUND SWEEP", "bold", "magenta") + c("  (live)", "magenta"))
    print(c("╚" + "═" * 72, "bold", "magenta"))
    print(c(f"  budget {cfg.max_x_requests_per_sweep} X requests · "
            f"≤{cfg.max_topics_per_sweep} topics · min volume {cfg.min_volume} · read-only",
            "grey"))
    print(c("  REAL billable X + Grok calls — Ctrl-C within 3s to abort…", "yellow"))
    await asyncio.sleep(3)

    budget = RequestBudget(max_requests=cfg.max_x_requests_per_sweep)
    client = XIngestionClient(budget=budget)
    # FULLY AUTONOMOUS: every seed comes from live X trends, nothing hand-fed.
    # WOEID 23424977 = United States; 1 = global (use 1 if a WOEID ever errors).
    woeid = int(os.environ.get("SWEEP_WOEID", "23424977"))
    discovery = XTrendDiscovery(client, woeid=woeid, limit=cfg.max_topics_per_sweep)
    ingestion = XSeedIngestion(client, cfg)
    context_builder = GrokContextBuilder(
        config=ContextConfig(max_grok_calls_per_topic=cfg.max_context_grok_calls_per_topic))
    classifier = MarketCandidateClassifier(
        semantic_classifier=GrokSemanticClassifier(), config=ClassifierConfig())

    counts = {"CREATE": 0, "WAIT": 0, "REJECT": 0, "SKIP": 0}
    try:
        banner("STAGE 1 · DISCOVERY  (live X trends + configured seeds)")
        seeds = await discovery.discover()
        print(c(f"  discovered {len(seeds)} seeds:", "bold"))
        for s in seeds:
            print(f"    {c('•', 'cyan')} {c('[' + s.source + ']', 'grey'):<24} {s.name}")

        banner("STAGE 2 · DEDUPE + CAP")
        deduped = dedupe_seeds(seeds)[: cfg.max_topics_per_sweep]
        print(f"  {len(seeds)} raw {c('→', 'dim')} {c(str(len(deduped)), 'bold')} unique to process "
              f"{c(f'(cap {cfg.max_topics_per_sweep})', 'grey')}")

        banner("STAGE 3 · PER-TOPIC PIPELINE  (ingest → RLM context → classify)")
        for seed in deduped:
            candidate = await ingestion.ingest(seed)          # counts pre-filter → search
            if candidate is None:
                counts["SKIP"] += 1
                card(seed, None, None, None, "SKIP")
                continue
            context = await context_builder.build(candidate)   # Grok RLM
            result = await classifier.classify(candidate, context)
            counts[result.decision] += 1
            card(seed, candidate, context, result, result.decision)
    except BudgetExceeded:
        print(c("\n  ⚠ X request budget exhausted — stopping cleanly with partial results.", "yellow"))

    total_market = counts["CREATE"] + counts["WAIT"]
    print("\n" + c("╔═ SWEEP RESULT " + "═" * 57, "bold", "magenta"))
    print("  " + "   ".join([
        c(f"🟢 CREATE {counts['CREATE']}", "green", "bold"),
        c(f"🟡 WAIT {counts['WAIT']}", "yellow", "bold"),
        c(f"🔴 REJECT {counts['REJECT']}", "red"),
        c(f"⚪ SKIP {counts['SKIP']}", "grey"),
    ]))
    print(c(f"  {total_market} market candidate(s) for downstream  ·  "
            f"X requests spent: {budget.spent}/{cfg.max_x_requests_per_sweep}", "grey"))
    print(c("╚" + "═" * 72, "bold", "magenta"))


if __name__ == "__main__":
    asyncio.run(main())
