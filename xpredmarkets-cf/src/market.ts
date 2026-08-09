import { getSupabase, type SupabaseEnv } from "./supabase";

export type MarketStatus = "draft" | "open" | "locked" | "closed" | "resolved" | "voided" | "cancelled";
export type Resolution = "yes" | "no" | "void";
export type TradeSide = "buy_yes" | "buy_no" | "sell_yes" | "sell_no";
export type QuoteSide = "yes" | "no";
export type QuoteAction = "buy" | "sell";

export interface User {
  id: string;
  display_name: string;
  api_key_hash: string;
  api_key_prefix: string;
  balance: number;
  created_at: number;
}

export interface UserPublic {
  id: string;
  display_name: string;
  balance: number;
  api_key_prefix: string;
  created_at: number;
}

export interface Market {
  id: string;
  slug: string;
  question: string;
  description: string | null;
  status: MarketStatus;
  yes_shares: number;
  no_shares: number;
  liquidity_parameter: number;
  resolution: Resolution | null;
  resolve_by: number | null;
  created_by: string | null;
  created_at: number;
  resolved_at: number | null;
  rules: string | null;
  source_tweet_id: string | null;
  source_tweet_url: string | null;
}

export interface MarketView extends Market {
  p_yes: number;
  p_no: number;
  volume: number;
}

export interface Position {
  user_id: string;
  market_id: string;
  shares_yes: number;
  shares_no: number;
  updated_at: number | null;
}

export interface PositionView {
  market_id: string;
  question: string;
  status: MarketStatus;
  shares_yes: number;
  shares_no: number;
  p_yes: number;
}

export interface Trade {
  id: string;
  market_id: string;
  user_id: string;
  side?: TradeSide;
  shares: number;
  cost: number;
  price: number;
  p_yes_after: number;
  created_at: number;
}

export type Ok<T> = { ok: true } & T;
export type Err = { ok: false; error: string };
export type Result<T> = Ok<T> | Err;

export interface QuoteResult {
  side: QuoteSide;
  action: QuoteAction;
  amount: number;
  shares: number;
  avg_price: number;
  p_yes_before: number;
  p_yes_after: number;
}

export interface TradeResult {
  trade: Trade;
  position: Position;
  balance: number;
  market: MarketView;
}

const DECIMALS = 8;
const DEFAULT_LIQUIDITY = 100;
const MIN_LIQUIDITY = 10;
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 100;
const LMSR_EXP_LIMIT = 700;

export function round8(n: number): number {
  if (!Number.isFinite(n)) return n;
  const f = 10 ** DECIMALS;
  return Math.round(n * f) / f;
}

export function generateApiKey(): string {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  const hex = Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
  return `xpm_${hex}`;
}

export async function hashApiKey(rawKey: string): Promise<string> {
  const enc = new TextEncoder();
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(rawKey));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function lmsrPrice(yesShares: number, noShares: number, b: number): number {
  if (!(b > 0) || !Number.isFinite(yesShares) || !Number.isFinite(noShares)) return 0.5;
  const x = (noShares - yesShares) / b;
  const clamped = Math.max(-LMSR_EXP_LIMIT, Math.min(LMSR_EXP_LIMIT, x));
  return 1 / (1 + Math.exp(clamped));
}

export function lmsrBuyShares(yesShares: number, noShares: number, b: number, amount: number, outcome: "YES" | "NO"): number {
  if (!(b > 0) || !Number.isFinite(amount) || !(amount > 0)) return NaN;
  const price = lmsrPrice(yesShares, noShares, b);
  const sidePrice = outcome === "YES" ? price : 1 - price;
  if (!(sidePrice > 0) || !(sidePrice < 1)) return NaN;
  const expAmount = Math.exp(amount / b);
  const numerator = expAmount - (1 - sidePrice);
  if (!(numerator > sidePrice) || !Number.isFinite(numerator)) return NaN;
  const shares = b * Math.log(numerator / sidePrice);
  return Number.isFinite(shares) && shares > 0 ? shares : NaN;
}

function lmsrCost(qYes: number, qNo: number, b: number): number {
  if (!(b > 0)) return 0;
  const max = Math.max(qYes, qNo);
  const sum = Math.exp((qYes - max) / b) + Math.exp((qNo - max) / b);
  return max + b * Math.log(sum);
}

export function lmsrSellCredits(yesShares: number, noShares: number, b: number, shares: number, outcome: "YES" | "NO"): number {
  if (!(b > 0) || !Number.isFinite(shares) || !(shares > 0)) return NaN;
  const afterYes = outcome === "YES" ? yesShares - shares : yesShares;
  const afterNo = outcome === "YES" ? noShares : noShares - shares;
  const before = lmsrCost(yesShares, noShares, b);
  const after = lmsrCost(afterYes, afterNo, b);
  const credits = before - after;
  return Number.isFinite(credits) && credits > 0 ? credits : NaN;
}

function toDbStatus(s: string): string {
  if (s === "locked") return "closed";
  if (s === "voided") return "cancelled";
  return s;
}

function toPublicStatus(s: string): MarketStatus {
  if (s === "closed") return "locked";
  if (s === "cancelled") return "voided";
  return s as MarketStatus;
}

function mapUser(row: Record<string, unknown>): User {
  return {
    id: String(row.id),
    display_name: String(row.display_name || ""),
    api_key_hash: String(row.api_key_hash || ""),
    api_key_prefix: String(row.api_key_prefix || ""),
    balance: Number(row.demo_balance ?? 0),
    created_at: Math.floor(new Date(String(row.created_at || 0)).getTime() / 1000),
  };
}

export function userToPublic(u: User): UserPublic {
  return { id: u.id, display_name: u.display_name, balance: u.balance, api_key_prefix: u.api_key_prefix, created_at: u.created_at };
}

function mapMarket(row: Record<string, unknown>): Market {
  const status = toPublicStatus(String(row.status));
  let resolution: Resolution | null = null;
  if (status === "resolved") {
    const out = String(row.outcome || "").toLowerCase();
    resolution = out === "yes" || out === "no" ? (out as Resolution) : null;
  } else if (status === "voided") {
    resolution = "void";
  }
  return {
    id: String(row.id),
    slug: String(row.slug || row.id),
    question: String(row.question || ""),
    description: row.description == null || String(row.description) === "" ? null : String(row.description),
    status,
    yes_shares: Number(row.yes_shares ?? 0),
    no_shares: Number(row.no_shares ?? 0),
    liquidity_parameter: Number(row.liquidity_parameter ?? DEFAULT_LIQUIDITY),
    resolution,
    resolve_by: row.closes_at ? Math.floor(new Date(String(row.closes_at)).getTime() / 1000) : null,
    created_by: row.creator_x_handle ? String(row.creator_x_handle) : "admin",
    created_at: Math.floor(new Date(String(row.created_at || 0)).getTime() / 1000),
    resolved_at: row.resolved_at ? Math.floor(new Date(String(row.resolved_at)).getTime() / 1000) : null,
    rules: row.resolution_criteria == null || String(row.resolution_criteria) === "" ? null : String(row.resolution_criteria),
    source_tweet_id: row.source_tweet_id ? String(row.source_tweet_id) : null,
    source_tweet_url: row.source_tweet_url ? String(row.source_tweet_url) : null,
  };
}

function toMarketViewRaw(row: Record<string, unknown>): MarketView {
  const m = mapMarket(row);
  const py = round8(Number(row.yes_price ?? 0.5));
  return { ...m, p_yes: py, p_no: round8(1 - py), volume: Number(row.volume ?? 0) };
}

function toTrade(row: Record<string, unknown>, action: "buy" | "sell", pYesAfter: number): Trade {
  const outcome = String(row.outcome || "").toLowerCase();
  return {
    id: String(row.id),
    market_id: String(row.market_id),
    user_id: String(row.user_id),
    side: `${action}_${outcome}` as TradeSide,
    shares: round8(Number(row.shares ?? 0)),
    cost: round8(Number(row.amount ?? 0)),
    price: round8(Number(row.price ?? 0)),
    p_yes_after: round8(pYesAfter),
    created_at: Math.floor(new Date(String(row.created_at || 0)).getTime() / 1000),
  };
}

function toListTrade(row: Record<string, unknown>): Trade {
  return {
    id: String(row.id),
    market_id: String(row.market_id),
    user_id: String(row.user_id),
    shares: round8(Number(row.shares ?? 0)),
    cost: round8(Number(row.amount ?? 0)),
    price: round8(Number(row.price ?? 0)),
    p_yes_after: 0,
    created_at: Math.floor(new Date(String(row.created_at || 0)).getTime() / 1000),
  };
}

async function getMarketRow(env: SupabaseEnv, marketId: string): Promise<MarketView | null> {
  const { data, error } = await getSupabase(env)
    .from("markets")
    .select("*")
    .eq("id", marketId)
    .maybeSingle();
  if (error || !data) return null;
  return toMarketViewRaw(data as Record<string, unknown>);
}

async function buildPosition(env: SupabaseEnv, userId: string, marketId: string): Promise<Position> {
  const { data } = await getSupabase(env).from("positions").select("*").eq("user_id", userId).eq("market_id", marketId);
  let shares_yes = 0;
  let shares_no = 0;
  let updated_at: number | null = null;
  for (const p of data || []) {
    const row = p as Record<string, unknown>;
    const out = String(row.outcome || "").toUpperCase();
    const sh = Number(row.shares ?? 0);
    if (out === "YES") shares_yes = sh;
    if (out === "NO") shares_no = sh;
    if (row.updated_at) {
      const t = Math.floor(new Date(String(row.updated_at)).getTime() / 1000);
      if (updated_at === null || t > updated_at) updated_at = t;
    }
  }
  return { user_id: userId, market_id: marketId, shares_yes, shares_no, updated_at };
}

export async function createUser(env: SupabaseEnv, displayName: string): Promise<Result<{ user: UserPublic & { api_key: string } }>> {
  const name = (displayName ?? "").trim();
  if (!name) return { ok: false, error: "display_name is required" };
  if (name.length > 64) return { ok: false, error: "display_name too long (max 64)" };
  const api_key = generateApiKey();
  const hash = await hashApiKey(api_key);
  const prefix = api_key.slice(0, 8);
  const supabase = getSupabase(env);
  const email = `${crypto.randomUUID()}@example.com`;
  const password = crypto.randomUUID().replace(/-/g, "");
  const { data: authData, error: authError } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: name, name: name, user_name: name, preferred_username: name },
  });
  if (authError || !authData?.user) return { ok: false, error: authError?.message || "failed to create auth user" };
  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .update({ display_name: name, api_key_hash: hash, api_key_prefix: prefix, demo_balance: 1000 })
    .eq("id", authData.user.id)
    .select()
    .single();
  if (profileError || !profile) {
    return { ok: false, error: profileError?.message || "failed to update profile" };
  }
  const user = mapUser(profile as Record<string, unknown>);
  return { ok: true, user: { ...userToPublic(user), api_key } };
}

export async function getUserByApiKey(env: SupabaseEnv, rawKey: string): Promise<User | null> {
  if (!rawKey || !rawKey.startsWith("xpm_")) return null;
  const hash = await hashApiKey(rawKey);
  const { data, error } = await getSupabase(env).rpc("get_profile_by_api_key", { p_api_key_hash: hash });
  if (error || !data) return null;
  return mapUser(data as Record<string, unknown>);
}

export async function creditUser(env: SupabaseEnv, userId: string, amount: number): Promise<Result<{ balance: number }>> {
  if (!Number.isFinite(amount) || amount === 0) return { ok: false, error: "amount must be non-zero finite" };
  const supabase = getSupabase(env);
  const { data: row, error: e1 } = await supabase.from("profiles").select("demo_balance").eq("id", userId).single();
  if (e1 || !row) return { ok: false, error: e1?.message || "user not found" };
  const newBal = Number(row.demo_balance) + amount;
  const { data: updated, error: e2 } = await supabase.from("profiles").update({ demo_balance: newBal }).eq("id", userId).select().single();
  if (e2 || !updated) return { ok: false, error: e2?.message || "update failed" };
  return { ok: true, balance: Number(updated.demo_balance ?? newBal) };
}

export async function createMarket(
  env: SupabaseEnv,
  opts: {
    question: string;
    description?: string | null;
    rules?: string | null;
    liquidity?: number;
    resolve_by?: number | null;
    created_by?: string | null;
    category?: string | null;
    source_tweet_id?: string | null;
    source_tweet_url?: string | null;
  },
): Promise<Result<{ market: MarketView }>> {
  const question = (opts.question ?? "").trim();
  if (!question) return { ok: false, error: "question is required" };
  let liquidity = opts.liquidity ?? DEFAULT_LIQUIDITY;
  if (!Number.isFinite(liquidity) || liquidity < MIN_LIQUIDITY) return { ok: false, error: `liquidity must be at least ${MIN_LIQUIDITY}` };
  liquidity = round8(liquidity);
  const description = opts.description == null || opts.description === "" ? "" : String(opts.description);
  const rules = opts.rules == null || opts.rules === "" ? "Resolves based on publicly available information." : String(opts.rules);
  const closes_at = opts.resolve_by == null || !Number.isFinite(opts.resolve_by) ? undefined : new Date(Math.floor(opts.resolve_by * 1000)).toISOString();
  const { data, error } = await getSupabase(env).rpc("create_market_api", {
    p_question: question,
    p_description: description,
    p_resolution_criteria: rules,
    p_category: opts.category ?? "Other",
    p_closes_at: closes_at,
    p_source_tweet_id: opts.source_tweet_id ?? null,
    p_source_tweet_url: opts.source_tweet_url ?? null,
    p_creator_x_handle: opts.created_by ?? "admin",
    p_yes_pool: liquidity,
    p_no_pool: liquidity,
  });
  if (error || !data) return { ok: false, error: error?.message || "failed to create market" };
  return { ok: true, market: toMarketViewRaw(data as Record<string, unknown>) };
}

export async function getMarket(env: SupabaseEnv, marketId: string): Promise<Result<{ market: MarketView }>> {
  const { data, error } = await getSupabase(env)
    .from("markets")
    .select("*")
    .eq("id", marketId)
    .maybeSingle();
  if (error || !data) return { ok: false, error: error?.message || "market not found" };
  return { ok: true, market: toMarketViewRaw(data as Record<string, unknown>) };
}

export async function listMarkets(env: SupabaseEnv, opts?: { status?: string; limit?: number }): Promise<Result<{ markets: MarketView[] }>> {
  let limit = opts?.limit ?? DEFAULT_LIST_LIMIT;
  if (!Number.isFinite(limit) || limit < 1) limit = DEFAULT_LIST_LIMIT;
  if (limit > MAX_LIST_LIMIT) limit = MAX_LIST_LIMIT;
  const dbStatus = opts?.status ? toDbStatus(opts.status) : null;
  let q = getSupabase(env).from("markets").select("*").order("created_at", { ascending: false }).limit(limit);
  if (dbStatus) q = q.eq("status", dbStatus);
  const { data, error } = await q;
  if (error) return { ok: false, error: error.message };
  const markets = (data || []).map((r: unknown) => toMarketViewRaw(r as Record<string, unknown>));
  return { ok: true, markets };
}

export async function lockMarket(env: SupabaseEnv, marketId: string): Promise<Result<{ market: MarketView }>> {
  const { data, error } = await getSupabase(env).from("markets").update({ status: "closed" }).eq("id", marketId).select().single();
  if (error || !data) return { ok: false, error: error?.message || "market not found" };
  return { ok: true, market: toMarketViewRaw(data as Record<string, unknown>) };
}

export async function resolveMarket(env: SupabaseEnv, marketId: string, outcome: Resolution): Promise<Result<{ market: MarketView; payouts: number }>> {
  if (outcome !== "yes" && outcome !== "no" && outcome !== "void") return { ok: false, error: "outcome must be yes, no, or void" };
  const supabase = getSupabase(env);
  if (outcome === "void") {
    const { data, error } = await supabase.rpc("cancel_market_api", { p_market_id: marketId });
    if (error || !data) return { ok: false, error: error?.message || "cancel failed" };
    const row = data as Record<string, unknown>;
    const refunds = Array.isArray(row.refunds) ? row.refunds.length : 0;
    const market = await getMarketRow(env, marketId);
    if (!market) return { ok: false, error: "market disappeared" };
    return { ok: true, market, payouts: refunds };
  }
  const { data, error } = await supabase.rpc("resolve_market_api", { p_market_id: marketId, p_outcome: outcome.toUpperCase() });
  if (error || !data) return { ok: false, error: error?.message || "resolve failed" };
  const row = data as Record<string, unknown>;
  const market = await getMarketRow(env, marketId);
  if (!market) return { ok: false, error: "market disappeared" };
  return { ok: true, market, payouts: Number(row.winners ?? 0) };
}

export async function quote(
  env: SupabaseEnv,
  marketId: string,
  opts: { side: QuoteSide; action: QuoteAction; amount?: number; shares?: number },
): Promise<Result<QuoteResult>> {
  const market = await getMarketRow(env, marketId);
  if (!market) return { ok: false, error: "market not found" };
  if (market.status !== "open") return { ok: false, error: "market is not open" };
  const { side, action } = opts;
  if (side !== "yes" && side !== "no") return { ok: false, error: "side must be yes or no" };
  if (action !== "buy" && action !== "sell") return { ok: false, error: "action must be buy or sell" };
  const b = market.liquidity_parameter;
  const yesShares = market.yes_shares;
  const noShares = market.no_shares;
  const p_yes_before = market.p_yes;
  const outcome: "YES" | "NO" = side.toUpperCase() as "YES" | "NO";
  if (action === "buy") {
    const amount = Number(opts.amount);
    if (!(amount > 0)) return { ok: false, error: "amount is required for buy" };
    const rawShares = lmsrBuyShares(yesShares, noShares, b, amount, outcome);
    if (!Number.isFinite(rawShares) || !(rawShares > 0)) return { ok: false, error: "quote failed" };
    const shares = round8(rawShares);
    if (!(shares > 0)) return { ok: false, error: "shares too small" };
    const afterYes = side === "yes" ? yesShares + rawShares : yesShares;
    const afterNo = side === "yes" ? noShares : noShares + rawShares;
    const p_yes_after = round8(lmsrPrice(afterYes, afterNo, b));
    const avg_price = round8(amount / rawShares);
    return { ok: true, side, action, amount: round8(amount), shares, avg_price, p_yes_before, p_yes_after };
  }
  const shares = Number(opts.shares);
  if (!(shares > 0)) return { ok: false, error: "shares is required for sell" };
  const rawCredits = lmsrSellCredits(yesShares, noShares, b, shares, outcome);
  if (!Number.isFinite(rawCredits) || !(rawCredits > 0)) return { ok: false, error: "quote failed" };
  const credits = round8(rawCredits);
  if (!(credits > 0)) return { ok: false, error: "credits too small" };
  const afterYes = side === "yes" ? yesShares - shares : yesShares;
  const afterNo = side === "yes" ? noShares : noShares - shares;
  const p_yes_after = round8(lmsrPrice(afterYes, afterNo, b));
  const avg_price = round8(rawCredits / shares);
  return { ok: true, side, action, amount: credits, shares: round8(shares), avg_price, p_yes_before, p_yes_after };
}

export async function buy(env: SupabaseEnv, userId: string, marketId: string, side: QuoteSide, amount: number): Promise<Result<TradeResult>> {
  if (side !== "yes" && side !== "no") return { ok: false, error: "side must be yes or no" };
  amount = Number(amount);
  if (!(amount > 0) || !Number.isFinite(amount)) return { ok: false, error: "amount must be positive" };
  amount = round8(amount);
  const supabase = getSupabase(env);
  const market = await getMarketRow(env, marketId);
  if (!market) return { ok: false, error: "market not found" };
  const { data, error } = await supabase.rpc("buy_market_position_api", {
    p_user_id: userId,
    p_market_slug: market.slug,
    p_outcome: side.toUpperCase(),
    p_amount: amount,
    p_client_order_id: crypto.randomUUID(),
  });
  if (error || !data) return { ok: false, error: error?.message || "buy failed" };
  const row = data as Record<string, unknown>;
  const tradeId = String(row.trade_id ?? "");
  if (!tradeId) return { ok: false, error: "trade missing" };
  const { data: tradeRow } = await supabase.from("trades").select("*").eq("id", tradeId).single();
  const marketView = await getMarketRow(env, marketId);
  if (!marketView || !tradeRow) return { ok: false, error: "trade or market missing" };
  const trade = toTrade(tradeRow as Record<string, unknown>, "buy", marketView.p_yes);
  const position = await buildPosition(env, userId, marketView.id);
  return { ok: true, trade, position, balance: Number(row.balance ?? 0), market: marketView };
}

export async function sell(env: SupabaseEnv, userId: string, marketId: string, side: QuoteSide, shares: number): Promise<Result<TradeResult>> {
  if (side !== "yes" && side !== "no") return { ok: false, error: "side must be yes or no" };
  shares = Number(shares);
  if (!(shares > 0) || !Number.isFinite(shares)) return { ok: false, error: "shares must be positive" };
  shares = round8(shares);
  const supabase = getSupabase(env);
  const market = await getMarketRow(env, marketId);
  if (!market) return { ok: false, error: "market not found" };
  const { data, error } = await supabase.rpc("sell_market_position_api", {
    p_user_id: userId,
    p_market_slug: market.slug,
    p_outcome: side.toUpperCase(),
    p_shares: shares,
    p_client_order_id: crypto.randomUUID(),
  });
  if (error || !data) return { ok: false, error: error?.message || "sell failed" };
  const row = data as Record<string, unknown>;
  const tradeId = String(row.trade_id ?? "");
  if (!tradeId) return { ok: false, error: "trade missing" };
  const { data: tradeRow } = await supabase.from("trades").select("*").eq("id", tradeId).single();
  const marketView = await getMarketRow(env, marketId);
  if (!marketView || !tradeRow) return { ok: false, error: "trade or market missing" };
  const trade = toTrade(tradeRow as Record<string, unknown>, "sell", marketView.p_yes);
  const position = await buildPosition(env, userId, marketView.id);
  return { ok: true, trade, position, balance: Number(row.balance ?? 0), market: marketView };
}

export async function getPositions(env: SupabaseEnv, userId: string): Promise<Result<{ positions: PositionView[] }>> {
  const { data, error } = await getSupabase(env).from("positions").select("*, markets(question, status, yes_price)").eq("user_id", userId);
  if (error) return { ok: false, error: error.message };
  const byMarket = new Map<string, { question: string; status: MarketStatus; p_yes: number; shares_yes: number; shares_no: number }>();
  for (const p of data || []) {
    const row = p as Record<string, unknown>;
    const m = (row.markets as Record<string, unknown>) || {};
    const mId = String(row.market_id);
    const cur = byMarket.get(mId) ?? { question: String(m.question || ""), status: toPublicStatus(String(m.status || "open")), p_yes: Number(m.yes_price ?? 0.5), shares_yes: 0, shares_no: 0 };
    const out = String(row.outcome || "").toUpperCase();
    if (out === "YES") cur.shares_yes = Number(row.shares ?? 0);
    if (out === "NO") cur.shares_no = Number(row.shares ?? 0);
    byMarket.set(mId, cur);
  }
  const positions: PositionView[] = [];
  for (const [marketId, cur] of byMarket) {
    positions.push({ market_id: marketId, question: cur.question, status: cur.status, shares_yes: round8(cur.shares_yes), shares_no: round8(cur.shares_no), p_yes: round8(cur.p_yes) });
  }
  return { ok: true, positions };
}

export async function listTrades(env: SupabaseEnv, marketId: string, limit = 20): Promise<Result<{ trades: Trade[] }>> {
  let lim = limit;
  if (!Number.isFinite(lim) || lim < 1) lim = 20;
  if (lim > 100) lim = 100;
  const { data, error } = await getSupabase(env).from("trades").select("*").eq("market_id", marketId).order("created_at", { ascending: false }).limit(lim);
  if (error) return { ok: false, error: error.message };
  const trades = (data || []).map((r: unknown) => toListTrade(r as Record<string, unknown>));
  return { ok: true, trades };
}
