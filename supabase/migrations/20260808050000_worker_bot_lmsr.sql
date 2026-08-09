create or replace function public.create_market_api(
  p_question text,
  p_description text default '',
  p_resolution_criteria text default 'Resolves based on publicly available information.',
  p_category text default 'Other',
  p_closes_at timestamptz default (now() + interval '7 days'),
  p_source_tweet_id text default null,
  p_source_tweet_url text default null,
  p_creator_x_handle text default null,
  p_yes_pool numeric(14,2) default 100,
  p_no_pool numeric(14,2) default 100
)
returns public.markets
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_market public.markets%rowtype;
  v_slug text;
  v_base text;
  v_yes_price numeric;
  v_yes_shares numeric(18,6);
  v_no_shares numeric(18,6);
  v_liquidity numeric(14,2) := 1000;
begin
  v_base := left(
    trim(both '-' from lower(regexp_replace(p_question, '[^a-zA-Z0-9]+', '-', 'g'))),
    80
  );
  v_slug := v_base;
  while exists (select 1 from public.markets where markets.slug = v_slug) loop
    v_slug := left(v_base, 73) || '-' || substr(md5(gen_random_uuid()::text), 1, 6);
  end loop;

  v_yes_price := p_no_pool / (p_yes_pool + p_no_pool);

  v_yes_shares := case
    when v_yes_price >= 0.5
      then v_liquidity * ln(v_yes_price / (1 - v_yes_price))
    else 0
  end;
  v_no_shares := case
    when v_yes_price < 0.5
      then v_liquidity * ln((1 - v_yes_price) / v_yes_price)
    else 0
  end;

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
    yes_shares,
    no_shares,
    liquidity_parameter,
    closes_at,
    source_tweet_id,
    source_tweet_url,
    creator_x_handle,
    created_at,
    updated_at
  ) values (
    v_slug,
    p_question,
    p_description,
    p_resolution_criteria,
    p_category,
    'open',
    v_yes_price,
    0,
    0,
    v_yes_shares,
    v_no_shares,
    v_liquidity,
    p_closes_at,
    p_source_tweet_id,
    p_source_tweet_url,
    p_creator_x_handle,
    now(),
    now()
  )
  returning * into v_market;

  return v_market;
end;
$$;

revoke all on function public.create_market_api(text, text, text, text, timestamptz, text, text, text, numeric, numeric) from public, anon, authenticated;
grant execute on function public.create_market_api(text, text, text, text, timestamptz, text, text, text, numeric, numeric) to service_role;


create or replace function public.buy_market_position_api(
  p_user_id uuid,
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
  v_user_id uuid := p_user_id;
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

revoke all on function public.buy_market_position_api(uuid, text, public.market_outcome, numeric, uuid) from public, anon, authenticated;
grant execute on function public.buy_market_position_api(uuid, text, public.market_outcome, numeric, uuid) to service_role;


create or replace function public.sell_market_position_api(
  p_user_id uuid,
  p_market_slug text,
  p_outcome public.market_outcome,
  p_shares numeric,
  p_client_order_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_market public.markets%rowtype;
  v_position public.positions%rowtype;
  v_balance numeric;
  v_trade_id uuid;
  v_yes_before numeric;
  v_no_before numeric;
  v_yes_after numeric;
  v_no_after numeric;
  v_cost_before numeric;
  v_cost_after numeric;
  v_credits_out numeric;
  v_new_yes_price numeric;
begin
  if p_shares is null or p_shares <= 0 then
    raise exception 'Shares to sell must be greater than 0' using errcode = '22023';
  end if;

  select *
  into v_market
  from public.markets
  where markets.slug = p_market_slug
  for update;

  if not found then
    raise exception 'Market not found' using errcode = 'P0002';
  end if;

  if v_market.status <> 'open' then
    raise exception 'This market is not open for trading' using errcode = '22023';
  end if;

  select *
  into v_position
  from public.positions
  where positions.user_id = p_user_id
    and positions.market_id = v_market.id
    and positions.outcome = p_outcome
  for update;

  if not found or v_position.shares < p_shares then
    raise exception 'Insufficient shares' using errcode = '22023';
  end if;

  v_yes_before := v_market.yes_shares;
  v_no_before := v_market.no_shares;

  if p_outcome = 'YES' then
    v_yes_after := v_yes_before - p_shares;
    v_no_after := v_no_before;
  else
    v_yes_after := v_yes_before;
    v_no_after := v_no_before - p_shares;
  end if;

  v_cost_before := v_market.liquidity_parameter * ln(
    exp(v_yes_before / v_market.liquidity_parameter)
    + exp(v_no_before / v_market.liquidity_parameter)
  );
  v_cost_after := v_market.liquidity_parameter * ln(
    exp(v_yes_after / v_market.liquidity_parameter)
    + exp(v_no_after / v_market.liquidity_parameter)
  );
  v_credits_out := v_cost_before - v_cost_after;

  if v_credits_out < 0 then
    raise exception 'Invalid sell' using errcode = '22023';
  end if;

  v_new_yes_price := 1 / (
    1 + exp((v_no_after - v_yes_after) / v_market.liquidity_parameter)
  );
  v_new_yes_price := greatest(0.0001, least(0.9999, v_new_yes_price));

  update public.profiles
  set demo_balance = demo_balance + v_credits_out
  where profiles.id = p_user_id
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
    p_user_id,
    v_market.id,
    p_outcome,
    v_credits_out,
    v_credits_out / p_shares,
    p_shares,
    p_client_order_id
  ) returning id into v_trade_id;

  update public.positions
  set shares = shares - p_shares
  where positions.user_id = p_user_id
    and positions.market_id = v_market.id
    and positions.outcome = p_outcome
  returning * into v_position;

  update public.markets
  set
    yes_shares = v_yes_after,
    no_shares = v_no_after,
    yes_price = v_new_yes_price
  where markets.id = v_market.id
  returning * into v_market;

  insert into public.market_price_history (market_id, yes_price, volume)
  values (v_market.id, v_market.yes_price, v_market.volume);

  return jsonb_build_object(
    'ok', true,
    'trade_id', v_trade_id,
    'balance', v_balance,
    'credits_received', v_credits_out,
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

revoke all on function public.sell_market_position_api(uuid, text, public.market_outcome, numeric, uuid) from public, anon, authenticated;
grant execute on function public.sell_market_position_api(uuid, text, public.market_outcome, numeric, uuid) to service_role;


create or replace function public.resolve_market_api(
  p_market_id uuid,
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
  select *
  into v_market
  from public.markets
  where markets.id = p_market_id
  for update;

  if not found then
    raise exception 'Market not found' using errcode = 'P0002';
  end if;

  if v_market.status not in ('open', 'closed') then
    raise exception 'Market cannot be resolved' using errcode = '22023';
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

  delete from public.positions
  where positions.market_id = v_market.id;

  update public.markets
  set
    status = 'resolved',
    outcome = p_outcome,
    resolved_at = now(),
    yes_price = case
      when p_outcome = 'YES' then 0.9999
      else 0.0001
    end,
    updated_at = now()
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

revoke all on function public.resolve_market_api(uuid, public.market_outcome) from public, anon, authenticated;
grant execute on function public.resolve_market_api(uuid, public.market_outcome) to service_role;


create or replace function public.cancel_market_api(
  p_market_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_market public.markets%rowtype;
  v_refunds jsonb;
begin
  select *
  into v_market
  from public.markets
  where markets.id = p_market_id
  for update;

  if not found then
    raise exception 'Market not found' using errcode = 'P0002';
  end if;

  if v_market.status not in ('open', 'closed') then
    raise exception 'Market cannot be cancelled' using errcode = '22023';
  end if;

  with refunds as (
    update public.profiles
    set demo_balance = profiles.demo_balance + p.refund_amount
    from (
      select positions.user_id,
             sum(positions.shares * positions.average_price) as refund_amount
      from public.positions
      where positions.market_id = v_market.id
      group by positions.user_id
    ) p
    where profiles.id = p.user_id
    returning p.user_id, p.refund_amount
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object('user_id', user_id, 'amount', refund_amount)
      order by user_id
    ),
    '[]'::jsonb
  )
  into v_refunds
  from refunds;

  delete from public.positions
  where positions.market_id = v_market.id;

  update public.markets
  set
    status = 'cancelled',
    resolved_at = now(),
    yes_price = 0.5,
    updated_at = now()
  where markets.id = v_market.id;

  return jsonb_build_object(
    'ok', true,
    'market_id', v_market.id,
    'refunds', v_refunds
  );
end;
$$;

revoke all on function public.cancel_market_api(uuid) from public, anon, authenticated;
grant execute on function public.cancel_market_api(uuid) to service_role;
