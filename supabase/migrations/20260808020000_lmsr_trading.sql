alter table public.markets
  add column if not exists yes_shares numeric(18,6) not null default 0 check (yes_shares >= 0),
  add column if not exists no_shares numeric(18,6) not null default 0 check (no_shares >= 0),
  add column if not exists liquidity_parameter numeric(14,2) not null default 1000 check (liquidity_parameter > 0);

alter table public.trades
  add column if not exists client_order_id uuid;

create unique index if not exists trades_user_client_order_idx
on public.trades (user_id, client_order_id)
where client_order_id is not null;

-- Initialize LMSR inventory so existing markets retain their current probability.
update public.markets
set
  yes_shares = case
    when yes_price >= 0.5
      then liquidity_parameter * ln(yes_price / (1 - yes_price))
    else 0
  end,
  no_shares = case
    when yes_price < 0.5
      then liquidity_parameter * ln((1 - yes_price) / yes_price)
    else 0
  end
where yes_shares = 0 and no_shares = 0 and yes_price <> 0.5;

create table if not exists public.market_price_history (
  id bigint generated always as identity primary key,
  market_id uuid not null references public.markets(id) on delete cascade,
  yes_price numeric(5,4) not null check (yes_price > 0 and yes_price < 1),
  volume numeric(14,2) not null check (volume >= 0),
  recorded_at timestamptz not null default now()
);

create index if not exists market_price_history_market_time_idx
on public.market_price_history (market_id, recorded_at desc);

insert into public.market_price_history (market_id, yes_price, volume)
select id, yes_price, volume
from public.markets
where not exists (
  select 1
  from public.market_price_history history
  where history.market_id = markets.id
);

alter table public.market_price_history enable row level security;

create policy "Market price history is publicly readable"
on public.market_price_history for select
to anon, authenticated
using (true);

grant select on table public.market_price_history to anon, authenticated;

create or replace function public.buy_market_position(
  p_market_slug text,
  p_outcome public.market_outcome,
  p_amount numeric,
  p_client_order_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_market public.markets%rowtype;
  v_balance numeric;
  v_side_price numeric;
  v_shares numeric;
  v_execution_price numeric;
  v_new_yes_price numeric;
  v_had_position boolean;
  v_trade_id uuid;
  v_position public.positions%rowtype;
begin
  if v_user_id is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  if p_client_order_id is null then
    raise exception 'A client order ID is required' using errcode = '22023';
  end if;

  if p_amount is null or p_amount < 1 or p_amount > 10000 then
    raise exception 'Trade amount must be between 1 and 10000 credits' using errcode = '22023';
  end if;

  select trades.id
  into v_trade_id
  from public.trades
  where trades.user_id = v_user_id
    and trades.client_order_id = p_client_order_id;

  if v_trade_id is not null then
    return jsonb_build_object('ok', true, 'duplicate', true, 'trade_id', v_trade_id);
  end if;

  select *
  into v_market
  from public.markets
  where markets.slug = p_market_slug
  for update;

  if not found then
    raise exception 'Market not found' using errcode = 'P0002';
  end if;

  if v_market.status <> 'open' or v_market.closes_at <= now() then
    raise exception 'This market is not open for trading' using errcode = '22023';
  end if;

  select profiles.demo_balance
  into v_balance
  from public.profiles
  where profiles.id = v_user_id
  for update;

  if not found then
    raise exception 'Trading profile not found' using errcode = 'P0002';
  end if;

  if v_balance < p_amount then
    raise exception 'Insufficient demo-credit balance' using errcode = '22023';
  end if;

  v_side_price := case
    when p_outcome = 'YES' then v_market.yes_price
    else 1 - v_market.yes_price
  end;

  -- Exact LMSR share quantity for a fixed spend at the current marginal price.
  v_shares := v_market.liquidity_parameter * ln(
    (exp(p_amount / v_market.liquidity_parameter) - (1 - v_side_price)) / v_side_price
  );
  v_execution_price := p_amount / v_shares;

  if p_outcome = 'YES' then
    v_market.yes_shares := v_market.yes_shares + v_shares;
  else
    v_market.no_shares := v_market.no_shares + v_shares;
  end if;

  v_new_yes_price := 1 / (
    1 + exp((v_market.no_shares - v_market.yes_shares) / v_market.liquidity_parameter)
  );
  v_new_yes_price := greatest(0.0001, least(0.9999, v_new_yes_price));

  select exists (
    select 1 from public.positions
    where positions.user_id = v_user_id
      and positions.market_id = v_market.id
      and positions.shares > 0
  ) into v_had_position;

  update public.profiles
  set demo_balance = demo_balance - p_amount
  where profiles.id = v_user_id
  returning demo_balance into v_balance;

  insert into public.trades (
    user_id,
    market_id,
    outcome,
    amount,
    price,
    shares,
    client_order_id
  ) values (
    v_user_id,
    v_market.id,
    p_outcome,
    p_amount,
    v_execution_price,
    v_shares,
    p_client_order_id
  ) returning id into v_trade_id;

  insert into public.positions (
    user_id,
    market_id,
    outcome,
    shares,
    average_price
  ) values (
    v_user_id,
    v_market.id,
    p_outcome,
    v_shares,
    v_execution_price
  )
  on conflict (user_id, market_id, outcome)
  do update set
    average_price = (
      public.positions.shares * public.positions.average_price
      + excluded.shares * excluded.average_price
    ) / (public.positions.shares + excluded.shares),
    shares = public.positions.shares + excluded.shares
  returning * into v_position;

  update public.markets
  set
    yes_shares = v_market.yes_shares,
    no_shares = v_market.no_shares,
    yes_price = v_new_yes_price,
    volume = volume + p_amount,
    trader_count = trader_count + case when v_had_position then 0 else 1 end
  where markets.id = v_market.id
  returning * into v_market;

  insert into public.market_price_history (market_id, yes_price, volume)
  values (v_market.id, v_market.yes_price, v_market.volume);

  return jsonb_build_object(
    'ok', true,
    'duplicate', false,
    'trade_id', v_trade_id,
    'balance', v_balance,
    'shares_bought', v_shares,
    'execution_price', v_execution_price,
    'position_shares', v_position.shares,
    'position_average_price', v_position.average_price,
    'market', jsonb_build_object(
      'id', v_market.id,
      'slug', v_market.slug,
      'yes_price', v_market.yes_price,
      'volume', v_market.volume,
      'trader_count', v_market.trader_count
    )
  );
end;
$$;

revoke all on function public.buy_market_position(text, public.market_outcome, numeric, uuid) from public, anon;
grant execute on function public.buy_market_position(text, public.market_outcome, numeric, uuid) to authenticated;

create or replace function public.resolve_market_admin(
  p_market_slug text,
  p_outcome public.market_outcome
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_market public.markets%rowtype;
  v_winners integer;
  v_total_payout numeric;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Service role required' using errcode = '42501';
  end if;

  select * into v_market
  from public.markets
  where markets.slug = p_market_slug
  for update;

  if not found then
    raise exception 'Market not found' using errcode = 'P0002';
  end if;

  if v_market.status = 'resolved' then
    raise exception 'Market is already resolved' using errcode = '22023';
  end if;

  with payouts as (
    select positions.user_id, sum(positions.shares) as amount
    from public.positions
    where positions.market_id = v_market.id
      and positions.outcome = p_outcome
    group by positions.user_id
  ), credited as (
    update public.profiles
    set demo_balance = profiles.demo_balance + payouts.amount
    from payouts
    where profiles.id = payouts.user_id
    returning payouts.amount
  )
  select count(*), coalesce(sum(amount), 0)
  into v_winners, v_total_payout
  from credited;

  update public.markets
  set status = 'resolved', outcome = p_outcome, resolved_at = now()
  where markets.id = v_market.id;

  return jsonb_build_object(
    'ok', true,
    'market_id', v_market.id,
    'outcome', p_outcome,
    'winners', v_winners,
    'total_payout', v_total_payout
  );
end;
$$;

revoke all on function public.resolve_market_admin(text, public.market_outcome) from public, anon, authenticated;
grant execute on function public.resolve_market_admin(text, public.market_outcome) to service_role;
