-- Related X posts tagged under each prediction market.
-- Populated by the CF worker via X recent search when a market is created.

create table if not exists public.market_related_tweets (
  id uuid primary key default gen_random_uuid(),
  market_id uuid not null references public.markets(id) on delete cascade,
  tweet_id text not null,
  author_id text,
  author_username text,
  author_name text,
  author_avatar_url text,
  text text not null,
  tweet_url text not null,
  like_count integer not null default 0 check (like_count >= 0),
  repost_count integer not null default 0 check (repost_count >= 0),
  reply_count integer not null default 0 check (reply_count >= 0),
  impression_count integer not null default 0 check (impression_count >= 0),
  relevance_score numeric(14,4) not null default 0,
  rank integer not null default 0 check (rank >= 0),
  is_source boolean not null default false,
  tweet_created_at timestamptz,
  fetched_at timestamptz not null default now(),
  unique (market_id, tweet_id)
);

create index if not exists market_related_tweets_market_rank_idx
  on public.market_related_tweets (market_id, rank asc, relevance_score desc);

create index if not exists market_related_tweets_tweet_id_idx
  on public.market_related_tweets (tweet_id);

alter table public.market_related_tweets enable row level security;

create policy "Related tweets are publicly readable"
on public.market_related_tweets for select
to anon, authenticated
using (
  exists (
    select 1
    from public.markets m
    where m.id = market_id
      and m.status in ('open', 'closed', 'resolved')
  )
);

grant select on table public.market_related_tweets to anon, authenticated;

comment on table public.market_related_tweets is
  'Top relevant X posts for each market, fetched via search/recent on create and optional refresh.';
