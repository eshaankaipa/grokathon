alter table public.trades
  add column if not exists action text not null default 'buy';

alter table public.trades
  drop constraint if exists trades_action_check;

alter table public.trades
  add constraint trades_action_check check (action in ('buy', 'sell'));

create or replace function public.sell_market_position(
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
  v_user_id uuid := auth.uid();
  v_market public.markets%rowtype;
  v_position public.positions%rowtype;
  v_balance numeric;
  v_side_price numeric;
  v_proceeds numeric;
  v_credit_proceeds numeric;
  v_execution_price numeric;
  v_new_yes_price numeric;
  v_remaining_shares numeric;
  v_has_other_position boolean;
  v_trade_id uuid;
begin
  if v_user_id is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  if p_client_order_id is null then
    raise exception 'A client order ID is required' using errcode = '22023';
  end if;

  if p_shares is null or p_shares < 0.01 or p_shares > 1000000 then
    raise exception 'Shares to sell must be between 0.01 and 1000000' using errcode = '22023';
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

  select *
  into v_position
  from public.positions
  where positions.user_id = v_user_id
    and positions.market_id = v_market.id
    and positions.outcome = p_outcome
  for update;

  if not found or v_position.shares < p_shares then
    raise exception 'You do not own enough % shares', p_outcome using errcode = '22023';
  end if;

  select profiles.demo_balance
  into v_balance
  from public.profiles
  where profiles.id = v_user_id
  for update;

  if not found then
    raise exception 'Trading profile not found' using errcode = 'P0002';
  end if;

  v_side_price := case
    when p_outcome = 'YES' then v_market.yes_price
    else 1 - v_market.yes_price
  end;

  -- Exact LMSR proceeds for removing a fixed number of shares.
  v_proceeds := -v_market.liquidity_parameter * ln(
    (1 - v_side_price) + v_side_price * exp(-p_shares / v_market.liquidity_parameter)
  );
  v_credit_proceeds := round(v_proceeds, 2);

  if v_credit_proceeds < 0.01 then
    raise exception 'This sale is too small; sell more shares' using errcode = '22023';
  end if;

  v_execution_price := v_credit_proceeds / p_shares;

  if p_outcome = 'YES' then
    v_market.yes_shares := v_market.yes_shares - p_shares;
  else
    v_market.no_shares := v_market.no_shares - p_shares;
  end if;

  v_new_yes_price := 1 / (
    1 + exp((v_market.no_shares - v_market.yes_shares) / v_market.liquidity_parameter)
  );
  v_new_yes_price := greatest(0.0001, least(0.9999, v_new_yes_price));
  v_remaining_shares := v_position.shares - p_shares;

  if v_remaining_shares <= 0.000001 then
    delete from public.positions where id = v_position.id;
    v_remaining_shares := 0;
  else
    update public.positions
    set shares = v_remaining_shares
    where id = v_position.id;
  end if;

  select exists (
    select 1
    from public.positions
    where positions.user_id = v_user_id
      and positions.market_id = v_market.id
      and positions.shares > 0
  ) into v_has_other_position;

  update public.profiles
  set demo_balance = demo_balance + v_credit_proceeds
  where profiles.id = v_user_id
  returning demo_balance into v_balance;

  insert into public.trades (
    user_id,
    market_id,
    outcome,
    amount,
    price,
    shares,
    client_order_id,
    action
  ) values (
    v_user_id,
    v_market.id,
    p_outcome,
    v_credit_proceeds,
    v_execution_price,
    p_shares,
    p_client_order_id,
    'sell'
  ) returning id into v_trade_id;

  update public.markets
  set
    yes_shares = v_market.yes_shares,
    no_shares = v_market.no_shares,
    yes_price = v_new_yes_price,
    volume = volume + v_credit_proceeds,
    trader_count = greatest(0, trader_count - case when v_has_other_position then 0 else 1 end)
  where markets.id = v_market.id
  returning * into v_market;

  insert into public.market_price_history (market_id, yes_price, volume)
  values (v_market.id, v_market.yes_price, v_market.volume);

  return jsonb_build_object(
    'ok', true,
    'duplicate', false,
    'trade_id', v_trade_id,
    'balance', v_balance,
    'shares_sold', p_shares,
    'proceeds', v_credit_proceeds,
    'execution_price', v_execution_price,
    'position_shares', v_remaining_shares,
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

revoke all on function public.sell_market_position(text, public.market_outcome, numeric, uuid) from public, anon;
grant execute on function public.sell_market_position(text, public.market_outcome, numeric, uuid) to authenticated;

comment on function public.sell_market_position(text, public.market_outcome, numeric, uuid) is
  'Atomically sells owned shares back into the LMSR market and credits demo proceeds.';
