# Background Sweeper

Autonomous vertical slice:

    X -> Topic Discovery -> activity pre-filter -> representative posts
      -> event-level Context Builder -> Market Candidate Classifier
      -> CREATE / WAIT / REJECT (+ canonical event/query)

Entry point: `await BackgroundSweeper.run_once() -> SweepResult`.

## Components (all injected)
- `discovery/` — finds `TopicSeed`s (X trends via the shared client, configured queries, fakes). Discovery never classifies.
- `ingestion` (reused) — `TopicSeed -> XIngestionClient.build_candidate_topic -> CandidateTopic` (counts pre-filter before the costly search).
- `context/` — `GrokContextBuilder` builds an event-level `TopicContext` (single pass for few posts; hierarchical chunk→synthesize for many). Understands, does not decide.
- `classifier` (reused) — decides CREATE/WAIT/REJECT, now optionally enriched by `TopicContext`.

## Budget & cost controls (`SweeperConfig`)
`max_topics_per_sweep`, `max_x_requests_per_sweep`, `max_posts_per_topic`,
`max_context_grok_calls_per_topic`, `min_volume`. Discovery and ingestion share ONE
`RequestBudget`; a low-volume seed never triggers a search; on budget exhaustion the
sweep stops cleanly and returns partial results.

## Run
    python -m examples.sweeper_demo    # offline, no keys
    python -m examples.live_sweeper    # real X + Grok (billable), tiny budget

## Scope
Stops at CREATE/WAIT/REJECT + canonical event/query. Question generation, market
creation/persistence/matching, trading, resolution, and frontend are later stages.
