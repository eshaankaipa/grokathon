/**
 * Prediction market core: constant-product AMM math + D1 helpers.
 * Currency: play-money credits. Binary YES/NO markets.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MarketStatus = "open" | "locked" | "resolved" | "voided";
export type Resolution = "yes" | "no" | "void";
export type TradeSide = "buy_yes" | "buy_no" | "sell_yes" | "sell_no";
export type QuoteSide = "yes" | "no";
export type QuoteAction = "buy" | "sell";
export type LedgerReason =
  | "signup_bonus"
  | "buy"
  | "sell"
  | "payout"
  | "credit"
  | "void_refund";

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
  side: TradeSide;
  shares: number;
  cost: number;
  price: number;
  p_yes_after: number;
  created_at: number;
}

export interface LedgerEntry {
  id: number;
  user_id: string;
  amount: number;
  balance_after: number;
  reason: LedgerReason;
  ref_type: string | null;
  ref_id: string | null;
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
  market: {
    p_yes: number;
    p_no: number;
    yes_pool: number;
    no_pool: number;
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const POOL_FLOOR = 1e-8;
const DECIMALS = 8;
const DEFAULT_LIQUIDITY = 100;
const MIN_LIQUIDITY = 10;
const STARTING_BALANCE = 1000;
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 100;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function round8(n: number): number {
  if (!Number.isFinite(n)) return n;
  const f = 10 ** DECIMALS;
  return Math.round(n * f) / f;
}

export function nowUnix(): number {
  return Math.floor(Date.now() / 1000);
}

/** Generate id with prefix, e.g. usr_ / mkt_ / trd_ + 16 random bytes hex. */
export function generateId(prefix: "usr_" | "mkt_" | "trd_"): string {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  const hex = Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${prefix}${hex}`;
}

/** Raw api key: xpm_ + 32 random bytes hex (64 hex chars). */
export function generateApiKey(): string {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  const hex = Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
  return `xpm_${hex}`;
}

/** SHA-256 hex of raw api key (Web Crypto). */
export async function hashApiKey(rawKey: string): Promise<string> {
  const enc = new TextEncoder();
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(rawKey));
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
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
  if (r < POOL_FLOOR) return POOL_FLOOR;
  return r;
}

/** Buy YES with `amount` credits. */
export function ammBuyYes(
  yesPool: number,
  noPool: number,
  amount: number,
): Result<AmmBuyResult> {
  if (!(amount > 0) || !Number.isFinite(amount)) {
    return { ok: false, error: "amount must be positive" };
  }
  if (yesPool <= 0 || noPool <= 0) {
    return { ok: false, error: "invalid pools" };
  }
  const p_yes_before = pYes(yesPool, noPool);
  const k = yesPool * noPool;
  const new_no = noPool + amount;
  const new_yes = k / new_no;
  const shares_out = yesPool - new_yes;
  if (!(shares_out > 0) || !Number.isFinite(shares_out)) {
    return { ok: false, error: "shares_out would be non-positive" };
  }
  if (!(new_yes > 0) || !(new_no > 0)) {
    return { ok: false, error: "pools would go non-positive" };
  }
  const ny = enforcePoolFloor(new_yes);
  const nn = enforcePoolFloor(new_no);
  const shares = round8(shares_out);
  if (!(shares > 0)) {
    return { ok: false, error: "shares_out would be non-positive" };
  }
  return {
    ok: true,
    shares_out: shares,
    new_yes: ny,
    new_no: nn,
    avg_price: round8(amount / shares),
    p_yes_before: round8(p_yes_before),
    p_yes_after: round8(pYes(ny, nn)),
  };
}

/** Buy NO with `amount` credits (symmetric). */
export function ammBuyNo(
  yesPool: number,
  noPool: number,
  amount: number,
): Result<AmmBuyResult> {
  // Swap roles: buying NO is like buying YES on inverted pools
  const r = ammBuyYes(noPool, yesPool, amount);
  if (!r.ok) return r;
  return {
    ok: true,
    shares_out: r.shares_out,
    new_yes: r.new_no, // swapped back
    new_no: r.new_yes,
    avg_price: r.avg_price,
    p_yes_before: round8(pYes(yesPool, noPool)),
    p_yes_after: round8(pYes(r.new_no, r.new_yes)),
  };
}

/** Sell YES `shares` back for credits. */
export function ammSellYes(
  yesPool: number,
  noPool: number,
  shares: number,
): Result<AmmSellResult> {
  if (!(shares > 0) || !Number.isFinite(shares)) {
    return { ok: false, error: "shares must be positive" };
  }
  if (yesPool <= 0 || noPool <= 0) {
    return { ok: false, error: "invalid pools" };
  }
  const p_yes_before = pYes(yesPool, noPool);
  const k = yesPool * noPool;
  const new_yes = yesPool + shares;
  const new_no = k / new_yes;
  const credits_out = noPool - new_no;
  if (!(credits_out > 0) || !Number.isFinite(credits_out)) {
    return { ok: false, error: "credits_out would be non-positive" };
  }
  if (!(new_yes > 0) || !(new_no > 0) || new_no < POOL_FLOOR) {
    return { ok: false, error: "pools would go non-positive" };
  }
  const ny = enforcePoolFloor(new_yes);
  const nn = enforcePoolFloor(new_no);
  const credits = round8(credits_out);
  if (!(credits > 0)) {
    return { ok: false, error: "credits_out would be non-positive" };
  }
  return {
    ok: true,
    credits_out: credits,
    new_yes: ny,
    new_no: nn,
    avg_price: round8(credits / shares),
    p_yes_before: round8(p_yes_before),
    p_yes_after: round8(pYes(ny, nn)),
  };
}

/** Sell NO `shares` back for credits (symmetric). */
export function ammSellNo(
  yesPool: number,
  noPool: number,
  shares: number,
): Result<AmmSellResult> {
  const r = ammSellYes(noPool, yesPool, shares);
  if (!r.ok) return r;
  return {
    ok: true,
    credits_out: r.credits_out,
    new_yes: r.new_no,
    new_no: r.new_yes,
    avg_price: r.avg_price,
    p_yes_before: round8(pYes(yesPool, noPool)),
    p_yes_after: round8(pYes(r.new_no, r.new_yes)),
  };
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

function mapUser(row: Record<string, unknown>): User {
  return {
    id: String(row.id),
    display_name: String(row.display_name),
    api_key_hash: String(row.api_key_hash),
    api_key_prefix: String(row.api_key_prefix),
    balance: Number(row.balance),
    created_at: Number(row.created_at),
  };
}

/** Strip secrets for /me and list responses. */
export function userToPublic(u: User): UserPublic {
  return {
    id: u.id,
    display_name: u.display_name,
    balance: u.balance,
    api_key_prefix: u.api_key_prefix,
    created_at: u.created_at,
  };
}

function mapMarket(row: Record<string, unknown>): Market {
  return {
    id: String(row.id),
    question: String(row.question),
    description: row.description == null ? null : String(row.description),
    status: String(row.status) as MarketStatus,
    yes_pool: Number(row.yes_pool),
    no_pool: Number(row.no_pool),
    resolution: row.resolution == null ? null : (String(row.resolution) as Resolution),
    resolve_by: row.resolve_by == null ? null : Number(row.resolve_by),
    created_by: row.created_by == null ? null : String(row.created_by),
    created_at: Number(row.created_at),
    resolved_at: row.resolved_at == null ? null : Number(row.resolved_at),
    rules: row.rules == null ? null : String(row.rules),
  };
}

function mapTrade(row: Record<string, unknown>): Trade {
  return {
    id: String(row.id),
    market_id: String(row.market_id),
    user_id: String(row.user_id),
    side: String(row.side) as TradeSide,
    shares: Number(row.shares),
    cost: Number(row.cost),
    price: Number(row.price),
    p_yes_after: Number(row.p_yes_after),
    created_at: Number(row.created_at),
  };
}

function mapPosition(row: Record<string, unknown>): Position {
  return {
    user_id: String(row.user_id),
    market_id: String(row.market_id),
    shares_yes: Number(row.shares_yes),
    shares_no: Number(row.shares_no),
    updated_at: row.updated_at == null ? null : Number(row.updated_at),
  };
}

function marketPoolsView(m: Market): {
  p_yes: number;
  p_no: number;
  yes_pool: number;
  no_pool: number;
} {
  const py = round8(pYes(m.yes_pool, m.no_pool));
  return {
    p_yes: py,
    p_no: round8(1 - py),
    yes_pool: m.yes_pool,
    no_pool: m.no_pool,
  };
}

// ---------------------------------------------------------------------------
// Volume
// ---------------------------------------------------------------------------

/** Buy volume = SUM(cost) for buy_* trades on market. */
export async function marketVolume(
  db: D1Database,
  marketId: string,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(cost), 0) AS v FROM trades
       WHERE market_id = ? AND side IN ('buy_yes', 'buy_no')`,
    )
    .bind(marketId)
    .first<{ v: number }>();
  return round8(Number(row?.v ?? 0));
}

async function volumesForMarkets(
  db: D1Database,
  marketIds: string[],
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (marketIds.length === 0) return map;
  // D1 has no great IN binding for dynamic lists; batch small queries
  // or use a single query with OR. For list size <= 100, one query with IN placeholders.
  const placeholders = marketIds.map(() => "?").join(",");
  const rows = await db
    .prepare(
      `SELECT market_id, COALESCE(SUM(cost), 0) AS v FROM trades
       WHERE market_id IN (${placeholders}) AND side IN ('buy_yes', 'buy_no')
       GROUP BY market_id`,
    )
    .bind(...marketIds)
    .all<{ market_id: string; v: number }>();
  for (const r of rows.results ?? []) {
    map.set(String(r.market_id), round8(Number(r.v)));
  }
  for (const id of marketIds) {
    if (!map.has(id)) map.set(id, 0);
  }
  return map;
}

function toMarketView(m: Market, volume: number): MarketView {
  const py = round8(pYes(m.yes_pool, m.no_pool));
  return {
    ...m,
    p_yes: py,
    p_no: round8(1 - py),
    volume,
  };
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export async function createUser(
  db: D1Database,
  displayName: string,
): Promise<Result<{ user: UserPublic & { api_key: string } }>> {
  const name = (displayName ?? "").trim();
  if (!name) {
    return { ok: false, error: "display_name is required" };
  }
  if (name.length > 64) {
    return { ok: false, error: "display_name too long (max 64)" };
  }

  const id = generateId("usr_");
  const api_key = generateApiKey();
  const api_key_hash = await hashApiKey(api_key);
  const api_key_prefix = api_key.slice(0, 8);
  const created_at = nowUnix();
  const balance = STARTING_BALANCE;

  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO users (id, display_name, api_key_hash, api_key_prefix, balance, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(id, name, api_key_hash, api_key_prefix, balance, created_at),
      db
        .prepare(
          `INSERT INTO ledger (user_id, amount, balance_after, reason, ref_type, ref_id, created_at)
           VALUES (?, ?, ?, 'signup_bonus', 'admin', NULL, ?)`,
        )
        .bind(id, balance, balance, created_at),
    ]);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `failed to create user: ${msg}` };
  }

  return {
    ok: true,
    user: {
      id,
      display_name: name,
      balance,
      api_key_prefix,
      created_at,
      api_key,
    },
  };
}

export async function getUserByApiKey(
  db: D1Database,
  rawKey: string,
): Promise<User | null> {
  if (!rawKey || !rawKey.startsWith("xpm_")) return null;
  const hash = await hashApiKey(rawKey);
  const row = await db
    .prepare(`SELECT * FROM users WHERE api_key_hash = ?`)
    .bind(hash)
    .first();
  if (!row) return null;
  return mapUser(row as Record<string, unknown>);
}

export async function getUserById(
  db: D1Database,
  userId: string,
): Promise<User | null> {
  const row = await db
    .prepare(`SELECT * FROM users WHERE id = ?`)
    .bind(userId)
    .first();
  if (!row) return null;
  return mapUser(row as Record<string, unknown>);
}

export async function creditUser(
  db: D1Database,
  userId: string,
  amount: number,
): Promise<Result<{ balance: number }>> {
  if (!Number.isFinite(amount) || amount === 0) {
    return { ok: false, error: "amount must be a non-zero number" };
  }
  const user = await getUserById(db, userId);
  if (!user) return { ok: false, error: "user not found" };

  const newBalance = round8(user.balance + amount);
  if (newBalance < 0) {
    return { ok: false, error: "insufficient balance for debit" };
  }
  const ts = nowUnix();

  await db.batch([
    db
      .prepare(`UPDATE users SET balance = ? WHERE id = ?`)
      .bind(newBalance, userId),
    db
      .prepare(
        `INSERT INTO ledger (user_id, amount, balance_after, reason, ref_type, ref_id, created_at)
         VALUES (?, ?, ?, 'credit', 'admin', NULL, ?)`,
      )
      .bind(userId, round8(amount), newBalance, ts),
  ]);

  return { ok: true, balance: newBalance };
}

// ---------------------------------------------------------------------------
// Markets
// ---------------------------------------------------------------------------

export async function createMarket(
  db: D1Database,
  opts: {
    question: string;
    description?: string | null;
    rules?: string | null;
    liquidity?: number;
    resolve_by?: number | null;
    created_by?: string | null;
  },
): Promise<Result<{ market: MarketView }>> {
  const question = (opts.question ?? "").trim();
  if (!question) {
    return { ok: false, error: "question is required" };
  }

  let liquidity = opts.liquidity ?? DEFAULT_LIQUIDITY;
  if (!Number.isFinite(liquidity) || liquidity < MIN_LIQUIDITY) {
    return {
      ok: false,
      error: `liquidity must be at least ${MIN_LIQUIDITY}`,
    };
  }
  liquidity = round8(liquidity);

  const id = generateId("mkt_");
  const created_at = nowUnix();
  const description =
    opts.description == null || opts.description === ""
      ? null
      : String(opts.description);
  const rules =
    opts.rules == null || opts.rules === "" ? null : String(opts.rules);
  const resolve_by =
    opts.resolve_by == null || !Number.isFinite(opts.resolve_by)
      ? null
      : Math.floor(opts.resolve_by);
  const created_by = opts.created_by ?? "admin";

  try {
    await db
      .prepare(
        `INSERT INTO markets
         (id, question, description, status, yes_pool, no_pool, resolution,
          resolve_by, created_by, created_at, resolved_at, rules)
         VALUES (?, ?, ?, 'open', ?, ?, NULL, ?, ?, ?, NULL, ?)`,
      )
      .bind(
        id,
        question,
        description,
        liquidity,
        liquidity,
        resolve_by,
        created_by,
        created_at,
        rules,
      )
      .run();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `failed to create market: ${msg}` };
  }

  const market = await getMarketRow(db, id);
  if (!market) return { ok: false, error: "market created but not found" };
  return { ok: true, market: toMarketView(market, 0) };
}

async function getMarketRow(
  db: D1Database,
  marketId: string,
): Promise<Market | null> {
  const row = await db
    .prepare(`SELECT * FROM markets WHERE id = ?`)
    .bind(marketId)
    .first();
  if (!row) return null;
  return mapMarket(row as Record<string, unknown>);
}

export async function getMarket(
  db: D1Database,
  marketId: string,
): Promise<Result<{ market: MarketView }>> {
  const market = await getMarketRow(db, marketId);
  if (!market) return { ok: false, error: "market not found" };
  const volume = await marketVolume(db, marketId);
  return { ok: true, market: toMarketView(market, volume) };
}

export async function listMarkets(
  db: D1Database,
  opts?: { status?: string; limit?: number },
): Promise<Result<{ markets: MarketView[] }>> {
  let limit = opts?.limit ?? DEFAULT_LIST_LIMIT;
  if (!Number.isFinite(limit) || limit < 1) limit = DEFAULT_LIST_LIMIT;
  limit = Math.min(Math.floor(limit), MAX_LIST_LIMIT);

  const status = opts?.status?.trim();
  const rows = status
    ? await db
        .prepare(
          `SELECT * FROM markets WHERE status = ? ORDER BY created_at DESC LIMIT ?`,
        )
        .bind(status, limit)
        .all()
    : await db
        .prepare(`SELECT * FROM markets ORDER BY created_at DESC LIMIT ?`)
        .bind(limit)
        .all();

  const markets = (rows.results ?? []).map((r) =>
    mapMarket(r as Record<string, unknown>),
  );
  const vols = await volumesForMarkets(
    db,
    markets.map((m) => m.id),
  );
  return {
    ok: true,
    markets: markets.map((m) => toMarketView(m, vols.get(m.id) ?? 0)),
  };
}

export async function lockMarket(
  db: D1Database,
  marketId: string,
): Promise<Result<{ market: MarketView }>> {
  const market = await getMarketRow(db, marketId);
  if (!market) return { ok: false, error: "market not found" };
  if (market.status !== "open") {
    return {
      ok: false,
      error: `market is ${market.status}, can only lock open markets`,
    };
  }
  await db
    .prepare(`UPDATE markets SET status = 'locked' WHERE id = ?`)
    .bind(marketId)
    .run();
  const updated = await getMarket(db, marketId);
  return updated;
}

export async function resolveMarket(
  db: D1Database,
  marketId: string,
  outcome: "yes" | "no" | "void",
): Promise<Result<{ market: MarketView; payouts: number }>> {
  if (outcome !== "yes" && outcome !== "no" && outcome !== "void") {
    return { ok: false, error: "outcome must be yes, no, or void" };
  }

  const market = await getMarketRow(db, marketId);
  if (!market) return { ok: false, error: "market not found" };
  if (market.status === "resolved" || market.status === "voided") {
    return { ok: false, error: `market already ${market.status}` };
  }
  if (market.status !== "open" && market.status !== "locked") {
    return { ok: false, error: `cannot resolve market in status ${market.status}` };
  }

  const posRows = await db
    .prepare(`SELECT * FROM positions WHERE market_id = ?`)
    .bind(marketId)
    .all();
  const positions = (posRows.results ?? []).map((r) =>
    mapPosition(r as Record<string, unknown>),
  );

  // Load current balances for all holders
  const userIds = [...new Set(positions.map((p) => p.user_id))];
  const balances = new Map<string, number>();
  for (const uid of userIds) {
    const u = await getUserById(db, uid);
    if (u) balances.set(uid, u.balance);
  }

  const ts = nowUnix();
  const stmts: D1PreparedStatement[] = [];
  let totalPayouts = 0;

  for (const pos of positions) {
    const bal = balances.get(pos.user_id);
    if (bal === undefined) continue;

    let payout = 0;
    let reason: LedgerReason;

    if (outcome === "void") {
      payout = round8(0.5 * (pos.shares_yes + pos.shares_no));
      reason = "void_refund";
    } else if (outcome === "yes") {
      payout = round8(pos.shares_yes);
      reason = "payout";
    } else {
      payout = round8(pos.shares_no);
      reason = "payout";
    }

    if (payout > 0) {
      const newBal = round8(bal + payout);
      balances.set(pos.user_id, newBal);
      totalPayouts = round8(totalPayouts + payout);
      stmts.push(
        db
          .prepare(`UPDATE users SET balance = ? WHERE id = ?`)
          .bind(newBal, pos.user_id),
      );
      stmts.push(
        db
          .prepare(
            `INSERT INTO ledger (user_id, amount, balance_after, reason, ref_type, ref_id, created_at)
             VALUES (?, ?, ?, ?, 'market', ?, ?)`,
          )
          .bind(pos.user_id, payout, newBal, reason, marketId, ts),
      );
    }
  }

  // Clear all positions for this market
  stmts.push(
    db
      .prepare(
        `UPDATE positions SET shares_yes = 0, shares_no = 0, updated_at = ? WHERE market_id = ?`,
      )
      .bind(ts, marketId),
  );

  const newStatus: MarketStatus = outcome === "void" ? "voided" : "resolved";
  const resolution: Resolution = outcome;
  stmts.push(
    db
      .prepare(
        `UPDATE markets SET status = ?, resolution = ?, resolved_at = ? WHERE id = ?`,
      )
      .bind(newStatus, resolution, ts, marketId),
  );

  if (stmts.length > 0) {
    // D1 batch limit is 100 statements; chunk if needed
    const CHUNK = 50;
    for (let i = 0; i < stmts.length; i += CHUNK) {
      await db.batch(stmts.slice(i, i + CHUNK));
    }
  }

  const updated = await getMarket(db, marketId);
  if (!updated.ok) return updated;
  return { ok: true, market: updated.market, payouts: totalPayouts };
}

// ---------------------------------------------------------------------------
// Positions & trades
// ---------------------------------------------------------------------------

export async function getPositions(
  db: D1Database,
  userId: string,
): Promise<Result<{ positions: PositionView[] }>> {
  const rows = await db
    .prepare(
      `SELECT p.market_id, p.shares_yes, p.shares_no,
              m.question, m.status, m.yes_pool, m.no_pool
       FROM positions p
       JOIN markets m ON m.id = p.market_id
       WHERE p.user_id = ?
         AND (p.shares_yes > 0 OR p.shares_no > 0)
       ORDER BY p.updated_at DESC`,
    )
    .bind(userId)
    .all<{
      market_id: string;
      shares_yes: number;
      shares_no: number;
      question: string;
      status: string;
      yes_pool: number;
      no_pool: number;
    }>();

  const positions: PositionView[] = (rows.results ?? []).map((r) => ({
    market_id: String(r.market_id),
    question: String(r.question),
    status: String(r.status) as MarketStatus,
    shares_yes: Number(r.shares_yes),
    shares_no: Number(r.shares_no),
    p_yes: round8(pYes(Number(r.yes_pool), Number(r.no_pool))),
  }));

  return { ok: true, positions };
}

export async function getPosition(
  db: D1Database,
  userId: string,
  marketId: string,
): Promise<Position | null> {
  const row = await db
    .prepare(
      `SELECT * FROM positions WHERE user_id = ? AND market_id = ?`,
    )
    .bind(userId, marketId)
    .first();
  if (!row) return null;
  return mapPosition(row as Record<string, unknown>);
}

export async function listTrades(
  db: D1Database,
  marketId: string,
  limit = 20,
): Promise<Result<{ trades: Trade[] }>> {
  let lim = limit;
  if (!Number.isFinite(lim) || lim < 1) lim = 20;
  lim = Math.min(Math.floor(lim), MAX_LIST_LIMIT);

  const rows = await db
    .prepare(
      `SELECT * FROM trades WHERE market_id = ? ORDER BY created_at DESC LIMIT ?`,
    )
    .bind(marketId, lim)
    .all();

  const trades = (rows.results ?? []).map((r) =>
    mapTrade(r as Record<string, unknown>),
  );
  return { ok: true, trades };
}

// ---------------------------------------------------------------------------
// Quote / Buy / Sell
// ---------------------------------------------------------------------------

export async function quote(
  db: D1Database,
  marketId: string,
  opts: {
    side: QuoteSide;
    action: QuoteAction;
    amount?: number;
    shares?: number;
  },
): Promise<Result<QuoteResult>> {
  const market = await getMarketRow(db, marketId);
  if (!market) return { ok: false, error: "market not found" };
  if (market.status !== "open") {
    return { ok: false, error: "market is not open" };
  }

  const { side, action } = opts;
  if (side !== "yes" && side !== "no") {
    return { ok: false, error: "side must be yes or no" };
  }
  if (action !== "buy" && action !== "sell") {
    return { ok: false, error: "action must be buy or sell" };
  }

  if (action === "buy") {
    const amount = Number(opts.amount);
    if (!(amount > 0)) {
      return { ok: false, error: "amount is required for buy" };
    }
    const r =
      side === "yes"
        ? ammBuyYes(market.yes_pool, market.no_pool, amount)
        : ammBuyNo(market.yes_pool, market.no_pool, amount);
    if (!r.ok) return r;
    return {
      ok: true,
      side,
      action,
      amount: round8(amount),
      shares: r.shares_out,
      avg_price: r.avg_price,
      p_yes_before: r.p_yes_before,
      p_yes_after: r.p_yes_after,
    };
  }

  // sell
  const shares = Number(opts.shares);
  if (!(shares > 0)) {
    return { ok: false, error: "shares is required for sell" };
  }
  const r =
    side === "yes"
      ? ammSellYes(market.yes_pool, market.no_pool, shares)
      : ammSellNo(market.yes_pool, market.no_pool, shares);
  if (!r.ok) return r;
  return {
    ok: true,
    side,
    action,
    amount: r.credits_out,
    shares: round8(shares),
    avg_price: r.avg_price,
    p_yes_before: r.p_yes_before,
    p_yes_after: r.p_yes_after,
  };
}

export async function buy(
  db: D1Database,
  userId: string,
  marketId: string,
  side: QuoteSide,
  amount: number,
): Promise<Result<TradeResult>> {
  if (side !== "yes" && side !== "no") {
    return { ok: false, error: "side must be yes or no" };
  }
  amount = Number(amount);
  if (!(amount > 0) || !Number.isFinite(amount)) {
    return { ok: false, error: "amount must be positive" };
  }
  amount = round8(amount);

  const market = await getMarketRow(db, marketId);
  if (!market) return { ok: false, error: "market not found" };
  if (market.status !== "open") {
    return { ok: false, error: "market is not open" };
  }

  const user = await getUserById(db, userId);
  if (!user) return { ok: false, error: "user not found" };
  if (user.balance < amount) {
    return { ok: false, error: "insufficient balance" };
  }

  const amm =
    side === "yes"
      ? ammBuyYes(market.yes_pool, market.no_pool, amount)
      : ammBuyNo(market.yes_pool, market.no_pool, amount);
  if (!amm.ok) return amm;

  const tradeSide: TradeSide = side === "yes" ? "buy_yes" : "buy_no";
  const tradeId = generateId("trd_");
  const ts = nowUnix();
  const newBalance = round8(user.balance - amount);

  const existing = await getPosition(db, userId, marketId);
  const shares_yes =
    side === "yes"
      ? round8((existing?.shares_yes ?? 0) + amm.shares_out)
      : (existing?.shares_yes ?? 0);
  const shares_no =
    side === "no"
      ? round8((existing?.shares_no ?? 0) + amm.shares_out)
      : (existing?.shares_no ?? 0);

  try {
    await db.batch([
      db
        .prepare(`UPDATE users SET balance = ? WHERE id = ? AND balance >= ?`)
        .bind(newBalance, userId, amount),
      db
        .prepare(
          `UPDATE markets SET yes_pool = ?, no_pool = ? WHERE id = ? AND status = 'open'`,
        )
        .bind(amm.new_yes, amm.new_no, marketId),
      db
        .prepare(
          `INSERT INTO positions (user_id, market_id, shares_yes, shares_no, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(user_id, market_id) DO UPDATE SET
             shares_yes = excluded.shares_yes,
             shares_no = excluded.shares_no,
             updated_at = excluded.updated_at`,
        )
        .bind(userId, marketId, shares_yes, shares_no, ts),
      db
        .prepare(
          `INSERT INTO trades
           (id, market_id, user_id, side, shares, cost, price, p_yes_after, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          tradeId,
          marketId,
          userId,
          tradeSide,
          amm.shares_out,
          amount,
          amm.avg_price,
          amm.p_yes_after,
          ts,
        ),
      db
        .prepare(
          `INSERT INTO ledger (user_id, amount, balance_after, reason, ref_type, ref_id, created_at)
           VALUES (?, ?, ?, 'buy', 'trade', ?, ?)`,
        )
        .bind(userId, round8(-amount), newBalance, tradeId, ts),
    ]);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `trade failed: ${msg}` };
  }

  // Re-read in case of concurrent issues (best-effort)
  const updatedUser = await getUserById(db, userId);
  const updatedMarket = await getMarketRow(db, marketId);
  const position =
    (await getPosition(db, userId, marketId)) ?? {
      user_id: userId,
      market_id: marketId,
      shares_yes,
      shares_no,
      updated_at: ts,
    };

  const m = updatedMarket ?? {
    ...market,
    yes_pool: amm.new_yes,
    no_pool: amm.new_no,
  };

  return {
    ok: true,
    trade: {
      id: tradeId,
      market_id: marketId,
      user_id: userId,
      side: tradeSide,
      shares: amm.shares_out,
      cost: amount,
      price: amm.avg_price,
      p_yes_after: amm.p_yes_after,
      created_at: ts,
    },
    position,
    balance: updatedUser?.balance ?? newBalance,
    market: marketPoolsView(m),
  };
}

export async function sell(
  db: D1Database,
  userId: string,
  marketId: string,
  side: QuoteSide,
  shares: number,
): Promise<Result<TradeResult>> {
  if (side !== "yes" && side !== "no") {
    return { ok: false, error: "side must be yes or no" };
  }
  shares = Number(shares);
  if (!(shares > 0) || !Number.isFinite(shares)) {
    return { ok: false, error: "shares must be positive" };
  }
  shares = round8(shares);

  const market = await getMarketRow(db, marketId);
  if (!market) return { ok: false, error: "market not found" };
  if (market.status !== "open") {
    return { ok: false, error: "market is not open" };
  }

  const user = await getUserById(db, userId);
  if (!user) return { ok: false, error: "user not found" };

  const existing = await getPosition(db, userId, marketId);
  const held =
    side === "yes"
      ? (existing?.shares_yes ?? 0)
      : (existing?.shares_no ?? 0);
  if (held < shares) {
    return { ok: false, error: "insufficient shares" };
  }

  const amm =
    side === "yes"
      ? ammSellYes(market.yes_pool, market.no_pool, shares)
      : ammSellNo(market.yes_pool, market.no_pool, shares);
  if (!amm.ok) return amm;

  const tradeSide: TradeSide = side === "yes" ? "sell_yes" : "sell_no";
  const tradeId = generateId("trd_");
  const ts = nowUnix();
  const credits = amm.credits_out;
  const newBalance = round8(user.balance + credits);

  const shares_yes =
    side === "yes"
      ? round8((existing?.shares_yes ?? 0) - shares)
      : (existing?.shares_yes ?? 0);
  const shares_no =
    side === "no"
      ? round8((existing?.shares_no ?? 0) - shares)
      : (existing?.shares_no ?? 0);

  if (shares_yes < -1e-12 || shares_no < -1e-12) {
    return { ok: false, error: "insufficient shares" };
  }

  try {
    await db.batch([
      db
        .prepare(`UPDATE users SET balance = ? WHERE id = ?`)
        .bind(newBalance, userId),
      db
        .prepare(
          `UPDATE markets SET yes_pool = ?, no_pool = ? WHERE id = ? AND status = 'open'`,
        )
        .bind(amm.new_yes, amm.new_no, marketId),
      db
        .prepare(
          `INSERT INTO positions (user_id, market_id, shares_yes, shares_no, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(user_id, market_id) DO UPDATE SET
             shares_yes = excluded.shares_yes,
             shares_no = excluded.shares_no,
             updated_at = excluded.updated_at`,
        )
        .bind(
          userId,
          marketId,
          Math.max(0, shares_yes),
          Math.max(0, shares_no),
          ts,
        ),
      db
        .prepare(
          `INSERT INTO trades
           (id, market_id, user_id, side, shares, cost, price, p_yes_after, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          tradeId,
          marketId,
          userId,
          tradeSide,
          shares,
          credits,
          amm.avg_price,
          amm.p_yes_after,
          ts,
        ),
      db
        .prepare(
          `INSERT INTO ledger (user_id, amount, balance_after, reason, ref_type, ref_id, created_at)
           VALUES (?, ?, ?, 'sell', 'trade', ?, ?)`,
        )
        .bind(userId, credits, newBalance, tradeId, ts),
    ]);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `trade failed: ${msg}` };
  }

  const updatedUser = await getUserById(db, userId);
  const updatedMarket = await getMarketRow(db, marketId);
  const position =
    (await getPosition(db, userId, marketId)) ?? {
      user_id: userId,
      market_id: marketId,
      shares_yes: Math.max(0, shares_yes),
      shares_no: Math.max(0, shares_no),
      updated_at: ts,
    };

  const m = updatedMarket ?? {
    ...market,
    yes_pool: amm.new_yes,
    no_pool: amm.new_no,
  };

  return {
    ok: true,
    trade: {
      id: tradeId,
      market_id: marketId,
      user_id: userId,
      side: tradeSide,
      shares,
      cost: credits,
      price: amm.avg_price,
      p_yes_after: amm.p_yes_after,
      created_at: ts,
    },
    position,
    balance: updatedUser?.balance ?? newBalance,
    market: marketPoolsView(m),
  };
}
