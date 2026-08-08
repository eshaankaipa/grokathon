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
  question: string;
  description: string | null;
  status: MarketStatus;
  yes_pool: number;
  no_pool: number;
  resolution: Resolution | null;
  resolve_by: number | null;
  created_by: string | null;
  created_at: number;
  resolved_at: number | null;
  rules: string | null;
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

export interface AmmBuyResult {
  shares_out: number;
  new_yes: number;
  new_no: number;
  avg_price: number;
  p_yes_before: number;
  p_yes_after: number;
}

export interface AmmSellResult {
  credits_out: number;
  new_yes: number;
  new_no: number;
  avg_price: number;
  p_yes_before: number;
  p_yes_after: number;
}

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
  market: { p_yes: number; p_no: number; yes_pool: number; no_pool: number };
}

const POOL_FLOOR = 1e-8;
const DECIMALS = 8;
const DEFAULT_LIQUIDITY = 100;
const MIN_LIQUIDITY = 10;
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 100;

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

export function pYes(yesPool: number, noPool: number): number {
  const sum = yesPool + noPool;
  if (sum <= 0) return 0.5;
  return noPool / sum;
}

export function pNo(yesPool: number, noPool: number): number {
  return 1 - pYes(yesPool, noPool);
}

function enforcePoolFloor(n: number): number {
  const r = round8(n);
  return r < POOL_FLOOR ? POOL_FLOOR : r;
}

export function ammBuyYes(yesPool: number, noPool: number, amount: number): Result<AmmBuyResult> {
  if (!(amount > 0) || !Number.isFinite(amount)) return { ok: false, error: "amount must be positive" };
  if (yesPool <= 0 || noPool <= 0) return { ok: false, error: "invalid pools" };
  const p_yes_before = pYes(yesPool, noPool);
  const k = yesPool * noPool;
  const new_no = noPool + amount;
  const new_yes = k / new_no;
  const shares_out = yesPool - new_yes;
  if (!(shares_out > 0) || !Number.isFinite(shares_out)) return { ok: false, error: "shares too small" };
  if (!(new_yes > 0) || !(new_no > 0)) return { ok: false, error: "pools would go non-positive" };
  const ny = enforcePoolFloor(new_yes);
  const nn = enforcePoolFloor(new_no);
  const shares = round8(shares_out);
  if (!(shares > 0)) return { ok: false, error: "shares too small" };
  return { ok: true, shares_out: shares, new_yes: ny, new_no: nn, avg_price: round8(amount / shares), p_yes_before: round8(p_yes_before), p_yes_after: round8(pYes(ny, nn)) };
}

export function ammBuyNo(yesPool: number, noPool: number, amount: number): Result<AmmBuyResult> {
  const r = ammBuyYes(noPool, yesPool, amount);
  if (!r.ok) return r;
  return { ok: true, shares_out: r.shares_out, new_yes: r.new_no, new_no: r.new_yes, avg_price: r.avg_price, p_yes_before: round8(pYes(yesPool, noPool)), p_yes_after: round8(pYes(r.new_no, r.new_yes)) };
}

export function ammSellYes(yesPool: number, noPool: number, shares: number): Result<AmmSellResult> {
  if (!(shares > 0) || !Number.isFinite(shares)) return { ok: false, error: "shares must be positive" };
  if (yesPool <= 0 || noPool <= 0) return { ok: false, error: "invalid pools" };
  const p_yes_before = pYes(yesPool, noPool);
  const k = yesPool * noPool;
  const new_yes = yesPool + shares;
  const new_no = k / new_yes;
  const credits_out = noPool - new_no;
  if (!(credits_out > 0) || !Number.isFinite(credits_out)) return { ok: false, error: "credits too small" };
  if (!(new_yes > 0) || !(new_no > 0) || new_no < POOL_FLOOR) return { ok: false, error: "pools would go non-positive" };
  const ny = enforcePoolFloor(new_yes);
  const nn = enforcePoolFloor(new_no);
  const credits = round8(credits_out);
  if (!(credits > 0)) return { ok: false, error: "credits too small" };
  return { ok: true, credits_out: credits, new_yes: ny, new_no: nn, avg_price: round8(credits / shares), p_yes_before: round8(p_yes_before), p_yes_after: round8(pYes(ny, nn)) };
}

export function ammSellNo(yesPool: number, noPool: number, shares: number): Result<AmmSellResult> {
  const r = ammSellYes(noPool, yesPool, shares);
  if (!r.ok) return r;
  return { ok: true, credits_out: r.credits_out, new_yes: r.new_no, new_no: r.new_yes, avg_price: r.avg_price, p_yes_before: round8(pYes(yesPool, noPool)), p_yes_after: round8(pYes(r.new_no, r.new_yes)) };
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
    question: String(row.question || ""),
    description: row.description == null || String(row.description) === "" ? null : String(row.description),
    status,
    yes_pool: Number(row.yes_pool ?? 0),
    no_pool: Number(row.no_pool ?? 0),
    resolution,
    resolve_by: row.closes_at ? Math.floor(new Date(String(row.closes_at)).getTime() / 1000) : null,
    created_by: row.creator_x_handle ? String(row.creator_x_handle) : "admin",
    created_at: Math.floor(new Date(String(row.created_at || 0)).getTime() / 1000),
    resolved_at: row.resolved_at ? Math.floor(new Date(String(row.resolved_at)).getTime() / 1000) : null,
    rules: row.resolution_criteria == null || String(row.resolution_criteria) === "" ? null : String(row.resolution_criteria),
  };
}

function toMarketViewRaw(row: Record<string, unknown>): MarketView {
  const m = mapMarket(row);
  const py = round8(pYes(m.yes_pool, m.no_pool));
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

async function getMarketRow(env: SupabaseEnv, marketId: string): Promise<Market | null> {
  const { data, error } = await getSupabase(env)
    .from("markets")
    .select("*")
    .eq("id", marketId)
    .maybeSingle();
  if (error || !data) return null;
  return mapMarket(data as Record<string, unknown>);
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
  const { data, error } = await getSupabase(env).rpc("create_profile", { p_display_name: name, p_api_key_hash: hash, p_api_key_prefix: prefix });
  if (error || !data) return { ok: false, error: error?.message || "failed to create user" };
  const user = mapUser(data as Record<string, unknown>);
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
  const { data, error } = await getSupabase(env).rpc("create_market", {
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
    const { data, error } = await supabase.rpc("cancel_market", { p_market_id: marketId });
    if (error || !data) return { ok: false, error: error?.message || "cancel failed" };
    const row = data as Record<string, unknown>;
    return { ok: true, market: toMarketViewRaw(row.market as Record<string, unknown>), payouts: Number(row.refunds ?? 0) };
  }
  const { data, error } = await supabase.rpc("resolve_market", { p_market_id: marketId, p_outcome: outcome.toUpperCase() });
  if (error || !data) return { ok: false, error: error?.message || "resolve failed" };
  const row = data as Record<string, unknown>;
  return { ok: true, market: toMarketViewRaw(row.market as Record<string, unknown>), payouts: Number(row.payouts ?? 0) };
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
  if (action === "buy") {
    const amount = Number(opts.amount);
    if (!(amount > 0)) return { ok: false, error: "amount is required for buy" };
    const r = side === "yes" ? ammBuyYes(market.yes_pool, market.no_pool, amount) : ammBuyNo(market.yes_pool, market.no_pool, amount);
    if (!r.ok) return r;
    return { ok: true, side, action, amount: round8(amount), shares: r.shares_out, avg_price: r.avg_price, p_yes_before: r.p_yes_before, p_yes_after: r.p_yes_after };
  }
  const shares = Number(opts.shares);
  if (!(shares > 0)) return { ok: false, error: "shares is required for sell" };
  const r = side === "yes" ? ammSellYes(market.yes_pool, market.no_pool, shares) : ammSellNo(market.yes_pool, market.no_pool, shares);
  if (!r.ok) return r;
  return { ok: true, side, action, amount: r.credits_out, shares: round8(shares), avg_price: r.avg_price, p_yes_before: r.p_yes_before, p_yes_after: r.p_yes_after };
}

export async function buy(env: SupabaseEnv, userId: string, marketId: string, side: QuoteSide, amount: number): Promise<Result<TradeResult>> {
  if (side !== "yes" && side !== "no") return { ok: false, error: "side must be yes or no" };
  amount = Number(amount);
  if (!(amount > 0) || !Number.isFinite(amount)) return { ok: false, error: "amount must be positive" };
  amount = round8(amount);
  const supabase = getSupabase(env);
  const fn = side === "yes" ? "buy_yes" : "buy_no";
  const { data, error } = await supabase.rpc(fn, { p_user_id: userId, p_market_id: marketId, p_amount: amount });
  if (error || !data) return { ok: false, error: error?.message || "buy failed" };
  const row = data as Record<string, unknown>;
  const market = toMarketViewRaw(row.market as Record<string, unknown>);
  const trade = toTrade(row.trade as Record<string, unknown>, "buy", market.p_yes);
  const position = await buildPosition(env, userId, marketId);
  const { data: profile } = await supabase.from("profiles").select("demo_balance").eq("id", userId).single();
  const balance = Number(profile?.demo_balance ?? 0);
  return { ok: true, trade, position, balance, market: { p_yes: market.p_yes, p_no: market.p_no, yes_pool: market.yes_pool, no_pool: market.no_pool } };
}

export async function sell(env: SupabaseEnv, userId: string, marketId: string, side: QuoteSide, shares: number): Promise<Result<TradeResult>> {
  if (side !== "yes" && side !== "no") return { ok: false, error: "side must be yes or no" };
  shares = Number(shares);
  if (!(shares > 0) || !Number.isFinite(shares)) return { ok: false, error: "shares must be positive" };
  shares = round8(shares);
  const supabase = getSupabase(env);
  const fn = side === "yes" ? "sell_yes" : "sell_no";
  const { data, error } = await supabase.rpc(fn, { p_user_id: userId, p_market_id: marketId, p_shares: shares });
  if (error || !data) return { ok: false, error: error?.message || "sell failed" };
  const row = data as Record<string, unknown>;
  const market = toMarketViewRaw(row.market as Record<string, unknown>);
  const trade = toTrade(row.trade as Record<string, unknown>, "sell", market.p_yes);
  const position = await buildPosition(env, userId, marketId);
  const { data: profile } = await supabase.from("profiles").select("demo_balance").eq("id", userId).single();
  const balance = Number(profile?.demo_balance ?? 0);
  return { ok: true, trade, position, balance, market: { p_yes: market.p_yes, p_no: market.p_no, yes_pool: market.yes_pool, no_pool: market.no_pool } };
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
