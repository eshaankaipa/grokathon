/**
 * Hourly background sweeper: discover X trends, classify the best ones,
 * pick the top 3, and turn each into a binary prediction market.
 */

import type { D1Database } from "@cloudflare/workers-types";
import type { SupabaseEnv } from "./supabase";
import {
  marketUrls,
  formatMarketReply,
  type MentionMarketResult,
} from "./mention_market";
import { processMentionToSupabase, type MentionSupabaseEnv } from "./mention_supabase";
import { xBearerCounts, xBearerSearch, xBearerTrends, type XSearchTweet } from "./x";
import { xCreateTweet, type XCreds } from "./x";
import { attachRelatedTweets } from "./market_tweets";

type SweeperEnv = MentionSupabaseEnv & {
  DB: D1Database;
  X_BEARER_TOKEN: string;
  X_API_KEY?: string;
  X_API_SECRET?: string;
  X_ACCESS_TOKEN?: string;
  X_ACCESS_TOKEN_SECRET?: string;
  BOT_USERNAME?: string;
  BOT_NAME?: string;
};

interface TrendCandidate {
  name: string;
  query: string;
  postCount: number;
  posts: XSearchTweet[];
  decision: "CREATE" | "WAIT" | "REJECT";
  canonicalEvent: string;
  binaryQuestion: string;
  score: number;
  reason: string;
}

function getCreds(env: SweeperEnv): XCreds | null {
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

function extractJson(text: string): string {
  const t = text.trim();
  if (t.startsWith("{")) {
    try {
      JSON.parse(t);
      return t;
    } catch { /* fall through */ }
  }
  const start = t.indexOf("{");
  if (start === -1) return t;
  for (let i = start + 1; i < t.length; i++) {
    if (t[i] === "}") {
      const candidate = t.slice(start, i + 1);
      try {
        JSON.parse(candidate);
        return candidate;
      } catch { /* continue */ }
    }
  }
  return t;
}

export async function runSweeper(
  env: SweeperEnv,
  opts: {
    woeid?: number;
    maxTopics?: number;
    minVolume?: number;
    maxPosts?: number;
    maxCreate?: number;
    minScore?: number;
  } = {},
): Promise<{
  ok: boolean;
  created: number;
  failed: number;
  skipped: number;
  results: { name: string; decision: string; score: number; marketId?: string; error?: string }[];
}> {
  const bearer = env.X_BEARER_TOKEN;
  const apiKey = env.XAI_API_KEY;
  if (!bearer) {
    return { ok: false, created: 0, failed: 0, skipped: 0, results: [{ name: "config", decision: "REJECT", score: 0, error: "X_BEARER_TOKEN not configured" }] };
  }
  if (!apiKey) {
    return { ok: false, created: 0, failed: 0, skipped: 0, results: [{ name: "config", decision: "REJECT", score: 0, error: "XAI_API_KEY not configured" }] };
  }

  const woeid = opts.woeid ?? (env.X_TRENDS_WOEID ? Number(env.X_TRENDS_WOEID) : 1) ?? 1;
  const maxTopics = opts.maxTopics ?? 10;
  const minVolume = opts.minVolume ?? 50;
  const maxPosts = opts.maxPosts ?? 15;
  const maxCreate = opts.maxCreate ?? (env.SWEEPER_MAX_CREATE ? Number(env.SWEEPER_MAX_CREATE) : 3) ?? 3;
  const minScore = opts.minScore ?? 0.45;

  console.log(`sweeper: fetching trends (woeid=${woeid})`);
  const trendsRes = await xBearerTrends(bearer, woeid);
  if (!trendsRes.ok) {
    return {
      ok: false,
      created: 0,
      failed: 0,
      skipped: 0,
      results: [{ name: "trends", decision: "REJECT", score: 0, error: `X trends error ${trendsRes.status}: ${JSON.stringify(trendsRes.error)}` }],
    };
  }

  const trends = trendsRes.trends.slice(0, maxTopics);
  console.log(`sweeper: ${trends.length} trends to evaluate`);

  const candidates: TrendCandidate[] = [];
  for (const t of trends) {
    const name = t.trend_name;
    const query = name; // simple keyword query

    const counts = await xBearerCounts(bearer, query);
    if (!counts.ok) {
      console.log(`sweeper: counts failed for "${name}": ${counts.status}`);
      continue;
    }
    if (counts.total < minVolume) {
      console.log(`sweeper: "${name}" volume ${counts.total} < ${minVolume}`);
      continue;
    }

    const search = await xBearerSearch(bearer, query, maxPosts);
    if (!search.ok) {
      console.log(`sweeper: search failed for "${name}": ${search.status}`);
      continue;
    }

    const classification = await classifyTrend(apiKey, name, search.tweets);
    console.log(`sweeper: "${name}" -> ${classification.decision} (score ${classification.score.toFixed(2)}) ${classification.reason}`);

    if (classification.decision === "CREATE" && classification.score >= minScore) {
      candidates.push({
        name,
        query,
        postCount: counts.total,
        posts: search.tweets,
        ...classification,
      });
    }
  }

  // Pick the top N by score.
  candidates.sort((a, b) => b.score - a.score);
  const top = candidates.slice(0, maxCreate);
  console.log(`sweeper: ${candidates.length} CREATE candidates, creating top ${top.length}`);

  const results: { name: string; decision: string; score: number; marketId?: string; error?: string }[] = [];
  const creds = getCreds(env);
  const botUsername = env.BOT_USERNAME ?? "XPredMarkets";
  let created = 0;
  let failed = 0;
  let skipped = 0;

  for (const c of top) {
    const mentionRes = await processMentionToSupabase(env, {
      text: c.binaryQuestion || c.canonicalEvent,
      author_username: "sweeper",
    });

    if (!mentionRes.ok) {
      failed++;
      results.push({ name: c.name, decision: c.decision, score: c.score, error: mentionRes.error });
      continue;
    }

    const mention: MentionMarketResult = mentionRes;

    if (mention.action === "created" && mention.market_id) {
      created++;
      results.push({ name: c.name, decision: c.decision, score: c.score, marketId: mention.market_id });
      // Tag the most relevant conversation posts under the new market
      if (mention.market) {
        const tagged = await attachRelatedTweets(env, mention.market);
        if (!tagged.ok) {
          console.log(
            `sweeper: related tweets failed for ${mention.market_id}: ${tagged.error}`,
          );
        }
      }

      if (creds && mention.url) {
        const tweet = formatMarketReply(mention);
        if (tweet) {
          const posted = await xCreateTweet(creds, tweet);
          if (!posted.ok) {
            console.log(`sweeper: tweet failed for ${mention.market_id}: ${JSON.stringify(posted.error)}`);
          } else {
            const tweetUrl = `https://x.com/${botUsername}/status/${posted.id}`;
            console.log(`sweeper: tweeted ${tweetUrl}`);
          }
        }
      }
    } else if (mention.action === "redirected") {
      skipped++;
      results.push({ name: c.name, decision: c.decision, score: c.score, marketId: mention.market_id, error: "duplicate / redirected" });
    } else {
      failed++;
      results.push({ name: c.name, decision: c.decision, score: c.score, error: mention.reason || "market creation skipped" });
    }
  }

  for (const c of candidates) {
    if (!top.some((t) => t.name === c.name)) {
      results.push({ name: c.name, decision: c.decision, score: c.score });
    }
  }

  // Persist a sweep summary in D1 events.
  await persistSweepSummary(env, { created, failed, skipped, woeid, minVolume, maxCreate });

  console.log(`sweeper: done. created=${created} failed=${failed} skipped=${skipped}`);
  return { ok: true, created, failed, skipped, results };
}

async function persistSweepSummary(
  env: SweeperEnv,
  summary: { created: number; failed: number; skipped: number; woeid: number; minVolume: number; maxCreate: number },
): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO events (event_type, detail, created_at) VALUES (?, ?, ?)`
    )
      .bind(
        "sweeper",
        JSON.stringify(summary),
        Math.floor(Date.now() / 1000),
      )
      .run();
  } catch (e) {
    console.log(`sweeper: failed to persist summary: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function classifyTrend(
  apiKey: string,
  trendName: string,
  tweets: XSearchTweet[],
): Promise<Omit<TrendCandidate, "name" | "query" | "postCount" | "posts">> {
  const samples = tweets
    .slice(0, 10)
    .map((t) => `- ${t.text}`)
    .join("\n");

  const prompt = `You are a prediction-market triage assistant. Given an X trend and representative posts, decide if it describes a single, specific, publicly resolvable future event that can be traded as a binary YES/NO market.

Trend: ${trendName}
Representative posts:
${samples || "- (none)"}

Return ONLY a compact JSON object with these exact keys:
- decision: "CREATE" | "WAIT" | "REJECT"
- canonical_event: a neutral, specific phrase naming the event (e.g. "Golden State Warriors vs Los Angeles Lakers, August 8 2026"). NOT a question.
- binary_question: a clear YES/NO question that starts with "Will" and ends with "?", under 280 chars. Only fill this in for CREATE.
- score: 0.0-1.0 confidence that this should become a market.
- reason: one sentence.

CREATE only when the event has a verifiable YES/NO outcome and a knowable resolution date. WAIT when the story is still developing. REJECT when it is subjective, already resolved, or not a real public event.`;

  try {
    const res = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "grok-latest",
        messages: [
          {
            role: "system",
            content: `Current UTC time: ${new Date().toISOString()}. Always respond with the requested JSON only.`,
          },
          { role: "user", content: prompt },
        ],
        response_format: { type: "json_object" },
        temperature: 0.2,
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { decision: "REJECT", canonicalEvent: "", binaryQuestion: "", score: 0, reason: `xAI error ${res.status}: ${text.slice(0, 200)}` };
    }

    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const raw = json.choices?.[0]?.message?.content?.trim() ?? "";
    if (!raw) {
      return { decision: "REJECT", canonicalEvent: "", binaryQuestion: "", score: 0, reason: "xAI returned empty" };
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(extractJson(raw)) as Record<string, unknown>;
    } catch (e) {
      return { decision: "REJECT", canonicalEvent: "", binaryQuestion: "", score: 0, reason: `invalid JSON: ${e instanceof Error ? e.message : String(e)}` };
    }

    const decision = String(parsed.decision ?? "").toUpperCase();
    const canonicalEvent = String(parsed.canonical_event ?? "").trim();
    const score = Number(parsed.score ?? 0);
    const reason = String(parsed.reason ?? "").trim();

    if (decision !== "CREATE" && decision !== "WAIT" && decision !== "REJECT") {
      return { decision: "REJECT", canonicalEvent: "", binaryQuestion: "", score: 0, reason: `invalid decision: ${decision}` };
    }

    const binaryQuestion = String(parsed.binary_question ?? "").trim();

    return {
      decision,
      canonicalEvent,
      binaryQuestion,
      score: Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : 0,
      reason,
    };
  } catch (e) {
    return { decision: "REJECT", canonicalEvent: "", binaryQuestion: "", score: 0, reason: `classify error: ${e instanceof Error ? e.message : String(e)}` };
  }
}
