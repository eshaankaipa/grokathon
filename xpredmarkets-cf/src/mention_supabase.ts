/**
 * Mention -> Supabase markets via Grok binary gate.
 * CREATE only for clean yes/no; otherwise skip with suggestions.
 */

import type { D1Database } from "@cloudflare/workers-types";
import {
  processMentionWithGate,
  type MentionMarketResult,
} from "./mention_market";
import type { Result } from "./market";
import type { SupabaseEnv } from "./supabase";

export interface MentionSupabaseEnv extends SupabaseEnv {
  DB: D1Database;
  XAI_API_KEY: string;
  BOT_USERNAME?: string;
  BOT_NAME?: string;
}

/**
 * Preferred mention path when XAI + Supabase are configured.
 * Delegates to the shared Grok binary gate.
 */
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
    in_reply_to_user_id?: string | null;
    conversation_id?: string | null;
  },
): Promise<Result<MentionMarketResult>> {
  return processMentionWithGate(env, {
    text: input.text,
    tweet_id: input.tweet_id,
    author_id: input.author_id,
    author_username: input.author_username,
    botUsername: input.botUsername ?? env.BOT_USERNAME,
    botUserId: input.botUserId,
    liquidity: input.liquidity,
    in_reply_to_user_id: input.in_reply_to_user_id,
    conversation_id: input.conversation_id,
  });
}
