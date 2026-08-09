import { createMarket, type MarketView } from "./market";
import type { SupabaseEnv } from "./supabase";
import { xCreateTweet, type XCreds } from "./x";

const CRON_ID = "modern_market_creator";
const WEB_BASE_URL = "https://xmarket.aidenhuang.com";

interface MarketCreatorEnv extends SupabaseEnv {
  DB: D1Database;
  X_API_KEY: string;
  X_API_SECRET: string;
  X_ACCESS_TOKEN: string;
  X_ACCESS_TOKEN_SECRET: string;
}

interface MarketTemplate {
  question: string;
  rules: string;
  category: string;
  resolveAfterSeconds: number;
}

const TEMPLATES: MarketTemplate[] = [
  {
    question: "Will the Los Angeles Dodgers win their next game?",
    rules: "Resolves YES if the Los Angeles Dodgers win their next official regular-season or postseason game. Resolves NO if they lose or the game ends in a tie/void.",
    category: "Sports",
    resolveAfterSeconds: 6 * 60 * 60,
  },
  {
    question: "Will Hunter Biden be the Democratic nominee for president in 2028?",
    rules: "Resolves YES if Hunter Biden is formally selected as the Democratic Party's nominee for the 2028 U.S. presidential election. Resolves NO otherwise.",
    category: "Politics",
    resolveAfterSeconds: 2 * 365 * 24 * 60 * 60,
  },
  {
    question: "Will the Federal Reserve cut interest rates at its next meeting?",
    rules: "Resolves YES if the Federal Open Market Committee announces a rate cut at its next scheduled meeting. Resolves NO if rates are held or raised.",
    category: "Finance",
    resolveAfterSeconds: 14 * 24 * 60 * 60,
  },
  {
    question: "Will Bitcoin trade above $100,000 before the end of 2026?",
    rules: "Resolves YES if the BTC/USD price on a major exchange (Coinbase, Kraken, Binance) reaches or exceeds $100,000 at any time before 2027-01-01 00:00 UTC.",
    category: "Crypto",
    resolveAfterSeconds: 365 * 24 * 60 * 60,
  },
  {
    question: "Will OpenAI release GPT-5 before 2026?",
    rules: "Resolves YES if OpenAI publicly announces or releases a model named GPT-5 or a successor branded as the next major GPT generation before 2026-01-01. Resolves NO otherwise.",
    category: "Tech",
    resolveAfterSeconds: 90 * 24 * 60 * 60,
  },
  {
    question: "Will it rain in San Francisco today?",
    rules: "Resolves YES if measurable precipitation is recorded at any NOAA/NWS station in San Francisco, CA between 00:00 and 23:59 UTC today. Resolves NO otherwise.",
    category: "Weather",
    resolveAfterSeconds: 18 * 60 * 60,
  },
  {
    question: "Will the New York Giants win their next game?",
    rules: "Resolves YES if the New York Giants win their next official regular-season or postseason game. Resolves NO if they lose or the game is void/tied.",
    category: "Sports",
    resolveAfterSeconds: 6 * 60 * 60,
  },
  {
    question: "Will Donald Trump post on X before the end of the week?",
    rules: "Resolves YES if @realDonaldTrump posts at least one new post on x.com before the following Sunday 23:59 UTC. Resolves NO otherwise.",
    category: "Politics",
    resolveAfterSeconds: 7 * 24 * 60 * 60,
  },
  {
    question: "Will Apple announce new iPhones before the end of September?",
    rules: "Resolves YES if Apple Inc. officially announces a new iPhone model before the last day of September. Resolves NO otherwise.",
    category: "Tech",
    resolveAfterSeconds: 30 * 24 * 60 * 60,
  },
  {
    question: "Will a SpaceX Starship launch occur this month?",
    rules: "Resolves YES if SpaceX launches any Starship vehicle in the current calendar month. Resolves NO otherwise.",
    category: "Science",
    resolveAfterSeconds: 30 * 24 * 60 * 60,
  },
];

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function getNextRun(db: D1Database): Promise<number | null> {
  const row = await db
    .prepare("SELECT next_run_at FROM cron_meta WHERE id = ?")
    .bind(CRON_ID)
    .first<{ next_run_at: string }>();
  return row?.next_run_at ? new Date(row.next_run_at).getTime() : null;
}

async function setNextRun(db: D1Database, next: number): Promise<void> {
  const iso = new Date(next).toISOString();
  await db
    .prepare(
      "INSERT INTO cron_meta (id, next_run_at) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET next_run_at = excluded.next_run_at"
    )
    .bind(CRON_ID, iso)
    .run();
}

function getCreds(env: MarketCreatorEnv): XCreds | null {
  if (
    !env.X_API_KEY ||
    !env.X_API_SECRET ||
    !env.X_ACCESS_TOKEN ||
    !env.X_ACCESS_TOKEN_SECRET
  ) {
    return null;
  }
  return {
    apiKey: env.X_API_KEY,
    apiSecret: env.X_API_SECRET,
    accessToken: env.X_ACCESS_TOKEN,
    accessTokenSecret: env.X_ACCESS_TOKEN_SECRET,
  };
}

export async function autoCreateModernMarket(
  env: MarketCreatorEnv,
): Promise<{ ok: boolean; market?: MarketView; error?: string; tweet_id?: string; tweet_error?: string }> {
  const db = (env as { DB?: D1Database }).DB;
  if (!db) return { ok: false, error: "D1 DB binding missing" };

  const now = Date.now();
  const nextRun = await getNextRun(db);
  if (nextRun !== null && now < nextRun) {
    return { ok: false, error: "not due yet" };
  }

  // Pick a template, shuffle
  const shuffled = [...TEMPLATES].sort(() => Math.random() - 0.5);
  let created: MarketView | null = null;
  let lastError = "";

  for (const t of shuffled) {
    const resolveBy = Math.floor(now / 1000) + t.resolveAfterSeconds;
    const result = await createMarket(env, {
      question: t.question,
      rules: t.rules,
      category: t.category,
      liquidity: 100,
      resolve_by: resolveBy,
    });
    if (result.ok) {
      created = result.market;
      break;
    }
    lastError = result.error || "";
  }

  // Schedule the next run 3-5 minutes from now, regardless of success
  const next = now + randomInt(3, 5) * 60 * 1000;
  await setNextRun(db, next);

  if (created) {
    const tweet = `${created.question}\n\n${WEB_BASE_URL}/market/${created.slug}`;
    const creds = getCreds(env);
    let tweet_id: string | undefined;
    let tweet_error: string | undefined;
    if (creds) {
      const posted = await xCreateTweet(creds, tweet);
      if (posted.ok) tweet_id = posted.id;
      else tweet_error = posted.error;
    }
    return { ok: true, market: created, tweet_id, tweet_error };
  }
  return { ok: false, error: lastError || "all templates already exist" };
}
