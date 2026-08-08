-- Prediction markets: users, AMM markets, positions, trades, ledger

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  api_key_hash TEXT NOT NULL UNIQUE,
  api_key_prefix TEXT NOT NULL,
  balance REAL NOT NULL DEFAULT 1000,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS markets (
  id TEXT PRIMARY KEY,
  question TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL,
  yes_pool REAL NOT NULL,
  no_pool REAL NOT NULL,
  resolution TEXT,
  resolve_by INTEGER,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  rules TEXT
);

CREATE TABLE IF NOT EXISTS positions (
  user_id TEXT NOT NULL,
  market_id TEXT NOT NULL,
  shares_yes REAL NOT NULL DEFAULT 0,
  shares_no REAL NOT NULL DEFAULT 0,
  updated_at INTEGER,
  PRIMARY KEY (user_id, market_id)
);

CREATE TABLE IF NOT EXISTS trades (
  id TEXT PRIMARY KEY,
  market_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  side TEXT NOT NULL,
  shares REAL NOT NULL,
  cost REAL NOT NULL,
  price REAL NOT NULL,
  p_yes_after REAL NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  amount REAL NOT NULL,
  balance_after REAL NOT NULL,
  reason TEXT NOT NULL,
  ref_type TEXT,
  ref_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_markets_status_created
  ON markets(status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_trades_market_created
  ON trades(market_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ledger_user_created
  ON ledger(user_id, created_at DESC);
