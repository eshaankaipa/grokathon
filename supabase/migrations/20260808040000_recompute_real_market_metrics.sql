-- Remove demo-seeded metrics. The trades and positions ledgers are authoritative.
update public.markets as market
set
  volume = coalesce((
    select sum(trade.amount)
    from public.trades as trade
    where trade.market_id = market.id
  ), 0),
  trader_count = coalesce((
    select count(distinct position.user_id)
    from public.positions as position
    where position.market_id = market.id
      and position.shares > 0
  ), 0);

-- Existing baseline entries inherited seeded volume, so begin clean histories at the
-- current canonical probability and ledger-derived volume.
truncate table public.market_price_history restart identity;

insert into public.market_price_history (market_id, yes_price, volume, recorded_at)
select id, yes_price, volume, now()
from public.markets;
