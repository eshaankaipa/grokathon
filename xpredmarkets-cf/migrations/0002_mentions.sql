CREATE TABLE IF NOT EXISTS mentions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tweet_id TEXT NOT NULL UNIQUE,
  text TEXT NOT NULL,
  author_id TEXT,
  author_username TEXT,
  author_name TEXT,
  conversation_id TEXT,
  url TEXT,
  tweet_created_at TEXT,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  raw_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_mentions_first_seen ON mentions(first_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_mentions_tweet_created ON mentions(tweet_created_at DESC);
