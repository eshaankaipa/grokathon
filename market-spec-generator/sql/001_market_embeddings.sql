-- Market dedup index for Supabase.
--
-- Run once in the Supabase SQL editor (Dashboard -> SQL Editor -> New query).
-- Safe to re-run: every statement is idempotent.
--
-- Design: the existing `markets` table is the tradeable instrument and is NOT
-- modified. This adds one table that this service owns — the spec fields plus
-- the embedding — keyed 1:1 to `markets.id`. Status and question stay in
-- `markets` as the single source of truth; the search function joins to them.

create extension if not exists vector;

create table if not exists market_embeddings (
    market_id         uuid primary key references markets(id) on delete cascade,

    -- Spec fields this service owns. `markets` has question/category/status/
    -- closes_at already, so they are not duplicated here.
    canonical_event   text        not null,
    query             text        not null default '',
    entities          jsonb       not null default '[]'::jsonb,
    outcomes          jsonb       not null default '["YES","NO"]'::jsonb,
    resolution_sources jsonb      not null default '[]'::jsonb,
    resolution_date   date,
    -- The spec's true closing time: null when no exact time was grounded.
    -- `markets.closes_at` is NOT NULL and may hold a derived fallback instead.
    closes_at         timestamptz,

    -- Fingerprint of what the market is about. The UNIQUE constraint is what
    -- makes concurrent creation safe: two workers racing to create the same
    -- market cannot both win, even across machines.
    canonical_key     text        not null unique,

    embedding         vector(1536) not null,
    embedding_model   text        not null default '',
    source_tweet_ids  jsonb       not null default '[]'::jsonb,
    metadata          jsonb       not null default '{}'::jsonb,
    created_at        timestamptz not null default now(),
    updated_at        timestamptz not null default now()
);

create index if not exists idx_market_embeddings_resolution_date
    on market_embeddings (resolution_date);

-- NOTE: deliberately NO vector index.
--
-- pgvector's ivfflat/hnsw indexes are approximate — they can miss a true nearest
-- neighbour, and a recall miss here means a duplicate market ships silently.
-- Sequential scan is exact and, at market-list scale, fast. Add an index only
-- when the row count makes it necessary, and re-run the dedup eval afterwards to
-- measure what recall it costs:
--
--   create index on market_embeddings
--       using hnsw (embedding vector_cosine_ops);


-- Nearest live markets to a query vector.
--
-- Exposed as an RPC because PostgREST cannot express `<=>` ordering through
-- query parameters. Vectors are L2-normalized before storage, so cosine
-- distance and cosine similarity are related by `similarity = 1 - distance`.
create or replace function match_markets(
    query_embedding  vector(1536),
    match_count      int     default 8,
    min_similarity   float   default 0.0,
    -- Values of the existing market_status enum. This service's
    -- 'pending_resolution' maps to 'closed' before it gets here.
    allowed_statuses text[]  default array['open', 'closed']
)
returns table (
    market_id       uuid,
    question        text,
    canonical_event text,
    resolution_date date,
    status          text,
    similarity      float
)
language sql
stable
as $$
    select
        e.market_id,
        m.question,
        e.canonical_event,
        e.resolution_date,
        m.status::text,
        1 - (e.embedding <=> query_embedding) as similarity
    from market_embeddings e
    join markets m on m.id = e.market_id
    -- ::text cast: markets.status is an enum, allowed_statuses is text[].
    where m.status::text = any(allowed_statuses)
      and 1 - (e.embedding <=> query_embedding) >= min_similarity
    order by e.embedding <=> query_embedding
    limit match_count;
$$;


-- Row level security: this service authenticates with the service_role key,
-- which bypasses RLS. Enabling it here keeps the table closed to the anon key
-- that the frontend uses, matching how `markets` is already configured.
alter table market_embeddings enable row level security;

-- Read-only visibility for the frontend, if you want dedup results in the UI.
-- Drop this policy if the embeddings should stay entirely server-side.
drop policy if exists market_embeddings_read on market_embeddings;
create policy market_embeddings_read
    on market_embeddings for select
    to anon, authenticated
    using (true);


-- VERIFIED against this project on 2026-08-09:
--   markets.status is enum market_status (draft, open, closed, resolved, cancelled)
--   markets.closes_at, resolution_criteria, slug, question are all NOT NULL
--   markets.category is free text, conventionally capitalised
--
-- No change to `markets` is required. This service maps its own lifecycle onto
-- the existing enum (pending_resolution -> closed) and supplies a derived
-- closes_at when the spec has none. See app/supabase_store.py.
