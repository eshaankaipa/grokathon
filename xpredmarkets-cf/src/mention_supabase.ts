/**
 * Mention -> Supabase public.markets wrapper using Grok for parsing.
 */

import type { D1Database } from "@cloudflare/workers-types";
import { createMarket, getMarket, type MarketView, type Result } from "./market";
import {
  getProcessedTweet,
  marketUrls,
  saveProcessed,
  type MentionAction,
  type MentionMarketResult,
} from "./mention_market";

import type { SupabaseEnv } from "./supabase";
import { parseMarketWithGrok } from "./xai";

export interface MentionSupabaseEnv extends SupabaseEnv {
  DB: D1Database;
  XAI_API_KEY: string;
  BOT_USERNAME?: string;
  BOT_NAME?: string;
}

function pack(
  action: MentionAction,
  market: MarketView | undefined,
  extra: Partial<MentionMarketResult> = {},
): MentionMarketResult {
  if (!market) {
    return { action, ...extra };
  }
  const urls = marketUrls(market.id);
  return {
    action,
    market,
    market_id: market.id,
    question: market.question,
    ...urls,
    ...extra,
  };
}

export async function processMentionToSupabase(
  env: MentionSupabaseEnv,
  input: {
    text: string;
    tweet_id?: string;
    author_id?: string | null;
    author_username?: string | null;
    botUsername?: string;
    botUserId?: string;
    liquidity?: number;
  },
): Promise<Result<MentionMarketResult>> {
  const tweetId = input.tweet_id?.trim();
  const botUsername = input.botUsername ?? env.BOT_USERNAME ?? "XPredMarkets";

  if (input.botUserId && input.author_id && input.botUserId === input.author_id) {
    return {
      ok: true,
      action: "skipped",
      reason: "self-mention from bot",
      tweet_id: tweetId,
      author_username: input.author_username,
    };
  }

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

  const parsed = await parseMarketWithGrok(input.text, env.XAI_API_KEY, {
    botUsername,
  });
  if (!parsed.ok) {
    return { ok: false, error: parsed.error };
  }

  const liquidity =
    input.liquidity && Number.isFinite(input.liquidity)
      ? input.liquidity
      : 100;

  const sourceUrl = tweetId
    ? `https://x.com/i/web/status/${tweetId}`
    : undefined;

  const closesAt = parsed.data.closes_at;
  const resolveBy = closesAt
    ? Math.floor(new Date(closesAt).getTime() / 1000)
    : undefined;
  const created = await createMarket(env, {
    question: parsed.data.question,
    description: parsed.data.description,
    rules: parsed.data.resolution_criteria,
    category: parsed.data.category,
    resolve_by: resolveBy,
    source_tweet_id: tweetId,
    source_tweet_url: sourceUrl,
    created_by: input.author_username,
    liquidity,
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
      reason: "new market from grok-parsed mention",
      tweet_id: tweetId,
      author_username: input.author_username,
    }),
  };
}
