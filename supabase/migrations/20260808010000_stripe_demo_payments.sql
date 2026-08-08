create table public.stripe_payments (
  id uuid primary key default gen_random_uuid(),
  stripe_checkout_session_id text not null unique,
  user_id uuid not null references public.profiles(id) on delete restrict,
  market_id uuid not null references public.markets(id) on delete restrict,
  outcome public.market_outcome not null,
  amount numeric(14,2) not null check (amount > 0),
  price numeric(5,4) not null check (price > 0 and price < 1),
  created_at timestamptz not null default now()
);

create index stripe_payments_user_id_created_at_idx
on public.stripe_payments (user_id, created_at desc);

alter table public.stripe_payments enable row level security;

create policy "Users can read their own Stripe payments"
on public.stripe_payments for select
to authenticated
using ((select auth.uid()) = user_id);

grant select on table public.stripe_payments to authenticated;

insert into public.markets (
  slug,
  question,
  description,
  resolution_criteria,
  category,
  status,
  yes_price,
  volume,
  trader_count,
  closes_at,
  creator_x_handle
)
values
  (
    'waymo-nyc-2027',
    'Will Waymo launch a public robotaxi service in NYC before 2027?',
    'Resolves YES if Waymo launches a publicly accessible, paid autonomous ride-hailing service within New York City before January 1, 2027.',
    'A publicly accessible, paid autonomous ride-hailing service must launch within New York City before January 1, 2027.',
    'Tech', 'open', 0.6400, 12400, 842, '2027-01-01T00:00:00Z', '@mobilitybrief'
  ),
  (
    'fed-rate-cut-september',
    'Will the Fed cut rates at its September meeting?',
    'Resolves YES if the Federal Open Market Committee announces a decrease in the target federal funds rate at its September 2026 meeting.',
    'The FOMC must announce a decrease in the target federal funds rate at its September 2026 meeting.',
    'Economy', 'open', 0.4100, 38600, 2135, '2026-09-17T00:00:00Z', '@macrothread'
  ),
  (
    'gta-vi-delay',
    'Will GTA VI be delayed again before release?',
    'Resolves YES if Rockstar Games officially announces a release date later than the currently stated date before the game launches.',
    'Rockstar Games must officially announce a later release date before the game launches.',
    'Culture', 'open', 0.2800, 27900, 1847, '2026-11-19T00:00:00Z', '@controllerclub'
  ),
  (
    'openai-number-one',
    'Will a new open model lead the major AI benchmarks this year?',
    'Resolves YES if an openly downloadable model ranks first on the designated independent benchmark leaderboard before January 1, 2027.',
    'An openly downloadable model must rank first on the designated independent benchmark leaderboard before January 1, 2027.',
    'AI', 'open', 0.5200, 18200, 1094, '2027-01-01T00:00:00Z', '@latentclub'
  ),
  (
    'spacex-mars-2026',
    'Will SpaceX launch a Starship toward Mars in 2026?',
    'Resolves YES if a SpaceX Starship begins a mission with Mars as its declared destination before January 1, 2027.',
    'A SpaceX Starship must begin a mission with Mars as its declared destination before January 1, 2027.',
    'Science', 'open', 0.1900, 9700, 604, '2027-01-01T00:00:00Z', '@orbitalwatch'
  ),
  (
    'apple-smart-glasses',
    'Will Apple announce consumer smart glasses before July 2027?',
    'Resolves YES if Apple publicly announces eyewear intended for consumer sale with an integrated digital display before July 1, 2027.',
    'Apple must publicly announce consumer eyewear with an integrated digital display before July 1, 2027.',
    'Tech', 'open', 0.3600, 7600, 488, '2027-07-01T00:00:00Z', '@supplychainx'
  )
on conflict (slug) do update set
  question = excluded.question,
  description = excluded.description,
  resolution_criteria = excluded.resolution_criteria,
  category = excluded.category,
  closes_at = excluded.closes_at,
  creator_x_handle = excluded.creator_x_handle,
  updated_at = now();

create or replace function public.complete_stripe_demo_purchase(
  p_stripe_checkout_session_id text,
  p_user_id uuid,
  p_market_id uuid,
  p_outcome public.market_outcome,
  p_amount numeric,
  p_price numeric
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_payment_id uuid;
  v_shares numeric(18,6);
  v_had_market_position boolean;
begin
  if p_amount < 1 or p_amount > 100 or p_price <= 0 or p_price >= 1 then
    raise exception 'Invalid purchase values';
  end if;

  if not exists (
    select 1 from public.markets
    where id = p_market_id and status = 'open' and closes_at > now()
  ) then
    raise exception 'Market is not open';
  end if;

  v_shares := round(p_amount / p_price, 6);

  insert into public.stripe_payments (
    stripe_checkout_session_id,
    user_id,
    market_id,
    outcome,
    amount,
    price
  )
  values (
    p_stripe_checkout_session_id,
    p_user_id,
    p_market_id,
    p_outcome,
    p_amount,
    p_price
  )
  on conflict (stripe_checkout_session_id) do nothing
  returning id into v_payment_id;

  if v_payment_id is null then
    return false;
  end if;

  select exists (
    select 1 from public.positions
    where user_id = p_user_id and market_id = p_market_id
  ) into v_had_market_position;

  insert into public.trades (user_id, market_id, outcome, amount, price, shares)
  values (p_user_id, p_market_id, p_outcome, p_amount, p_price, v_shares);

  insert into public.positions (user_id, market_id, outcome, shares, average_price)
  values (p_user_id, p_market_id, p_outcome, v_shares, p_price)
  on conflict (user_id, market_id, outcome) do update set
    average_price = round(
      ((public.positions.shares * public.positions.average_price)
        + (excluded.shares * excluded.average_price))
      / (public.positions.shares + excluded.shares),
      4
    ),
    shares = public.positions.shares + excluded.shares,
    updated_at = now();

  update public.markets
  set
    volume = volume + p_amount,
    trader_count = trader_count + case when v_had_market_position then 0 else 1 end,
    updated_at = now()
  where id = p_market_id;

  return true;
end;
$$;

revoke all on function public.complete_stripe_demo_purchase(text, uuid, uuid, public.market_outcome, numeric, numeric)
from public, anon, authenticated;

grant execute on function public.complete_stripe_demo_purchase(text, uuid, uuid, public.market_outcome, numeric, numeric)
to service_role;

comment on table public.stripe_payments is
  'Stripe Sandbox Checkout sessions processed by the signed webhook. The unique session id provides idempotency.';

