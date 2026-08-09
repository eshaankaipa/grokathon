/**
 * Attach the most relevant X posts under a market via recent search.
 *
 * Runs after market creation (and on admin refresh/backfill). Stores rows in
 * Supabase `market_related_tweets` for the website to render.
 */

import type { MarketView } from "./market";
import { getSupabase, type SupabaseEnv } from "./supabase";
import { xBearerSearch, type XSearchTweet } from "./x";

export interface MarketTweetEnv extends SupabaseEnv {
  X_BEARER_TOKEN?: string;
}

export interface RelatedTweetRow {
  market_id: string;
  tweet_id: string;
  author_id: string | null;
  author_username: string | null;
  author_name: string | null;
  author_avatar_url: string | null;
  text: string;
  tweet_url: string;
  like_count: number;
  repost_count: number;
  reply_count: number;
  impression_count: number;
  relevance_score: number;
  rank: number;
  is_source: boolean;
  tweet_created_at: string | null;
}

export interface AttachTweetsResult {
  ok: boolean;
  market_id: string;
  query?: string;
  stored: number;
  error?: string;
}

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "if", "then", "than", "to", "of", "in",
  "on", "at", "for", "from", "by", "with", "as", "is", "are", "was", "were",
  "be", "been", "being", "will", "would", "could", "should", "can", "may",
  "might", "do", "does", "did", "has", "have", "had", "its", "it", "this",
  "that", "these", "those", "their", "there", "what", "when", "where", "which",
  "who", "whom", "why", "how", "into", "over", "under", "about", "after",
  "before", "during", "between", "through", "above", "below", "up", "down",
  "out", "off", "again", "further", "once", "here", "all", "any", "both",
  "each", "few", "more", "most", "other", "some", "such", "no", "nor", "not",
  "only", "own", "same", "so", "too", "very", "just", "also", "vs", "via",
  "per", "next", "new", "end", "year", "years", "month", "months", "week",
  "weeks", "day", "days", "today", "tonight", "tomorrow", "yes",
]);

const DEFAULT_LIMIT = 6;
const SEARCH_FETCH = 25;

function metric(tweet: XSearchTweet, key: string): number {
  return Number(tweet.public_metrics?.[key] ?? 0) || 0;
}

function tweetUrl(tweet: XSearchTweet): string {
  if (tweet.url) return tweet.url;
  if (tweet.author_username) {
    return `https://x.com/${tweet.author_username}/status/${tweet.id}`;
  }
  return `https://x.com/i/status/${tweet.id}`;
}

/** Build a concise recent-search query from a market question. */
export function buildSearchQueryFromQuestion(question: string): string {
  const raw = (question ?? "").trim();
  if (!raw) return "lang:en -is:retweet";

  const quoted = [...raw.matchAll(/"([^"]{3,80})"/g)].map((m) => m[1].trim());

  const tokens = raw
    .replace(/[?#！？]/g, " ")
    .replace(/https?:\/\/\S+/gi, " ")
    .split(/[\s,.;:!()[\]{}|/\\]+/)
    .map((t) => t.trim())
    .filter(Boolean);

  const keep: string[] = [];
  for (const t of tokens) {
    if (t.startsWith("@") && t.length > 2) {
      keep.push(t);
      continue;
    }
    if (t.startsWith("$") && t.length > 1) {
      keep.push(t.toUpperCase());
      continue;
    }
    if (/^\d{4}$/.test(t) || /^\$?\d+(\.\d+)?[kmb%]?$/i.test(t)) {
      keep.push(t);
      continue;
    }
    const lower = t.toLowerCase();
    if (STOPWORDS.has(lower)) continue;
    if (lower.length < 3) continue;
    if (!/[\p{L}\p{N}]/u.test(t)) continue;
    keep.push(t);
  }

  const seen = new Set<string>();
  const unique: string[] = [];
  for (const q of quoted) {
    const key = q.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(`"${q}"`);
  }
  for (const t of keep) {
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(t);
  }

  const terms: string[] = [];
  let budget = 420;
  for (const t of unique.slice(0, 12)) {
    const add = (terms.length ? 1 : 0) + t.length;
    if (add > budget) break;
    terms.push(t);
    budget -= add;
  }

  const core = terms.length > 0 ? terms.join(" ") : raw.slice(0, 80);
  return `${core} lang:en -is:retweet`;
}

/** Engagement-weighted relevance for ranking search hits. */
export function scoreTweetRelevance(tweet: XSearchTweet): number {
  const likes = metric(tweet, "like_count");
  const reposts = metric(tweet, "retweet_count");
  const replies = metric(tweet, "reply_count");
  const impressions = metric(tweet, "impression_count");
  return likes * 1 + reposts * 3 + replies * 2 + Math.log10(impressions + 1) * 4;
}

function tweetToRow(
  marketId: string,
  tweet: XSearchTweet,
  rank: number,
  isSource: boolean,
): RelatedTweetRow {
  return {
    market_id: marketId,
    tweet_id: tweet.id,
    author_id: tweet.author_id ?? null,
    author_username: tweet.author_username ?? null,
    author_name: tweet.author_name ?? null,
    author_avatar_url: tweet.author_avatar_url ?? null,
    text: tweet.text,
    tweet_url: tweetUrl(tweet),
    like_count: metric(tweet, "like_count"),
    repost_count: metric(tweet, "retweet_count"),
    reply_count: metric(tweet, "reply_count"),
    impression_count: metric(tweet, "impression_count"),
    relevance_score: Math.round(scoreTweetRelevance(tweet) * 10000) / 10000,
    rank,
    is_source: isSource,
    tweet_created_at: tweet.created_at ?? null,
  };
}

async function replaceRelatedTweets(
  env: SupabaseEnv,
  marketId: string,
  rows: RelatedTweetRow[],
): Promise<{ ok: true; stored: number } | { ok: false; error: string }> {
  const supabase = getSupabase(env);
  const { error: delError } = await supabase
    .from("market_related_tweets")
    .delete()
    .eq("market_id", marketId);
  if (delError) return { ok: false, error: delError.message };

  if (rows.length === 0) return { ok: true, stored: 0 };

  const { error: insError } = await supabase
    .from("market_related_tweets")
    .insert(rows);
  if (insError) return { ok: false, error: insError.message };
  return { ok: true, stored: rows.length };
}

/**
 * Search X for posts about this market and persist the top matches.
 * Safe to call fire-and-forget — never throws.
 */
export async function attachRelatedTweets(
  env: MarketTweetEnv,
  market: Pick<
    MarketView,
    "id" | "question" | "source_tweet_id" | "source_tweet_url"
  >,
  opts?: { limit?: number },
): Promise<AttachTweetsResult> {
  const marketId = market.id;
  try {
    const bearer = env.X_BEARER_TOKEN?.trim();
    if (!bearer) {
      return {
        ok: false,
        market_id: marketId,
        stored: 0,
        error: "X_BEARER_TOKEN not configured",
      };
    }

    const limit = Math.min(Math.max(opts?.limit ?? DEFAULT_LIMIT, 1), 12);
    const query = buildSearchQueryFromQuestion(market.question);
    const searched = await xBearerSearch(
      bearer,
      query,
      Math.max(SEARCH_FETCH, limit + 5),
    );

    if (!searched.ok) {
      const detail =
        typeof searched.error === "object"
          ? JSON.stringify(searched.error).slice(0, 300)
          : String(searched.error);
      return {
        ok: false,
        market_id: marketId,
        query,
        stored: 0,
        error: `X search failed (${searched.status}): ${detail}`,
      };
    }

    const ranked = [...searched.tweets]
      .filter(
        (t) =>
          t.text &&
          t.text.replace(/https?:\/\/\S+/g, "").trim().length >= 12,
      )
      .map((t) => ({ tweet: t, score: scoreTweetRelevance(t) }))
      .sort((a, b) => b.score - a.score);

    const rows: RelatedTweetRow[] = [];
    const seen = new Set<string>();

    if (market.source_tweet_id) {
      const fromSearch = ranked.find(
        (r) => r.tweet.id === market.source_tweet_id,
      );
      if (fromSearch) {
        rows.push(tweetToRow(marketId, fromSearch.tweet, 0, true));
        seen.add(fromSearch.tweet.id);
      } else {
        rows.push({
          market_id: marketId,
          tweet_id: market.source_tweet_id,
          author_id: null,
          author_username: null,
          author_name: null,
          author_avatar_url: null,
          text: market.question,
          tweet_url:
            market.source_tweet_url ||
            `https://x.com/i/web/status/${market.source_tweet_id}`,
          like_count: 0,
          repost_count: 0,
          reply_count: 0,
          impression_count: 0,
          relevance_score: 9999,
          rank: 0,
          is_source: true,
          tweet_created_at: null,
        });
        seen.add(market.source_tweet_id);
      }
    }

    let rank = rows.length;
    for (const { tweet } of ranked) {
      if (seen.has(tweet.id)) continue;
      rows.push(tweetToRow(marketId, tweet, rank, false));
      seen.add(tweet.id);
      rank += 1;
      if (rows.length >= limit) break;
    }

    const saved = await replaceRelatedTweets(env, marketId, rows);
    if (!saved.ok) {
      return {
        ok: false,
        market_id: marketId,
        query,
        stored: 0,
        error: saved.error,
      };
    }

    return { ok: true, market_id: marketId, query, stored: saved.stored };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, market_id: marketId, stored: 0, error: message };
  }
}

export async function listRelatedTweets(
  env: SupabaseEnv,
  marketId: string,
): Promise<
  { ok: true; tweets: RelatedTweetRow[] } | { ok: false; error: string }
> {
  const { data, error } = await getSupabase(env)
    .from("market_related_tweets")
    .select(
      "market_id,tweet_id,author_id,author_username,author_name,author_avatar_url,text,tweet_url,like_count,repost_count,reply_count,impression_count,relevance_score,rank,is_source,tweet_created_at",
    )
    .eq("market_id", marketId)
    .order("rank", { ascending: true });
  if (error) return { ok: false, error: error.message };
  return { ok: true, tweets: (data || []) as RelatedTweetRow[] };
}

/**
 * Backfill related tweets for open markets that have none yet.
 * Rate-limit friendly: processes a small batch per call.
 */
export async function backfillRelatedTweets(
  env: MarketTweetEnv,
  opts?: { limit?: number },
): Promise<{
  ok: true;
  attempted: number;
  succeeded: number;
  failed: number;
  results: AttachTweetsResult[];
}> {
  const batch = Math.min(Math.max(opts?.limit ?? 5, 1), 20);
  const supabase = getSupabase(env);

  const { data: markets, error } = await supabase
    .from("markets")
    .select("id,question,source_tweet_id,source_tweet_url")
    .eq("status", "open")
    .order("created_at", { ascending: false })
    .limit(80);

  if (error || !markets) {
    return {
      ok: true,
      attempted: 0,
      succeeded: 0,
      failed: 0,
      results: [
        {
          ok: false,
          market_id: "",
          stored: 0,
          error: error?.message || "failed to list markets",
        },
      ],
    };
  }

  const results: AttachTweetsResult[] = [];
  let attempted = 0;
  let succeeded = 0;
  let failed = 0;

  for (const m of markets as Array<Record<string, unknown>>) {
    if (attempted >= batch) break;
    const marketId = String(m.id);
    const { count } = await supabase
      .from("market_related_tweets")
      .select("id", { count: "exact", head: true })
      .eq("market_id", marketId);
    if ((count ?? 0) > 0) continue;

    attempted += 1;
    const r = await attachRelatedTweets(env, {
      id: marketId,
      question: String(m.question || ""),
      source_tweet_id: m.source_tweet_id ? String(m.source_tweet_id) : null,
      source_tweet_url: m.source_tweet_url ? String(m.source_tweet_url) : null,
    });
    results.push(r);
    if (r.ok) succeeded += 1;
    else failed += 1;
  }

  return { ok: true, attempted, succeeded, failed, results };
}
