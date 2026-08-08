CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tweet_id TEXT NOT NULL UNIQUE,
  text TEXT NOT NULL,
  reply_to TEXT,
  url TEXT,
  created_at INTEGER NOT NULL,
  raw_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_posts_created_at ON posts(created_at DESC);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  detail TEXT,
  created_at INTEGER NOT NULL
);
