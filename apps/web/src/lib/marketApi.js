import { supabase } from "./supabase";

const MARKET_FIELDS = [
  "id",
  "slug",
  "question",
  "description",
  "resolution_criteria",
  "category",
  "status",
  "outcome",
  "yes_price",
  "volume",
  "trader_count",
  "liquidity_parameter",
  "closes_at",
  "resolved_at",
  "source_tweet_id",
  "source_tweet_url",
  "creator_x_handle",
  "created_at",
].join(",");

const accents = ["violet", "orange", "blue", "green", "red", "yellow"];

function accentFor(value = "") {
  const hash = [...value].reduce((total, character) => total + character.charCodeAt(0), 0);
  return accents[hash % accents.length];
}

export function mapMarket(record, history = []) {
  const yesPrice = Number(record.yes_price);
  const historyValues = history.map((point) => Number(point.yes_price) * 100);
  const spark = historyValues.length > 1 ? historyValues : [yesPrice * 100, yesPrice * 100];
  const firstPrice = spark[0] / 100;
  const priceDelta = yesPrice - firstPrice;
  return {
    dbId: record.id,
    id: record.slug,
    category: record.category,
    question: record.question,
    description: record.description,
    resolutionCriteria: record.resolution_criteria,
    yesPrice,
    change: Math.round(priceDelta * 100),
    trend: priceDelta > 0 ? "up" : priceDelta < 0 ? "down" : "flat",
    volume: Number(record.volume),
    traders: Number(record.trader_count),
    liquidityParameter: Number(record.liquidity_parameter || 1000),
    status: record.status,
    outcome: record.outcome,
    closesAtIso: record.closes_at,
    closesAt: new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(new Date(record.closes_at)),
    createdAt: record.created_at,
    creator: record.creator_x_handle,
    sourceTweetId: record.source_tweet_id,
    sourceTweetUrl: record.source_tweet_url,
    accent: accentFor(record.category || record.slug),
    spark,
  };
}

function requireClient() {
  if (!supabase) throw new Error("Supabase is not configured.");
  return supabase;
}

export async function listMarkets() {
  const client = requireClient();
  const { data, error } = await client
    .from("markets")
    .select(MARKET_FIELDS)
    .in("status", ["open", "closed", "resolved"])
    .order("volume", { ascending: false });
  if (error) throw error;

  const markets = data || [];
  if (!markets.length) return [];

  const { data: history, error: historyError } = await client
    .from("market_price_history")
    .select("market_id,yes_price,recorded_at")
    .in("market_id", markets.map((market) => market.id))
    .gte("recorded_at", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
    .order("recorded_at", { ascending: true })
    .limit(2000);

  const historyByMarket = new Map();
  if (!historyError) {
    for (const point of history || []) {
      const points = historyByMarket.get(point.market_id) || [];
      points.push(point);
      historyByMarket.set(point.market_id, points);
    }
  }

  return markets.map((record) =>
    mapMarket(record, historyByMarket.get(record.id)?.slice(-120) || []),
  );
}

export async function getMarket(slug) {
  const client = requireClient();
  const { data, error } = await client
    .from("markets")
    .select(MARKET_FIELDS)
    .eq("slug", slug)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  const { data: history, error: historyError } = await client
    .from("market_price_history")
    .select("yes_price,recorded_at")
    .eq("market_id", data.id)
    .gte("recorded_at", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
    .order("recorded_at", { ascending: true })
    .limit(120);

  return mapMarket(data, historyError ? [] : history || []);
}

export async function getProfile(userId) {
  const client = requireClient();
  const { data, error } = await client
    .from("profiles")
    .select("id,display_name,x_handle,demo_balance")
    .eq("id", userId)
    .single();
  if (error) throw error;
  return data;
}

export async function getPositions() {
  const client = requireClient();
  const { data, error } = await client
    .from("positions")
    .select("market_id,outcome,shares,average_price,updated_at,markets(id,slug,question,yes_price,status,outcome)")
    .gt("shares", 0)
    .order("updated_at", { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function getMarketPositions(marketId) {
  const client = requireClient();
  const { data, error } = await client
    .from("positions")
    .select("outcome,shares,average_price")
    .eq("market_id", marketId)
    .gt("shares", 0);
  if (error) throw error;
  return data || [];
}

export async function buyPosition({ marketSlug, outcome, amount, clientOrderId }) {
  const client = requireClient();
  const { data, error } = await client.rpc("buy_market_position", {
    p_market_slug: marketSlug,
    p_outcome: outcome,
    p_amount: amount,
    p_client_order_id: clientOrderId,
  });
  if (error) throw error;
  return data;
}

export async function sellPosition({ marketSlug, outcome, shares, clientOrderId }) {
  const client = requireClient();
  const { data, error } = await client.rpc("sell_market_position", {
    p_market_slug: marketSlug,
    p_outcome: outcome,
    p_shares: shares,
    p_client_order_id: clientOrderId,
  });
  if (error) throw error;
  return data;
}

export function estimateLmsrShares(market, outcome, amount) {
  const sidePrice = outcome === "YES" ? market.yesPrice : 1 - market.yesPrice;
  const liquidity = market.liquidityParameter;
  if (!amount || amount <= 0 || !sidePrice || !liquidity) return 0;
  return liquidity * Math.log((Math.exp(amount / liquidity) - (1 - sidePrice)) / sidePrice);
}

export function estimateLmsrSaleProceeds(market, outcome, shares) {
  const sidePrice = outcome === "YES" ? market.yesPrice : 1 - market.yesPrice;
  const liquidity = market.liquidityParameter;
  if (!shares || shares <= 0 || !sidePrice || !liquidity) return 0;
  return -liquidity * Math.log((1 - sidePrice) + sidePrice * Math.exp(-shares / liquidity));
}

export async function getTrades(marketSlug, limit = 30) {
  const client = requireClient();
  const { data: marketData, error: marketError } = await client
    .from("markets")
    .select("id")
    .eq("slug", marketSlug)
    .maybeSingle();
  if (marketError) throw marketError;
  if (!marketData) return [];

  const { data, error } = await client
    .from("trades")
    .select("id,user_id,outcome,amount,price,shares,created_at,action")
    .eq("market_id", marketData.id)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data || []).map((trade) => ({
    id: trade.id,
    outcome: trade.outcome,
    amount: Number(trade.amount),
    price: Number(trade.price),
    shares: Number(trade.shares),
    action: trade.action || "buy",
    createdAt: trade.created_at,
  }));
}

export async function getUserTrades(limit = 50) {
  const client = requireClient();
  const { data, error } = await client
    .from("trades")
    .select("id,market_id,outcome,amount,price,shares,created_at,action,markets(slug,question)")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data || []).map((trade) => ({
    id: trade.id,
    marketId: trade.market_id,
    marketSlug: trade.markets?.slug,
    marketQuestion: trade.markets?.question,
    outcome: trade.outcome,
    amount: Number(trade.amount),
    price: Number(trade.price),
    shares: Number(trade.shares),
    action: trade.action || "buy",
    createdAt: trade.created_at,
  }));
}

export function subscribeToMarket(slug, onChange) {
  if (!supabase) return () => {};
  const channel = supabase
    .channel(`market:${slug}`)
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "markets", filter: `slug=eq.${slug}` },
      () => onChange(),
    )
    .subscribe();
  return () => { supabase.removeChannel(channel); };
}
