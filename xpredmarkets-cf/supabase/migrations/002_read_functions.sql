-- RPC wrappers for reading markets. These bypass PostgREST's schema cache
-- so they always return the yes_pool / no_pool columns we added in 001.

CREATE OR REPLACE FUNCTION public.get_market(p_market_id uuid)
RETURNS public.markets
LANGUAGE plpgsql
AS $$
DECLARE
  v_market public.markets;
BEGIN
  SELECT * INTO v_market FROM public.markets WHERE id = p_market_id;
  RETURN v_market;
END;
$$;

CREATE OR REPLACE FUNCTION public.list_markets(
  p_status text DEFAULT NULL,
  p_limit  int  DEFAULT 100
) RETURNS SETOF public.markets
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_status IS NOT NULL THEN
    RETURN QUERY
      SELECT * FROM public.markets
      WHERE status = p_status
      ORDER BY created_at DESC
      LIMIT p_limit;
  ELSE
    RETURN QUERY
      SELECT * FROM public.markets
      ORDER BY created_at DESC
      LIMIT p_limit;
  END IF;
END;
$$;
