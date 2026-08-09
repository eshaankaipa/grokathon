/**
 * Mention → market wrapper:
 * parse an @XPredMarkets mention and either create a new market
 * or redirect to an existing one (same tweet, same market id, or same question).
 */

import {
  createMarket,
  getMarket,
  listMarkets,
  type MarketView,
  type Result,
} from "./market";
import type { XMention } from "./x";
import type { D1Database } from "@cloudflare/workers-types";
import type { SupabaseEnv } from "./supabase";

type MentionEnv = SupabaseEnv & { DB: D1Database };

const WEB_BASE_URL = "https://xmarket.aidenhuang.com";
const API_BASE_URL = "https://xpred.aidenhuang.com";
const MARKET_ID_RE = /\bmkt_[a-f0-9]{16,}\b/i;
const MARKET_URL_RE =
  /(?:https?:\/\/)?(?:www\.)?(?:xmarket(?:-web-3ji)?\.aidenhuang\.com|xmarket(?:-web-3ji)?\.pages\.dev)\/market\/([a-z0-9-]+)/i;

export type MentionAction = "created" | "redirected" | "skipped";

export interface MentionMarketResult {
  action: MentionAction;
  reason?: string;
  tweet_id?: string;
  author_username?: string | null;
  question?: string;
  market?: MarketView;
  market_id?: string;
  url?: string;
  og_image?: string;
  /** True when this tweet was already processed before */
  already_processed?: boolean;
}

export function marketUrls(market: MarketView): { url: string; og_image: string } {
  return {
    url: `${WEB_BASE_URL}/market/${market.slug}`,
    og_image: `${API_BASE_URL}/markets/${market.id}/og.png`,
  };
}

/** Normalize a question for dedupe matching. */
export function normalizeQuestion(q: string): string {
  return q
    .toLowerCase()
    .replace(/@\w+/g, " ")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/[^\p{L}\p{N}\s?]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Strip bot handle + command words; return candidate market question.
 */
export function extractQuestion(
  text: string,
  botUsername = "XPredMarkets",
): string {
  let t = text.trim();
  // remove all @mentions
  t = t.replace(/@\w+/gi, " ");
  // common command prefixes
  t = t.replace(
    /\b(create|new|open|make|start)?\s*(a\s+)?(market|prediction|bet)\b[:\-]?\s*/gi,
    " ",
  );
  t = t.replace(/\b(please|pls|plz)\b/gi, " ");
  // drop bare bot name residual
  t = t.replace(new RegExp(`\\b${botUsername}\\b`, "gi"), " ");
  t = t.replace(/\s+/g, " ").trim();
  // Prefer text that ends with ? if multi-sentence
  const qMatch = t.match(/[^?]*\?/);
  if (qMatch && qMatch[0].trim().length >= 8) {
    return qMatch[0].trim();
  }
  return t;
}

export type ParsedMention =
  | { kind: "redirect"; marketId: string; source: "id" | "url" }
  | { kind: "create"; question: string }
  | { kind: "skip"; reason: string };

export function parseMentionText(
  text: string,
  opts?: { botUsername?: string; botUserId?: string; authorId?: string },
): ParsedMention {
  const botUsername = opts?.botUsername ?? "XPredMarkets";
  const raw = (text ?? "").trim();
  if (!raw) return { kind: "skip", reason: "empty mention" };

  // Ignore bot's own posts that self-@mention
  if (opts?.botUserId && opts?.authorId && opts.botUserId === opts.authorId) {
    return { kind: "skip", reason: "self-mention from bot" };
  }

  const urlMatch = raw.match(MARKET_URL_RE);
  if (urlMatch?.[1]) {
    return {
      kind: "redirect",
      marketId: urlMatch[1],
      source: "url",
    };
  }

  const idMatch = raw.match(MARKET_ID_RE);
  if (idMatch?.[0]) {
    return { kind: "redirect", marketId: idMatch[0], source: "id" };
  }

  const question = extractQuestion(raw, botUsername);
  if (question.length < 8) {
    return {
      kind: "skip",
      reason: "no market question found (need ≥8 chars after stripping @mentions)",
    };
  }
  // Must look like a claim / question, not pure emoji noise
  if (!/[\p{L}\p{N}]/u.test(question)) {
    return { kind: "skip", reason: "question has no letters/numbers" };
  }

  return { kind: "create", question };
}

export async function getProcessedTweet(
  env: MentionEnv,
  tweetId: string,
): Promise<{ market_id: string; action: string; question: string | null } | null> {
  const row = await env.DB
    .prepare(
      `SELECT market_id, action, question FROM mention_markets WHERE tweet_id = ?`,
    )
    .bind(tweetId)
    .first<{ market_id: string; action: string; question: string | null }>();
  return row ?? null;
}

export async function saveProcessed(
  env: MentionEnv,
  row: {
    tweet_id: string;
    market_id: string;
    action: string;
    question?: string | null;
    author_id?: string | null;
    author_username?: string | null;
    mention_text?: string | null;
  },
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await env.DB
    .prepare(
      `INSERT INTO mention_markets
         (tweet_id, market_id, action, question, author_id, author_username, mention_text, processed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tweet_id) DO UPDATE SET
         market_id = excluded.market_id,
         action = excluded.action,
         question = excluded.question,
         processed_at = excluded.processed_at`,
    )
    .bind(
      row.tweet_id,
      row.market_id,
      row.action,
      row.question ?? null,
      row.author_id ?? null,
      row.author_username ?? null,
      row.mention_text ?? null,
      now,
    )
    .run();
}

async function findOpenByQuestion(
  env: MentionEnv,
  question: string,
): Promise<MarketView | null> {
  const norm = normalizeQuestion(question);
  if (!norm) return null;
  const listed = await listMarkets(env, { status: "open", limit: 100 });
  if (!listed.ok) return null;
  for (const m of listed.markets) {
    if (normalizeQuestion(m.question) === norm) return m;
  }
  // Also match locked markets as redirect targets
  const locked = await listMarkets(env, { status: "locked", limit: 50 });
  if (locked.ok) {
    for (const m of locked.markets) {
      if (normalizeQuestion(m.question) === norm) return m;
    }
  }
  return null;
}

function pack(
  action: MentionAction,
  market: MarketView | undefined,
  extra: Partial<MentionMarketResult> = {},
): MentionMarketResult {
  if (!market) {
    return { action, ...extra };
  }
  const urls = marketUrls(market);
  return {
    action,
    market,
    market_id: market.id,
    question: market.question,
    ...urls,
    ...extra,
  };
}

/**
 * Core wrapper: from mention text (+ optional tweet id), create or redirect.
 */
export async function processMentionToMarket(
  env: MentionEnv,
  input: {
    text: string;
    tweet_id?: string;
    author_id?: string | null;
    author_username?: string | null;
    botUsername?: string;
    botUserId?: string;
    liquidity?: number;
    force_create?: boolean;
  },
): Promise<Result<MentionMarketResult>> {
  const tweetId = input.tweet_id?.trim();

  // Idempotent: same tweet always maps to same market
  if (tweetId) {
    const prev = await getProcessedTweet(env, tweetId);
    if (prev) {
      const m = await getMarket(env, prev.market_id);
      if (m.ok) {
        return {
          ok: true,
          ...pack("redirected", m.market, {
            already_processed: true,
            reason: "tweet already linked to market",
            tweet_id: tweetId,
            author_username: input.author_username,
          }),
        };
      }
    }
  }

  const parsed = parseMentionText(input.text, {
    botUsername: input.botUsername,
    botUserId: input.botUserId,
    authorId: input.author_id ?? undefined,
  });

  if (parsed.kind === "skip") {
    return {
      ok: true,
      action: "skipped",
      reason: parsed.reason,
      tweet_id: tweetId,
      author_username: input.author_username,
    };
  }

  if (parsed.kind === "redirect") {
    const m = await getMarket(env, parsed.marketId);
    if (!m.ok) {
      return {
        ok: false,
        error: `market ${parsed.marketId} not found`,
      };
    }
    if (tweetId) {
      await saveProcessed(env, {
        tweet_id: tweetId,
        market_id: m.market.id,
        action: "redirected",
        question: m.market.question,
        author_id: input.author_id,
        author_username: input.author_username,
        mention_text: input.text,
      });
    }
    return {
      ok: true,
      ...pack("redirected", m.market, {
        reason: `explicit market ${parsed.source}`,
        tweet_id: tweetId,
        author_username: input.author_username,
      }),
    };
  }

  // create path — but dedupe by question unless force_create
  if (!input.force_create) {
    const existing = await findOpenByQuestion(env, parsed.question);
    if (existing) {
      if (tweetId) {
        await saveProcessed(env, {
          tweet_id: tweetId,
          market_id: existing.id,
          action: "redirected",
          question: existing.question,
          author_id: input.author_id,
          author_username: input.author_username,
          mention_text: input.text,
        });
      }
      return {
        ok: true,
        ...pack("redirected", existing, {
          reason: "matching open/locked market question",
          tweet_id: tweetId,
          author_username: input.author_username,
        }),
      };
    }
  }

  const created = await createMarket(env, {
    question: parsed.question,
    description: tweetId
      ? `From mention ${tweetId}${input.author_username ? ` by @${input.author_username}` : ""}`
      : `From mention by @${input.author_username ?? "unknown"}`,
    liquidity: input.liquidity,
    created_by: input.author_username
      ? `mention:@${input.author_username}`
      : "mention",
  });
  if (!created.ok) return created;

  if (tweetId) {
    await saveProcessed(env, {
      tweet_id: tweetId,
      market_id: created.market.id,
      action: "created",
      question: created.market.question,
      author_id: input.author_id,
      author_username: input.author_username,
      mention_text: input.text,
    });
  }

  return {
    ok: true,
    ...pack("created", created.market, {
      reason: "new market from mention",
      tweet_id: tweetId,
      author_username: input.author_username,
    }),
  };
}

/**
 * Process a batch of X mentions (from /mentions poll).
 */
export async function processMentionsBatch(
  env: MentionEnv,
  mentions: XMention[],
  opts: {
    botUsername?: string;
    botUserId?: string;
    liquidity?: number;
  } = {},
): Promise<{
  results: MentionMarketResult[];
  created: number;
  redirected: number;
  skipped: number;
}> {
  const results: MentionMarketResult[] = [];
  let created = 0;
  let redirected = 0;
  let skipped = 0;

  for (const m of mentions) {
    const r = await processMentionToMarket(env, {
      text: m.text,
      tweet_id: m.id,
      author_id: m.author_id,
      author_username: m.author_username,
      botUsername: opts.botUsername,
      botUserId: opts.botUserId,
      liquidity: opts.liquidity,
    });
    if (!r.ok) {
      results.push({
        action: "skipped",
        reason: r.error,
        tweet_id: m.id,
        author_username: m.author_username,
      });
      skipped += 1;
      continue;
    }
    const { ok: _ok, ...rest } = r;
    void _ok;
    results.push(rest);
    if (rest.action === "created") created += 1;
    else if (rest.action === "redirected") redirected += 1;
    else skipped += 1;
  }

  return { results, created, redirected, skipped };
}

/** Build a reply tweet body for the bot (optional announce). */
export function formatMarketReply(result: MentionMarketResult): string | null {
  if (!result.market_id || !result.url) return null;
  if (result.action === "created") {
    return `Market open: ${result.question}\n\nTrade: ${result.url}\nCard: ${result.og_image}`;
  }
  if (result.action === "redirected") {
    return `That market already exists — jump in:\n${result.url}\n${result.og_image}`;
  }
  return null;
}
