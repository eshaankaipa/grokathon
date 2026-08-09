/**
 * Mention → market wrapper:
 * parse an @XPredMarkets mention and either create a new market
 * or redirect to an existing one (same tweet, same market id, or same question).
 *
 * Only creates when the text is a clean, resolvable yes/no question.
 * Open-ended / invalid mentions are skipped with binary suggestions the user can reply with.
 */

import {
  cleanMentionText,
  evaluateMentionIntent,
  filterBinarySuggestions,
  heuristicSuggestions,
  looksBinaryQuestion,
  looksOpenEnded,
  validateBinaryQuestion,
} from "./binary_gate";
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
import { assessMentionWithGrok } from "./xai";

type MentionEnv = SupabaseEnv & {
  DB: D1Database;
  XAI_API_KEY?: string;
  BOT_USERNAME?: string;
};

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
  /** Binary yes/no alternatives when we refuse to create */
  suggestions?: string[];
  /** Gate decision detail: reject vs clarify (both map to action=skipped) */
  gate?: "reject" | "clarify";
  /**
   * When true, do not post any X reply (casual thread noise, no intent).
   * Prevents the bot from replying under unrelated comments.
   */
  silent?: boolean;
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
  let t = cleanMentionText(text, botUsername);
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
  | {
      kind: "skip";
      reason: string;
      gate?: "reject" | "clarify";
      suggestions?: string[];
    };

export function parseMentionText(
  text: string,
  opts?: {
    botUsername?: string;
    botUserId?: string;
    authorId?: string;
    inReplyToUserId?: string | null;
    conversationId?: string | null;
    tweetId?: string | null;
  },
): ParsedMention {
  const botUsername = opts?.botUsername ?? "XPredMarkets";
  const raw = (text ?? "").trim();
  if (!raw) return { kind: "skip", reason: "empty mention" };

  // Ignore bot's own posts that self-@mention
  if (opts?.botUserId && opts?.authorId && opts.botUserId === opts.authorId) {
    return { kind: "skip", reason: "self-mention from bot" };
  }

  // Casual thread replies ("oh nice project") — silent skip, no market, no reply
  const intent = evaluateMentionIntent(raw, {
    botUsername,
    botUserId: opts?.botUserId,
    inReplyToUserId: opts?.inReplyToUserId,
    conversationId: opts?.conversationId,
    tweetId: opts?.tweetId,
  });
  if (!intent.process) {
    return {
      kind: "skip",
      reason: intent.reason,
      // mark via empty suggestions + special reason; silent handled by callers
    };
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

  const cleaned = cleanMentionText(raw, botUsername);
  if (cleaned.length < 8) {
    return {
      kind: "skip",
      reason: "no market question found (need ≥8 chars after stripping @mentions)",
    };
  }
  // Must look like a claim / question, not pure emoji noise
  if (!/[\p{L}\p{N}]/u.test(cleaned)) {
    return { kind: "skip", reason: "question has no letters/numbers" };
  }

  // Open-ended / multi-outcome → never create via rule path
  if (looksOpenEnded(cleaned) && !looksBinaryQuestion(cleaned)) {
    return {
      kind: "skip",
      gate: "clarify",
      reason:
        "Open-ended question cannot be a single yes/no market. Reply with one of the suggestions.",
      suggestions: filterBinarySuggestions(heuristicSuggestions(cleaned)),
    };
  }

  let question = extractQuestion(raw, botUsername);
  if (!question.endsWith("?") && looksBinaryQuestion(question)) {
    question = `${question.trim()}?`;
  }
  if (question) {
    question = question.charAt(0).toUpperCase() + question.slice(1);
  }

  const validation = validateBinaryQuestion(
    question.endsWith("?") ? question : `${question}?`,
  );
  if (!validation.ok) {
    // Allow create path only for already-binary text; otherwise clarify
    if (!looksBinaryQuestion(cleaned)) {
      return {
        kind: "skip",
        gate: "clarify",
        reason: validation.reason,
        suggestions: filterBinarySuggestions(heuristicSuggestions(cleaned)),
      };
    }
  }

  const finalQ = question.endsWith("?") ? question : `${question}?`;
  const finalCheck = validateBinaryQuestion(finalQ);
  if (!finalCheck.ok) {
    return {
      kind: "skip",
      gate: "clarify",
      reason: finalCheck.reason,
      suggestions: filterBinarySuggestions(heuristicSuggestions(cleaned)),
    };
  }

  return { kind: "create", question: finalQ };
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

/** Reasons that must never produce an X reply (no suggestion spam). */
export function isSilentSkipReason(reason?: string): boolean {
  if (!reason) return false;
  const r = reason.toLowerCase();
  return (
    r.includes("conversational") ||
    r.includes("without market intent") ||
    r.includes("no market intent") ||
    r === "empty mention" ||
    r === "self-mention from bot" ||
    r === "question has no letters/numbers" ||
    r.startsWith("no market question found")
  );
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
    in_reply_to_user_id?: string | null;
    conversation_id?: string | null;
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
    inReplyToUserId: input.in_reply_to_user_id,
    conversationId: input.conversation_id,
    tweetId,
  });

  if (parsed.kind === "skip") {
    const silent = isSilentSkipReason(parsed.reason);
    return {
      ok: true,
      action: "skipped",
      reason: parsed.reason,
      tweet_id: tweetId,
      author_username: input.author_username,
      suggestions: silent ? undefined : parsed.suggestions,
      gate: parsed.gate,
      silent,
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
 * Uses Grok binary gate when XAI_API_KEY is configured; otherwise deterministic rules.
 */
export async function processMentionsBatch(
  env: MentionEnv,
  mentions: XMention[],
  opts: {
    botUsername?: string;
    botUserId?: string;
    liquidity?: number;
    /** Override: force Grok path on/off. Default: on when XAI_API_KEY set. */
    useGrok?: boolean;
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

  const useGrok =
    opts.useGrok ?? Boolean(env.XAI_API_KEY && String(env.XAI_API_KEY).trim());

  for (const m of mentions) {
    const r = useGrok
      ? await processMentionWithGate(env, {
          text: m.text,
          tweet_id: m.id,
          author_id: m.author_id,
          author_username: m.author_username,
          botUsername: opts.botUsername,
          botUserId: opts.botUserId,
          liquidity: opts.liquidity,
          in_reply_to_user_id: m.in_reply_to_user_id,
          conversation_id: m.conversation_id,
        })
      : await processMentionToMarket(env, {
          text: m.text,
          tweet_id: m.id,
          author_id: m.author_id,
          author_username: m.author_username,
          botUsername: opts.botUsername,
          botUserId: opts.botUserId,
          liquidity: opts.liquidity,
          in_reply_to_user_id: m.in_reply_to_user_id,
          conversation_id: m.conversation_id,
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

/**
 * Grok-gated mention processing (preferred when XAI_API_KEY is set).
 * CREATE only for validated yes/no; otherwise skip with suggestions.
 */
export async function processMentionWithGate(
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
    in_reply_to_user_id?: string | null;
    conversation_id?: string | null;
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
      silent: true,
    };
  }

  // Early intent filter — before Grok / create (stops thread drive-by comments)
  const intent = evaluateMentionIntent(input.text, {
    botUsername,
    botUserId: input.botUserId,
    inReplyToUserId: input.in_reply_to_user_id,
    conversationId: input.conversation_id,
    tweetId,
  });
  if (!intent.process) {
    return {
      ok: true,
      action: "skipped",
      reason: intent.reason,
      tweet_id: tweetId,
      author_username: input.author_username,
      silent: true,
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

  // Redirects + trivial skips stay rule-based — no LLM needed.
  // Open-ended / clarify cases still go to Grok for better yes/no suggestions.
  const parsed = parseMentionText(input.text, {
    botUsername,
    botUserId: input.botUserId,
    authorId: input.author_id ?? undefined,
    inReplyToUserId: input.in_reply_to_user_id,
    conversationId: input.conversation_id,
    tweetId,
  });
  if (parsed.kind === "redirect") {
    const m = await getMarket(env, parsed.marketId);
    if (!m.ok) {
      return { ok: false, error: `market ${parsed.marketId} not found` };
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
  if (parsed.kind === "skip") {
    const silent = isSilentSkipReason(parsed.reason);
    // Silent / trivial skips: do not call Grok
    if (
      silent ||
      parsed.reason === "empty mention" ||
      parsed.reason === "self-mention from bot" ||
      parsed.reason === "question has no letters/numbers" ||
      parsed.reason.startsWith("no market question found")
    ) {
      return {
        ok: true,
        action: "skipped",
        reason: parsed.reason,
        tweet_id: tweetId,
        author_username: input.author_username,
        suggestions: silent ? undefined : parsed.suggestions,
        gate: parsed.gate,
        silent,
      };
    }
    // Open-ended etc. fall through to Grok for better suggestions below
  }

  const apiKey = env.XAI_API_KEY?.trim();
  if (!apiKey) {
    // Fall back to deterministic path (also rejects open-ended)
    return processMentionToMarket(env, input);
  }

  const gate = await assessMentionWithGrok(input.text, apiKey, { botUsername });
  if (!gate.ok) {
    // On Grok failure: do NOT create — skip with heuristic suggestions
    const cleaned = cleanMentionText(input.text, botUsername);
    return {
      ok: true,
      action: "skipped",
      gate: "clarify",
      reason: `Could not assess mention (${gate.error}). Try a clear yes/no question.`,
      suggestions: filterBinarySuggestions(heuristicSuggestions(cleaned)),
      tweet_id: tweetId,
      author_username: input.author_username,
    };
  }

  if (gate.decision !== "create" || !gate.market) {
    return {
      ok: true,
      action: "skipped",
      gate: gate.decision === "reject" ? "reject" : "clarify",
      reason: gate.reason,
      suggestions: gate.suggestions,
      tweet_id: tweetId,
      author_username: input.author_username,
      question: gate.market?.question,
    };
  }

  // Dedupe by question unless force_create
  if (!input.force_create) {
    const existing = await findOpenByQuestion(env, gate.market.question);
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

  const closesAt = gate.market.closes_at
    ? Math.floor(new Date(gate.market.closes_at).getTime() / 1000)
    : undefined;
  const sourceUrl = tweetId
    ? `https://x.com/i/web/status/${tweetId}`
    : undefined;

  const created = await createMarket(env, {
    question: gate.market.question,
    description: gate.market.description,
    rules: gate.market.resolution_criteria,
    category: gate.market.category,
    resolve_by: closesAt,
    source_tweet_id: tweetId,
    source_tweet_url: sourceUrl,
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
      reason: gate.reason || "new market from gated mention",
      tweet_id: tweetId,
      author_username: input.author_username,
    }),
  };
}

/** Build a reply tweet body for the bot (optional announce). */
export function formatMarketReply(result: MentionMarketResult): string | null {
  // Never reply under casual thread comments
  if (result.silent) return null;

  if (result.action === "created" && result.market_id && result.url) {
    return `Market open: ${result.question}\n\nTrade: ${result.url}`;
  }
  if (result.action === "redirected" && result.url) {
    // Don't re-announce already-processed tweets as new replies under random comments
    if (result.already_processed) return null;
    return `That market already exists — jump in:\n${result.url}`;
  }
  if (result.action === "skipped") {
    return formatSkipReply(result);
  }
  return null;
}

/** Helpful reply when we refuse to create — include yes/no suggestions. */
export function formatSkipReply(result: MentionMarketResult): string | null {
  if (result.silent) return null;
  const suggestions = (result.suggestions ?? []).filter(Boolean).slice(0, 2);
  if (suggestions.length === 0 && !result.reason) return null;

  const header =
    result.gate === "reject"
      ? "Can't open a market on that."
      : "That isn't a yes/no market yet.";

  const lines = [header];
  if (suggestions.length > 0) {
    lines.push("Try one of these and tag me again:");
    for (const s of suggestions) {
      lines.push(`• ${s}`);
    }
  } else if (result.reason) {
    lines.push(result.reason.slice(0, 160));
  }

  let text = lines.join("\n");
  // X hard limit
  if (text.length > 280) {
    text = text.slice(0, 277).trimEnd() + "…";
  }
  return text;
}
