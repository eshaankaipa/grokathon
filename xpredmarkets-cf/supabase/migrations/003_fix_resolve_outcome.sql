-- Fix resolve_market to cast the text outcome to the enum type.
-- The existing function compared positions.outcome (market_outcome) to p_outcome (text).

CREATE OR REPLACE FUNCTION public.resolve_market(
  p_market_id uuid,
  p_outcome text
) RETURNS TABLE(market public.markets, payouts integer)
LANGUAGE plpgsql
AS $$
DECLARE
  v_market public.markets;
  v_count  integer := 0;
BEGIN
  IF p_outcome NOT IN ('YES', 'NO') THEN
    RAISE EXCEPTION 'outcome must be YES or NO';
  END IF;

  SELECT * INTO v_market FROM public.markets WHERE id = p_market_id FOR UPDATE;
  IF v_market IS NULL THEN
    RAISE EXCEPTION 'market not found';
  END IF;
  IF v_market.status NOT IN ('open', 'closed') THEN
    RAISE EXCEPTION 'market cannot be resolved';
  END IF;

  UPDATE public.profiles
    SET demo_balance = demo_balance + p.shares
    FROM public.positions p
    WHERE p.market_id = p_market_id
      AND p.outcome = p_outcome::public.market_outcome
      AND public.profiles.id = p.user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;

  DELETE FROM public.positions WHERE market_id = p_market_id;

  UPDATE public.markets
    SET
      status = 'resolved',
      outcome = p_outcome::public.market_outcome,
      resolved_at = now(),
      yes_price = CASE WHEN p_outcome = 'YES' THEN 1.0000 ELSE 0.0000 END,
      updated_at = now()
    WHERE id = p_market_id
    RETURNING * INTO market;

  payouts := v_count;
  RETURN NEXT;
END;
$$;
