# Market Spec Generator

Turns an approved real-world event into a validated, objectively resolvable
prediction-market specification — and stops the same market being created twice.

Sits downstream of [`market-sweeper/`](../market-sweeper), which decides *whether*
an event deserves a market. This service decides *what the market is*. The
boundary is JSON:

```
market-sweeper  ──▶  EventSpec JSON  ──▶  this service  ──▶  MarketSpec JSON
```

`market-sweeper`'s `ClassificationResult` already carries `canonical_event` and
`query`, which is exactly what `EventSpec` needs — see "The cluster contract" and
"Storage" below. Nothing here imports the sweeper's types; the two are only
coupled through that JSON.

```
X API
  ↓  raw trends + posts + engagement
CLUSTERING                       (upstream, not in this repo)
  ↓  TweetCluster
CLASSIFIER            ──────────▶  CREATE / WAIT / REJECT + canonical event + query
  ↓  (CREATE only)
GROUNDING             ──────────▶  WAIT, if the posts don't support the claim
  ↓
VECTOR DEDUP          ──────────▶  DUPLICATE  ─▶ return the existing market
  ↓  (new only)
QUESTION GENERATOR    ──────────▶  "Will the Golden State Warriors defeat the
  ↓                                 Los Angeles Lakers on August 8, 2026?"
STORE  (embedding + market row)  ─▶  Prediction Market
  ↓  on the resolution date
RESOLVER              ──────────▶  YES / NO / VOID, or pending_resolution
                                    for a human
```

Each stage short-circuits, so a REJECT costs one LLM call and a duplicate costs
two — not four.

## Setup

All commands run from `market-spec-generator/`.

```bash
python3 -m venv ../.venv && ../pip install -r requirements.txt
cp .env.example .env        # add OPENAI_API_KEY and ADMIN_TOKEN
```

One key runs everything. Embeddings are always OpenAI
(`text-embedding-3-small`) — xAI has no embeddings endpoint — and the two LLM
stages default to OpenAI as well, reusing the same key.

To run the LLM stages on Grok instead, set `XAI_API_KEY` (from
[console.x.ai](https://console.x.ai)) and `LLM_PROVIDER=xai`. Any other
OpenAI-compatible endpoint works too via `LLM_BASE_URL` + `LLM_MODEL`.

> `XAI_API_KEY` (xAI/Grok, console.x.ai) and `X_API_KEY` (X/Twitter,
> developer.x.com) are different credentials from different products. Same
> founder, unrelated APIs, not interchangeable.

With no LLM key at all the service still starts and the whole vector half works —
`/markets`, `/markets/search`, `/markets/check` in threshold mode, and
`scripts/seed.py`. `/ingest` and `/classify` fail on the first LLM call with a
message naming the missing key.

## Run

```bash
python -m scripts.seed          # load 3 example markets
python -m scripts.demo          # 3 clusters end-to-end: CREATE, DUPLICATE, REJECT
python -m scripts.resolve       # settle markets whose date has arrived
python -m scripts.eval all      # score against the labelled corpora
uvicorn app.main:app --reload   # http://localhost:8000/docs
python -m pytest                # 141 tests, no API keys needed
```

## Auth

Every endpoint except `/health` requires a bearer token — same header convention
as the xpred Worker, so both services can share one credential:

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" localhost:8000/markets
```

Generate one and put it in `.env`:

```bash
python -c "import secrets; print(secrets.token_urlsafe(32))"
```

**The service refuses to start with no token** unless you set
`ALLOW_UNAUTHENTICATED=1`. Defaulting to open is how a service ends up on the
public internet with an endpoint that spends money on LLM calls and creates
markets people bet on — so running without auth stays possible for local dev, but
it has to be a deliberate choice.

`/health` is deliberately public so load balancers and uptime checks work without
the admin token. It exposes counts and model names, no market content.

Token comparison is constant-time; a plain `==` leaks the token's prefix through
response timing.

## The cluster contract

`POST /ingest` takes a `TweetCluster`. Nothing in this repo produces one — that's
the seam with the upstream clustering step. Minimum viable payload:

```json
{"cluster": {"tweets": [{"id": "1", "text": "Lakers at Warriors on August 8, 2026"}]}}
```

Full shape — only `id` and `text` are required per tweet, only `tweets` on the
cluster:

| field | | |
|---|---|---|
| `tweets[].id` | **required** | real tweet ID; becomes `market.source_tweet_ids` |
| `tweets[].text` | **required** | post text, close to verbatim |
| `tweets[].likes/reposts/replies/views` | default 0 | drives the engagement gate |
| `tweets[].author`, `created_at` | optional | context for the classifier |
| `cluster_id`, `topic` | optional | echoed into `market.metadata` |

Engagement is weighted, not summed ([models.py](app/models.py#L36)):

```
engagement = likes + 3×reposts + 2×replies + views÷100
```

Reposts count triple because spread signals more than approval; views are
discounted 100× because they're noisy. The cluster total is checked against
`MIN_ENGAGEMENT` (500) — **send zeros and everything becomes WAIT.** Only the top
25 tweets by engagement reach the model, so large clusters are safe to send whole.

Three obligations that will bite the producer:

1. **One cluster = one candidate event.** The classifier assumes the posts describe
   a single thing. Over-splitting is safe — the second cluster just comes back
   `DUPLICATE`, which is what this service is for. Under-splitting isn't
   recoverable: a cluster mixing two games yields a confused event and a bad market.
2. **Don't strip dates when cleaning text.** Grounding scans raw text for date
   references, and `explicit` support is what lets a market through with no LLM
   call. A normalizer that drops "August 8, 2026" pushes every market into the
   evidence check and starts blocking legitimate ones.
3. **`id` must be the real tweet ID** — it's the only audit trail from a market
   back to what caused it.

The live schema is authoritative: `curl -s localhost:8000/openapi.json | jq
'.components.schemas.TweetCluster'`, or generate a client from `/docs`.

## The API

| Method | Path | What it does |
|--------|------|--------------|
| `POST` | `/ingest` | Full pipeline. Tweet cluster in, decision out. |
| `POST` | `/classify` | Stage 1 alone — CREATE/WAIT/REJECT + event + query. |
| `POST` | `/markets/check` | Stage 2 alone — "does this market already exist?" |
| `POST` | `/markets/search` | Raw semantic search over the market index. |
| `POST` | `/markets` | Index a market created elsewhere so it joins dedup. |
| `GET` | `/markets`, `/markets/{id}` | List / fetch. |
| `POST` | `/resolve/sweep` | Settle every market whose resolution date has arrived. |
| `GET` | `/resolve/due` | Markets ready to settle. |
| `GET` | `/resolve/pending` | Markets awaiting a human decision. |
| `POST` | `/markets/{id}/settle` | Record a final outcome by hand. |
| `PATCH` | `/markets/{id}/status` | Move between lifecycle states. |
| `DELETE` | `/markets/{id}` | Remove from the index. |
| `GET` | `/health` | Counts + which models are wired up. **Public.** |

All except `/health` require `Authorization: Bearer <ADMIN_TOKEN>`.

### Ingest

```bash
curl -sS localhost:8000/ingest -H 'content-type: application/json' -d '{
  "cluster": {
    "cluster_id": "c1",
    "topic": "#NBA",
    "tweets": [
      {"id":"1","author":"nbaonx","text":"Lakers at Warriors tomorrow, August 8.",
       "likes":5200,"reposts":1400,"replies":600,"views":1200000}
    ]
  }
}'
```

New market:

```json
{
  "decision": "CREATE",
  "event": "Golden State Warriors vs Los Angeles Lakers, Aug 8 2026",
  "query": "Warriors Lakers August 8 2026",
  "market": {
    "id": "mkt_9f2c1a7be403",
    "question": "Will the Golden State Warriors defeat the Los Angeles Lakers on August 8, 2026?",
    "resolution_criteria": "Resolves YES if the Warriors win per the official box score...",
    "resolution_date": "2026-08-08",
    "resolution_source": "NBA official box score"
  }
}
```

Already exists:

```json
{
  "decision": "DUPLICATE",
  "event": "Golden State Warriors vs Los Angeles Lakers, Aug 8 2026",
  "reason": "Inverted phrasing of the same game.",
  "duplicate_of": {
    "market_id": "mkt_9f2c1a7be403",
    "question": "Will the Golden State Warriors defeat the Los Angeles Lakers on August 8, 2026?",
    "similarity": 0.91
  }
}
```

`WAIT` and `REJECT` come back with the reason and no market.

## How dedup works

Two passes, because neither one alone is good enough.

**Recall — vector search.** The event, query, sorted entities, category, and
resolution date get flattened into one canonical string by
[`canonical_text()`](app/embeddings.py#L14) and embedded. Writes and lookups both
go through that function, so stored markets and incoming proposals always land in
the same space, and entity order never changes the vector. The store returns the
top `RECALL_K` neighbours above `CANDIDATE_FLOOR` (0.55). Nothing above the floor
means nothing close exists — no LLM call at all.

**Precision — LLM judge.** A similarity threshold on its own cannot work here.
Measured against `text-embedding-3-small` with the seed markets loaded, and the
judge's live verdict on each:

| proposal vs. existing market | truth | cosine | judge |
|---|---|---|---|
| "Lakers lose to Warriors, Aug 8" vs "Warriors defeat Lakers, Aug 8" | **duplicate** | 0.915 | ✅ duplicate |
| Warriors vs Lakers **Aug 9** vs Warriors vs Lakers **Aug 8** | **not a duplicate** | 0.984 | ✅ new |
| Bitcoin above $100k vs Bitcoin above $150k, same date | not a duplicate | 0.883 | ✅ new |
| Curry's point total vs who wins, same game | not a duplicate | 0.679 | ✅ new |
| Chiefs vs 49ers Super Bowl vs Warriors vs Lakers | not a duplicate | 0.484 | below floor |

The true duplicate scores *lower* than the false one. No threshold separates row
1 from row 2 — so the judge gets the proposal plus the candidates and decides
which real-world outcome settles which. It's told to be conservative (a missed
duplicate is a nuisance, a wrongly blocked market is lost volume), and when it
errors, dedup fails open.

The judge is skipped only when similarity clears `AUTO_DUPLICATE_THRESHOLD`
(0.97) **and** the two resolution dates are identical. That date gate is not
decoration: without it the Aug 9 row above gets auto-blocked at 0.984 by a market
for a different game. A one-sided unknown date doesn't count as agreement and
goes to the judge.

Set `JUDGE_ENABLED=0` for pure-threshold dedup with no LLM in the path — the
gate keeps that mode honest, at the cost of missing reworded duplicates.

Resolved and cancelled markets are excluded from search: the same fixture can be
re-listed next season, and a settled market should never block a new one.

## Settlement

A market moves `open → pending_resolution → resolved | cancelled`. `POST
/resolve/sweep` picks up every open market whose `resolution_date` has arrived
and asks an `OutcomeSource` how it turned out.

Finding due markets is deterministic. *Deciding* the outcome is deliberately
pluggable, because this is where a wrong answer costs real money:

| source | behaviour |
|---|---|
| `ManualOutcomeSource` (default) | Decides nothing. Every due market goes to a human. |
| `LLMOutcomeSource` (`AUTO_SETTLE=1`) | Settles only what the model confidently knows; everything else goes to a human. |

Nothing auto-settles on a guess. A verdict below `AUTO_SETTLE_CONFIDENCE` (0.9)
is downgraded to UNKNOWN and routed to review, and the resolver prompt tells the
model to answer UNKNOWN whenever it is reasoning from priors, form, or odds
rather than a specific known result.

That is not a hedge — it's the actual behaviour. Live sweep against `gpt-4o` for
a game dated after its training cutoff:

```
checked 1 | settled 0 | needs review 1
  status: pending_resolution  confidence: 0.00
  "The event date is after my training cutoff, and I have no access to live
   data or the NBA official box score for the game on August 8, 2026."
```

A plain chat model has no live data, so it correctly settles almost nothing.
Point `LLMOutcomeSource` at a model with live retrieval (Grok with X search) or
write an `OutcomeSource` against a real scores/prices feed, and the auto-settle
rate climbs without any other change. Until then, humans settle via
`POST /markets/{id}/settle`.

Settlement is also what keeps dedup correct over time: a resolved market drops
out of the vector search, so next season's fixture is no longer blocked by last
season's. Markets in `pending_resolution` still block.

## Evaluation

Thresholds, prompts, and model choices are only tunable if a change can be
measured. `evals/` holds two labelled corpora — 25 dedup cases against a 9-market
corpus, 12 classifier clusters, 8 grounding cases — weighted toward the hard cases: inversions,
same-teams-different-day, same-asset-different-threshold, same-game-different-prop.

```bash
python -m scripts.eval sweep      # thresholds only — embeddings, no LLM calls
python -m scripts.eval dedup      # full dedup stack incl. the judge
python -m scripts.eval classify   # classifier decisions + date extraction
python -m scripts.eval grounding  # is the market supported by its source posts
```

Current, against `gpt-4o` and `text-embedding-3-small`:

| | |
|---|---|
| dedup retrieval recall | 100% (12/12 true duplicates surfaced) |
| dedup precision / recall / F1 | 100% / 100% / 100% (25 cases) |
| classifier decision accuracy | 100% (12/12) |
| classifier date extraction | 100% |
| grounding precision / recall | 100% / 100% (8 cases) |

The two dedup stages are scored **separately** on purpose. A retrieval failure
means the vector store never surfaced the right candidate and the judge never got
a chance — a floor/`k` problem. A judge failure means the candidate was right
there and the model called it wrong — a prompt or model problem. One blended
number hides which one you have.

`sweep` needs no LLM calls and shows what `CANDIDATE_FLOOR` buys:

```
 floor    recall   avg cands   auto-dup ok   auto-dup WRONG
  0.55    100.0%         1.4             1                1
  0.80     91.7%         0.8             1                1
```

Raising the floor to 0.80 starts dropping true duplicates while saving almost
nothing. And `auto-dup WRONG = 1` at every floor is the harness independently
rediscovering the bug documented above: similarity alone, at any threshold, would
block one legitimate market. That's what the date gate prevents.

The harness earned its keep on first run. It caught the classifier sending a
scheduled Apple keynote to WAIT because "the specific outcomes are not yet
defined" — the prompt had conflated *not knowing the answer* with *not being able
to write the question*. Outcome uncertainty is the entire point of a prediction
market. One prompt edit took the classifier from 11/12 to 12/12.

## The create race

Dedup checks, then the question generator runs an LLM call taking seconds, then
the write lands. Two identical clusters ingested concurrently both pass the check
and both write — duplicate markets that split liquidity, the exact thing dedup
exists to prevent. Measured, with the guards removed:

```
WITHOUT guards -> decisions=['CREATE','CREATE','CREATE','CREATE']  markets=4
WITH guards    -> decisions=['CREATE','DUPLICATE','DUPLICATE','DUPLICATE']  markets=1
```

Two layers fix it. The write re-checks under an `asyncio.Lock` that covers only
the write, not the LLM calls before it. And `markets.canonical_key` — a hash of
the normalized event, category, date, and sorted entities — carries a UNIQUE
index, so a second process writing the same market gets an IntegrityError that
surfaces as a normal `DUPLICATE` response. The lock is the fast path; the index
is the actual guarantee.

## Grounding

The classifier reads post text and writes down an event and a resolution date. It
cannot verify either. A market on a fixture that was never scheduled can never be
settled — it has to be voided after money has already moved — so before a market
is created, the claim is checked against the posts it came from.

The date check is a **text scan, not an LLM call** ([dates.py](app/dates.py)).
It parses every date the posts mention (`August 8, 2026`, `Aug 8th`, `8/8/2026`,
ISO, bare `February 7` resolving to its next occurrence) and classifies support:

| | meaning | action |
|---|---|---|
| `explicit` | the posts name that date | accept, no LLM call |
| `relative` | the posts pin timing without a date — "tomorrow", "kickoff", "next Friday" | accept, no LLM call |
| `mismatch` | the posts name *other* dates | escalate |
| `absent` | the posts say nothing about when | escalate |

`absent` doesn't reject on its own, because a date can be legitimate without
appearing in the text — "Super Bowl LXI" implies one. Those escalate to an
evidence check that must **quote the span** supporting the claim; a claim it
can't quote isn't supported. That check also catches invented specifics — a
threshold, a venue, an opponent no post mentions — and speculation ("rumours of")
restated as scheduled fact. It fails closed: if the check errors, the market is
blocked, because a guard that opens the gate when it breaks isn't a guard.

Measured over 8 adversarial cases: 100% precision and recall, and **3/8 decided
with no LLM call**. On well-formed clusters the date is nearly always explicit,
so the common path costs nothing.

**How much is this guard actually doing?** Less than I expected, and worth being
straight about. I added it because I'd flagged that the classifier could invent
dates — but when tested against clusters built to tempt exactly that (an Apple
keynote, an FOMC meeting, and a World Series, each with no date stated), `gpt-4o`
returned `WAIT` with `resolution_date: null` all three times rather than filling
one in. It doesn't hallucinate dates at this model tier.

So this is insurance, not a fix for an observed failure: it costs ~nothing on the
happy path, it catches the `mismatch` case the classifier wouldn't, and it earns
its place the moment you swap to a cheaper model for cost reasons. Set
`GROUNDING_ENABLED=0` to remove it entirely.

## Deterministic guards

The classifier's judgment is overridden by code in three cases, so a confident
model can't push junk into the market list:

- cluster engagement below `MIN_ENGAGEMENT` → `WAIT`
- `CREATE` with no extractable event or query → `WAIT`
- resolution date already in the past → `REJECT`

The classifier is also prompted to reject markets on anyone's death, injury,
arrest, or medical condition, and anything targeting a private individual.

The classifier's resolution date wins over the generator's — it saw the actual
posts, and the generator drifts a day on events that straddle a timezone
boundary.

## Storage

An embedded vector database — SQLite for persistence, NumPy for the math, no
third-party vector store. Vectors live in an `embedding BLOB` column as raw
float32; search loads them into one `(n_markets, dim)` matrix and takes a dot
product, which *is* cosine because vectors are L2-normalized at embed time. The
matrix is rebuilt lazily whenever a write dirties it.

Search is **exact**, not approximate. HNSW-based stores (Chroma, pgvector,
Pinecone) trade recall for speed, and a recall miss here means a duplicate market
ships silently — the one failure this whole component exists to prevent. Given
that a true duplicate can score 0.915 while a hard negative scores 0.984, the
candidate set feeding the judge is doing delicate work and is not worth
approximating.

The cost is linear: every live market is scored on every query, and the matrix
holds ~6 KB per market in RAM. Comfortable into the tens of thousands; past
roughly a million vectors, or once several processes need to write concurrently,
a dedicated store starts to earn its keep.

Everything storage-related is behind [`VectorStore`](app/store.py). Moving to
Pinecone, Cloudflare Vectorize, or pgvector means reimplementing `upsert`,
`search`, and `get`; nothing else in the codebase touches it.

## Layout

| File | |
|------|--|
| [app/classifier.py](app/classifier.py) | Stage 1 + the deterministic guards |
| [app/dedup.py](app/dedup.py) | Stage 2, recall + judge |
| [app/grounding.py](app/grounding.py) | Claim verification against the source posts |
| [app/dates.py](app/dates.py) | Date parsing for the no-LLM grounding check |
| [app/question.py](app/question.py) | Stage 3 |
| [app/resolver.py](app/resolver.py) | Stage 4, settlement + pluggable outcome sources |
| [app/pipeline.py](app/pipeline.py) | Orchestration, short-circuiting, create race |
| [app/store.py](app/store.py) | The vector DB |
| [app/embeddings.py](app/embeddings.py) | Embeddings + `canonical_text()` |
| [app/prompts.py](app/prompts.py) | Every prompt, tunable without touching logic |
| [app/main.py](app/main.py) | FastAPI surface |
| [app/auth.py](app/auth.py) | Bearer-token gate + startup guard |
| [evals/](evals/) | Labelled corpora + scoring for dedup and the classifier |

Tuning knobs are all in [.env.example](.env.example).
