-- Add AMM pool columns to the public markets table and surface AMM operations
-- as RPC functions so the Cloudflare Worker can use @supabase/supabase-js.

-- ---------------------------------------------------------------------------
-- Schema additions
-- ---------------------------------------------------------------------------

-- AMM pool reserves for constant-product market making.
ALTER TABLE public.markets
  ADD COLUMN IF NOT EXISTS yes_pool numeric(14, 2) NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS no_pool  numeric(14, 2) NOT NULL DEFAULT 100;

-- API-key auth for the X bot / Worker (not Supabase Auth)
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS api_key_hash   text,
  ADD COLUMN IF NOT EXISTS api_key_prefix text;

-- Ensure one position row per (user, market, outcome).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'positions_user_market_outcome_unique'
  ) THEN
    ALTER TABLE public.positions
      ADD CONSTRAINT positions_user_market_outcome_unique
      UNIQUE (user_id, market_id, outcome);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_api_key_hash
  ON public.profiles (api_key_hash);

-- ---------------------------------------------------------------------------
-- User helpers
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.create_profile(
  p_display_name text,
  p_api_key_hash text,
  p_api_key_prefix text
) RETURNS public.profiles
LANGUAGE plpgsql
AS $$
DECLARE
  v_profile public.profiles;
BEGIN
  INSERT INTO public.profiles (display_name, api_key_hash, api_key_prefix, demo_balance)
  VALUES (p_display_name, p_api_key_hash, p_api_key_prefix, 1000)
  RETURNING * INTO v_profile;
  RETURN v_profile;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_profile_by_api_key(p_api_key_hash text)
RETURNS public.profiles
LANGUAGE plpgsql
AS $$
DECLARE
  v_profile public.profiles;
BEGIN
  SELECT * INTO v_profile FROM public.profiles WHERE api_key_hash = p_api_key_hash;
  RETURN v_profile;
END;
$$;

-- ---------------------------------------------------------------------------
-- Market creation
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.create_market(
  p_question          text,
  p_description       text        DEFAULT '',
  p_resolution_criteria text      DEFAULT 'Resolves based on publicly available information.',
  p_category          text        DEFAULT 'Other',
  p_closes_at         timestamptz DEFAULT (now() + interval '7 days'),
  p_source_tweet_id   text        DEFAULT NULL,
  p_source_tweet_url  text        DEFAULT NULL,
  p_creator_x_handle  text        DEFAULT NULL,
  p_yes_pool          numeric(14, 2) DEFAULT 100,
  p_no_pool           numeric(14, 2) DEFAULT 100
) RETURNS public.markets
LANGUAGE plpgsql
AS $$
DECLARE
  v_slug   text;
  v_market public.markets;
BEGIN
  v_slug := lower(regexp_replace(p_question, '[^a-zA-Z0-9]+', '-', 'g'));
  v_slug := regexp_replace(v_slug, '(^-+|-+$)', '', 'g');
  v_slug := regexp_replace(v_slug, '[^a-zA-Z0-9-]', '', 'g');
  IF length(v_slug) > 80 THEN
    v_slug := left(v_slug, 80);
  END IF;

  LOOP
    BEGIN
      INSERT INTO public.markets (
        slug, question, description, resolution_criteria, category, status,
        yes_price, volume, trader_count, closes_at,
        source_tweet_id, source_tweet_url, creator_x_handle,
        yes_pool, no_pool
      ) VALUES (
        v_slug, p_question, p_description, p_resolution_criteria, p_category, 'open',
        round(p_no_pool / (p_yes_pool + p_no_pool), 4), 0, 0, p_closes_at,
        p_source_tweet_id, p_source_tweet_url, p_creator_x_handle,
        p_yes_pool, p_no_pool
      )
      RETURNING * INTO v_market;
      RETURN v_market;
    EXCEPTION WHEN unique_violation THEN
      v_slug := v_slug || '-' || substr(md5(random()::text), 1, 6);
    END;
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- Trading (constant-product AMM)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.buy_yes(
  p_user_id uuid,
  p_market_id uuid,
  p_amount numeric(14, 2)
) RETURNS TABLE(trade public.trades, market public.markets, pos public.positions)
LANGUAGE plpgsql
AS $$
DECLARE
  v_profile   public.profiles;
  v_market    public.markets;
  v_old_shares numeric;
  v_old_avg    numeric;
  v_new_no     numeric;
  v_new_yes    numeric;
  v_shares_out numeric;
  v_avg_price  numeric;
  v_p_yes      numeric;
BEGIN
  SELECT * INTO v_market FROM public.markets WHERE id = p_market_id FOR UPDATE;
  IF v_market IS NULL THEN
    RAISE EXCEPTION 'market not found';
  END IF;
  IF v_market.status <> 'open' THEN
    RAISE EXCEPTION 'market is not open';
  END IF;

  SELECT * INTO v_profile FROM public.profiles WHERE id = p_user_id FOR UPDATE;
  IF v_profile IS NULL THEN
    RAISE EXCEPTION 'user not found';
  END IF;
  IF v_profile.demo_balance < p_amount THEN
    RAISE EXCEPTION 'insufficient balance';
  END IF;

  v_new_no  := v_market.no_pool + p_amount;
  v_new_yes := round((v_market.yes_pool * v_market.no_pool) / v_new_no, 2);
  v_shares_out := round(v_market.yes_pool - v_new_yes, 8);

  IF v_shares_out <= 0 THEN
    RAISE EXCEPTION 'amount too small to receive shares';
  END IF;
  IF v_new_yes <= 0 OR v_new_no <= 0 THEN
    RAISE EXCEPTION 'market pools would become non-positive';
  END IF;

  v_avg_price := round(p_amount / v_shares_out, 4);
  v_p_yes     := round(v_new_no / (v_new_yes + v_new_no), 4);

  UPDATE public.profiles
    SET demo_balance = demo_balance - p_amount
    WHERE id = p_user_id;

  INSERT INTO public.trades (user_id, market_id, outcome, amount, price, shares)
    VALUES (p_user_id, p_market_id, 'YES', p_amount, v_avg_price, v_shares_out)
    RETURNING * INTO trade;

  SELECT shares, average_price
    INTO v_old_shares, v_old_avg
    FROM public.positions
    WHERE user_id = p_user_id AND market_id = p_market_id AND outcome = 'YES'
    FOR UPDATE;

  IF v_old_shares IS NULL THEN
    v_old_shares := 0;
    v_old_avg := 0;
  END IF;

  INSERT INTO public.positions (user_id, market_id, outcome, shares, average_price)
    VALUES (p_user_id, p_market_id, 'YES', v_old_shares + v_shares_out,
            CASE
              WHEN v_old_shares + v_shares_out = 0 THEN 0
              ELSE round((v_old_shares * v_old_avg + p_amount) / (v_old_shares + v_shares_out), 4)
            END)
    ON CONFLICT (user_id, market_id, outcome)
    DO UPDATE SET
      shares = EXCLUDED.shares,
      average_price = EXCLUDED.average_price,
      updated_at = now()
    RETURNING * INTO pos;

  UPDATE public.markets
    SET
      yes_pool = v_new_yes,
      no_pool = v_new_no,
      yes_price = v_p_yes,
      volume = volume + p_amount,
      trader_count = (SELECT count(DISTINCT user_id)
                      FROM public.positions
                      WHERE market_id = p_market_id AND shares > 0),
      updated_at = now()
    WHERE id = p_market_id
    RETURNING * INTO market;

  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.buy_no(
  p_user_id uuid,
  p_market_id uuid,
  p_amount numeric(14, 2)
) RETURNS TABLE(trade public.trades, market public.markets, pos public.positions)
LANGUAGE plpgsql
AS $$
DECLARE
  v_profile   public.profiles;
  v_market    public.markets;
  v_old_shares numeric;
  v_old_avg    numeric;
  v_new_yes    numeric;
  v_new_no     numeric;
  v_shares_out numeric;
  v_avg_price  numeric;
  v_p_yes      numeric;
BEGIN
  SELECT * INTO v_market FROM public.markets WHERE id = p_market_id FOR UPDATE;
  IF v_market IS NULL THEN
    RAISE EXCEPTION 'market not found';
  END IF;
  IF v_market.status <> 'open' THEN
    RAISE EXCEPTION 'market is not open';
  END IF;

  SELECT * INTO v_profile FROM public.profiles WHERE id = p_user_id FOR UPDATE;
  IF v_profile IS NULL THEN
    RAISE EXCEPTION 'user not found';
  END IF;
  IF v_profile.demo_balance < p_amount THEN
    RAISE EXCEPTION 'insufficient balance';
  END IF;

  v_new_yes := v_market.yes_pool + p_amount;
  v_new_no  := round((v_market.yes_pool * v_market.no_pool) / v_new_yes, 2);
  v_shares_out := round(v_market.no_pool - v_new_no, 8);

  IF v_shares_out <= 0 THEN
    RAISE EXCEPTION 'amount too small to receive shares';
  END IF;
  IF v_new_yes <= 0 OR v_new_no <= 0 THEN
    RAISE EXCEPTION 'market pools would become non-positive';
  END IF;

  v_avg_price := round(p_amount / v_shares_out, 4);
  v_p_yes     := round(v_new_no / (v_new_yes + v_new_no), 4);

  UPDATE public.profiles
    SET demo_balance = demo_balance - p_amount
    WHERE id = p_user_id;

  INSERT INTO public.trades (user_id, market_id, outcome, amount, price, shares)
    VALUES (p_user_id, p_market_id, 'NO', p_amount, v_avg_price, v_shares_out)
    RETURNING * INTO trade;

  SELECT shares, average_price
    INTO v_old_shares, v_old_avg
    FROM public.positions
    WHERE user_id = p_user_id AND market_id = p_market_id AND outcome = 'NO'
    FOR UPDATE;

  IF v_old_shares IS NULL THEN
    v_old_shares := 0;
    v_old_avg := 0;
  END IF;

  INSERT INTO public.positions (user_id, market_id, outcome, shares, average_price)
    VALUES (p_user_id, p_market_id, 'NO', v_old_shares + v_shares_out,
            CASE
              WHEN v_old_shares + v_shares_out = 0 THEN 0
              ELSE round((v_old_shares * v_old_avg + p_amount) / (v_old_shares + v_shares_out), 4)
            END)
    ON CONFLICT (user_id, market_id, outcome)
    DO UPDATE SET
      shares = EXCLUDED.shares,
      average_price = EXCLUDED.average_price,
      updated_at = now()
    RETURNING * INTO pos;

  UPDATE public.markets
    SET
      yes_pool = v_new_yes,
      no_pool = v_new_no,
      yes_price = v_p_yes,
      volume = volume + p_amount,
      trader_count = (SELECT count(DISTINCT user_id)
                      FROM public.positions
                      WHERE market_id = p_market_id AND shares > 0),
      updated_at = now()
    WHERE id = p_market_id
    RETURNING * INTO market;

  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.sell_yes(
  p_user_id uuid,
  p_market_id uuid,
  p_shares numeric
) RETURNS TABLE(trade public.trades, market public.markets, pos public.positions)
LANGUAGE plpgsql
AS $$
DECLARE
  v_profile   public.profiles;
  v_market    public.markets;
  v_old_shares numeric;
  v_old_avg    numeric;
  v_new_yes    numeric;
  v_new_no     numeric;
  v_credits_out numeric;
  v_avg_price  numeric;
  v_p_yes      numeric;
BEGIN
  SELECT * INTO v_market FROM public.markets WHERE id = p_market_id FOR UPDATE;
  IF v_market IS NULL THEN
    RAISE EXCEPTION 'market not found';
  END IF;
  IF v_market.status <> 'open' THEN
    RAISE EXCEPTION 'market is not open';
  END IF;

  SELECT shares, average_price
    INTO v_old_shares, v_old_avg
    FROM public.positions
    WHERE user_id = p_user_id AND market_id = p_market_id AND outcome = 'YES'
    FOR UPDATE;
  IF v_old_shares IS NULL OR v_old_shares < p_shares THEN
    RAISE EXCEPTION 'insufficient shares';
  END IF;

  SELECT * INTO v_profile FROM public.profiles WHERE id = p_user_id FOR UPDATE;

  v_new_yes := v_market.yes_pool + p_shares;
  v_new_no  := round((v_market.yes_pool * v_market.no_pool) / v_new_yes, 2);
  v_credits_out := round(v_market.no_pool - v_new_no, 2);

  IF v_credits_out <= 0 THEN
    RAISE EXCEPTION 'shares too small to receive credits';
  END IF;
  IF v_new_yes <= 0 OR v_new_no <= 0 THEN
    RAISE EXCEPTION 'market pools would become non-positive';
  END IF;

  v_avg_price := round(v_credits_out / p_shares, 4);
  v_p_yes     := round(v_new_no / (v_new_yes + v_new_no), 4);

  UPDATE public.profiles
    SET demo_balance = demo_balance + v_credits_out
    WHERE id = p_user_id;

  INSERT INTO public.trades (user_id, market_id, outcome, amount, price, shares)
    VALUES (p_user_id, p_market_id, 'YES', v_credits_out, v_avg_price, p_shares)
    RETURNING * INTO trade;

  DELETE FROM public.positions
    WHERE user_id = p_user_id AND market_id = p_market_id AND outcome = 'YES'
    RETURNING * INTO pos;

  IF v_old_shares > p_shares THEN
    INSERT INTO public.positions (user_id, market_id, outcome, shares, average_price)
      VALUES (p_user_id, p_market_id, 'YES', v_old_shares - p_shares, v_old_avg)
      RETURNING * INTO pos;
  END IF;

  UPDATE public.markets
    SET
      yes_pool = v_new_yes,
      no_pool = v_new_no,
      yes_price = v_p_yes,
      updated_at = now()
    WHERE id = p_market_id
    RETURNING * INTO market;

  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.sell_no(
  p_user_id uuid,
  p_market_id uuid,
  p_shares numeric
) RETURNS TABLE(trade public.trades, market public.markets, pos public.positions)
LANGUAGE plpgsql
AS $$
DECLARE
  v_profile   public.profiles;
  v_market    public.markets;
  v_old_shares numeric;
  v_old_avg    numeric;
  v_new_yes    numeric;
  v_new_no     numeric;
  v_credits_out numeric;
  v_avg_price  numeric;
  v_p_yes      numeric;
BEGIN
  SELECT * INTO v_market FROM public.markets WHERE id = p_market_id FOR UPDATE;
  IF v_market IS NULL THEN
    RAISE EXCEPTION 'market not found';
  END IF;
  IF v_market.status <> 'open' THEN
    RAISE EXCEPTION 'market is not open';
  END IF;

  SELECT shares, average_price
    INTO v_old_shares, v_old_avg
    FROM public.positions
    WHERE user_id = p_user_id AND market_id = p_market_id AND outcome = 'NO'
    FOR UPDATE;
  IF v_old_shares IS NULL OR v_old_shares < p_shares THEN
    RAISE EXCEPTION 'insufficient shares';
  END IF;

  SELECT * INTO v_profile FROM public.profiles WHERE id = p_user_id FOR UPDATE;

  v_new_no  := v_market.no_pool + p_shares;
  v_new_yes := round((v_market.yes_pool * v_market.no_pool) / v_new_no, 2);
  v_credits_out := round(v_market.yes_pool - v_new_yes, 2);

  IF v_credits_out <= 0 THEN
    RAISE EXCEPTION 'shares too small to receive credits';
  END IF;
  IF v_new_yes <= 0 OR v_new_no <= 0 THEN
    RAISE EXCEPTION 'market pools would become non-positive';
  END IF;

  v_avg_price := round(v_credits_out / p_shares, 4);
  v_p_yes     := round(v_new_no / (v_new_yes + v_new_no), 4);

  UPDATE public.profiles
    SET demo_balance = demo_balance + v_credits_out
    WHERE id = p_user_id;

  INSERT INTO public.trades (user_id, market_id, outcome, amount, price, shares)
    VALUES (p_user_id, p_market_id, 'NO', v_credits_out, v_avg_price, p_shares)
    RETURNING * INTO trade;

  DELETE FROM public.positions
    WHERE user_id = p_user_id AND market_id = p_market_id AND outcome = 'NO'
    RETURNING * INTO pos;

  IF v_old_shares > p_shares THEN
    INSERT INTO public.positions (user_id, market_id, outcome, shares, average_price)
      VALUES (p_user_id, p_market_id, 'NO', v_old_shares - p_shares, v_old_avg)
      RETURNING * INTO pos;
  END IF;

  UPDATE public.markets
    SET
      yes_pool = v_new_yes,
      no_pool = v_new_no,
      yes_price = v_p_yes,
      updated_at = now()
    WHERE id = p_market_id
    RETURNING * INTO market;

  RETURN NEXT;
END;
$$;

-- ---------------------------------------------------------------------------
-- Resolution / cancellation
-- ---------------------------------------------------------------------------

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
      AND p.outcome = p_outcome
      AND public.profiles.id = p.user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;

  DELETE FROM public.positions WHERE market_id = p_market_id;

  UPDATE public.markets
    SET
      status = 'resolved',
      outcome = p_outcome,
      resolved_at = now(),
      yes_price = CASE WHEN p_outcome = 'YES' THEN 1.0000 ELSE 0.0000 END,
      updated_at = now()
    WHERE id = p_market_id
    RETURNING * INTO market;

  payouts := v_count;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.cancel_market(p_market_id uuid)
RETURNS TABLE(market public.markets, refunds integer)
LANGUAGE plpgsql
AS $$
DECLARE
  v_market public.markets;
  v_count  integer := 0;
BEGIN
  SELECT * INTO v_market FROM public.markets WHERE id = p_market_id FOR UPDATE;
  IF v_market IS NULL THEN
    RAISE EXCEPTION 'market not found';
  END IF;
  IF v_market.status NOT IN ('open', 'closed') THEN
    RAISE EXCEPTION 'market cannot be cancelled';
  END IF;

  UPDATE public.profiles
    SET demo_balance = demo_balance + round(p.shares * p.average_price, 2)
    FROM public.positions p
    WHERE p.market_id = p_market_id
      AND public.profiles.id = p.user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;

  DELETE FROM public.positions WHERE market_id = p_market_id;

  UPDATE public.markets
    SET
      status = 'cancelled',
      resolved_at = now(),
      yes_price = 0.5000,
      updated_at = now()
    WHERE id = p_market_id
    RETURNING * INTO market;

  refunds := v_count;
  RETURN NEXT;
END;
$$;
