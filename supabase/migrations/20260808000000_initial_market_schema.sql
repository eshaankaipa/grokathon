create extension if not exists pgcrypto;

create type public.market_status as enum ('draft', 'open', 'closed', 'resolved', 'cancelled');
create type public.market_outcome as enum ('YES', 'NO');

create table public.markets (
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

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  x_handle text,
  demo_balance numeric(14,2) not null default 1000 check (demo_balance >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.positions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  market_id uuid not null references public.markets(id) on delete cascade,
  outcome public.market_outcome not null,
  shares numeric(18,6) not null default 0 check (shares >= 0),
  average_price numeric(5,4) not null check (average_price > 0 and average_price < 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, market_id, outcome)
);

create table public.trades (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete restrict,
  market_id uuid not null references public.markets(id) on delete restrict,
  outcome public.market_outcome not null,
  amount numeric(14,2) not null check (amount > 0),
  price numeric(5,4) not null check (price > 0 and price < 1),
  shares numeric(18,6) not null check (shares > 0),
  created_at timestamptz not null default now()
);

create index markets_status_created_at_idx on public.markets (status, created_at desc);
create index markets_status_volume_idx on public.markets (status, volume desc);
create index positions_user_id_idx on public.positions (user_id);
create index trades_user_id_created_at_idx on public.trades (user_id, created_at desc);
create index trades_market_id_created_at_idx on public.trades (market_id, created_at desc);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger markets_set_updated_at
before update on public.markets
for each row execute function public.set_updated_at();

create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();

create trigger positions_set_updated_at
before update on public.positions
for each row execute function public.set_updated_at();

create or replace function public.create_profile_for_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name, x_handle)
  values (
    new.id,
    coalesce(
      new.raw_user_meta_data ->> 'full_name',
      new.raw_user_meta_data ->> 'name',
      'New trader'
    ),
    coalesce(
      new.raw_user_meta_data ->> 'user_name',
      new.raw_user_meta_data ->> 'preferred_username'
    )
  );
  return new;
end;
$$;

create trigger create_profile_after_signup
after insert on auth.users
for each row execute function public.create_profile_for_new_user();

alter table public.markets enable row level security;
alter table public.profiles enable row level security;
alter table public.positions enable row level security;
alter table public.trades enable row level security;

create policy "Markets are publicly readable"
on public.markets for select
to anon, authenticated
using (status in ('open', 'closed', 'resolved'));

create policy "Users can read their own profile"
on public.profiles for select
to authenticated
using ((select auth.uid()) = id);

create policy "Users can update their own profile"
on public.profiles for update
to authenticated
using ((select auth.uid()) = id)
with check ((select auth.uid()) = id);

create policy "Users can read their own positions"
on public.positions for select
to authenticated
using ((select auth.uid()) = user_id);

create policy "Users can read their own trades"
on public.trades for select
to authenticated
using ((select auth.uid()) = user_id);

grant select on table public.markets to anon, authenticated;
grant select on table public.profiles to authenticated;
grant update (display_name, x_handle) on table public.profiles to authenticated;
grant select on table public.positions to authenticated;
grant select on table public.trades to authenticated;

comment on table public.markets is 'Canonical prediction markets shared by the web app, bot, and extension.';
comment on table public.trades is 'Immutable trade ledger. Writes will be added through one atomic server-side function.';
