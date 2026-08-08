-- Link X mentions → markets (create once, then redirect on reprocess)
CREATE TABLE IF NOT EXISTS mention_markets (
  tweet_id TEXT PRIMARY KEY,
  market_id TEXT NOT NULL,
  action TEXT NOT NULL,
  question TEXT,
  author_id TEXT,
  author_username TEXT,
  mention_text TEXT,
  processed_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mention_markets_market
  ON mention_markets(market_id);

CREATE INDEX IF NOT EXISTS idx_mention_markets_processed
  ON mention_markets(processed_at DESC);

-- Optional normalized question for faster dedupe of open markets
-- (app also matches in-memory; column helps future queries)
CREATE INDEX IF NOT EXISTS idx_markets_status_created
  ON markets(status, created_at DESC);
