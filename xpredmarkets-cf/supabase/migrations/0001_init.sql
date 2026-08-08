-- Base Supabase schema for prediction markets.
-- Run before 001_amm_pools_and_functions.sql on a fresh database.
-- Uses IF NOT EXISTS so it is safe to apply to an already-partial database.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'market_status') THEN
    CREATE TYPE public.market_status AS ENUM (
      'draft', 'open', 'closed', 'resolved', 'cancelled'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'market_outcome') THEN
    CREATE TYPE public.market_outcome AS ENUM (
      'YES', 'NO', 'VOID'
    );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.markets (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  question text not null check (char_length(question) between 10 and 280),
  description text not null default '',
  resolution_criteria text not null,
  category text not null default 'Other',
  status public.market_status not null default 'draft',
  outcome public.market_outcome,
  yes_price numeric(5,4) not null default 0.5000 check (yes_price > 0 and yes_price < 1),
  volume numeric(14,2) not null default 0 check (volume >= 0),
  trader_count integer not null default 0 check (trader_count >= 0),
  closes_at timestamptz not null,
  resolved_at timestamptz,
  source_tweet_id text,
  source_tweet_url text,
  creator_x_handle text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint resolved_market_has_outcome check (
    (status = 'resolved' and outcome is not null)
    or (status <> 'resolved' and outcome is null)
  )
);

CREATE INDEX IF NOT EXISTS idx_markets_slug
  ON public.markets (slug);

CREATE INDEX IF NOT EXISTS idx_markets_status_created
  ON public.markets (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_markets_source_tweet
  ON public.markets (source_tweet_id);

-- Profiles, positions and trades referenced by 001_amm_pools_and_functions.sql

CREATE TABLE IF NOT EXISTS public.profiles (
  id uuid primary key default gen_random_uuid(),
  display_name text not null,
  api_key_hash text,
  api_key_prefix text,
  demo_balance numeric(14,2) not null default 1000,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

CREATE TABLE IF NOT EXISTS public.positions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  market_id uuid not null,
  outcome text not null,
  shares numeric(14,8) not null default 0,
  average_price numeric(14,8) not null default 0,
  updated_at timestamptz,
  unique (user_id, market_id, outcome)
);

CREATE TABLE IF NOT EXISTS public.trades (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  market_id uuid not null,
  outcome text not null,
  amount numeric(14,2) not null default 0,
  price numeric(14,4) not null default 0,
  shares numeric(14,8) not null default 0,
  created_at timestamptz not null default now()
);

CREATE INDEX IF NOT EXISTS idx_trades_market
  ON public.trades (market_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_positions_market
  ON public.positions (market_id, user_id);
