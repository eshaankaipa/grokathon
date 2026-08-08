alter table public.stripe_payments
  alter column market_id drop not null,
  alter column outcome drop not null,
  alter column price drop not null,
  add column if not exists credits numeric(14,2) check (credits > 0);

drop function if exists public.complete_stripe_demo_purchase(
  text,
  uuid,
  uuid,
  public.market_outcome,
  numeric,
  numeric
);

create or replace function public.complete_stripe_credit_purchase(
  p_stripe_checkout_session_id text,
  p_user_id uuid,
  p_usd_amount numeric,
  p_credits numeric
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_payment_id uuid;
begin
  if p_usd_amount < 5 or p_usd_amount > 100 then
    raise exception 'Invalid Stripe purchase amount';
  end if;

  if p_credits <> p_usd_amount * 100 then
    raise exception 'Invalid credit conversion';
  end if;

  if not exists (select 1 from public.profiles where id = p_user_id) then
    raise exception 'Profile not found';
  end if;

  insert into public.stripe_payments (
    stripe_checkout_session_id,
    user_id,
    amount,
    credits
  ) values (
    p_stripe_checkout_session_id,
    p_user_id,
    p_usd_amount,
    p_credits
  )
  on conflict (stripe_checkout_session_id) do nothing
  returning id into v_payment_id;

  if v_payment_id is null then
    return false;
  end if;

  update public.profiles
  set demo_balance = demo_balance + p_credits
  where id = p_user_id;

  return true;
end;
$$;

revoke all on function public.complete_stripe_credit_purchase(text, uuid, numeric, numeric)
from public, anon, authenticated;

grant execute on function public.complete_stripe_credit_purchase(text, uuid, numeric, numeric)
to service_role;

comment on table public.stripe_payments is
  'Idempotent Stripe Sandbox wallet top-ups. Stripe purchases credits only and never create market positions.';
