import { getMarket, lockMarket, resolveMarket, type MarketView, type Result } from "./market";
import { getSupabase, type SupabaseEnv } from "./supabase";
import { resolveMarketWithGrok, type ResolutionProposal } from "./xai";
import { xCreateTweet, type XCreds } from "./x";

export type ResolverEnv = SupabaseEnv & {
  XAI_API_KEY: string;
  X_API_KEY: string;
  X_API_SECRET: string;
  X_ACCESS_TOKEN: string;
  X_ACCESS_TOKEN_SECRET: string;
};

type ResolveSummary = {
  market_id: string;
  ok: boolean;
  outcome?: string;
  reason?: string;
  tweet_id?: string;
  announcement_error?: string;
  error?: string;
};

function getCreds(env: ResolverEnv): XCreds | null {
  if (!env.X_API_KEY || !env.X_API_SECRET || !env.X_ACCESS_TOKEN || !env.X_ACCESS_TOKEN_SECRET) {
    return null;
  }
  return {
    apiKey: env.X_API_KEY,
    apiSecret: env.X_API_SECRET,
    accessToken: env.X_ACCESS_TOKEN,
    accessTokenSecret: env.X_ACCESS_TOKEN_SECRET,
  };
}

function resolutionTweet(
  question: string,
  outcome: string,
  reason: string,
  payouts: number,
): string {
  const head = `Resolved ${outcome.toUpperCase()}: `;
  const reasonLine = reason ? `\n\n${reason}` : "";
  const tail = `\n\nPayouts: ${Math.round(payouts)} credits`;
  const budget = 280 - head.length - reasonLine.length - tail.length;
  const q = budget > 0 ? question.slice(0, budget) : "";
  return `${head}${q}${reasonLine}${tail}`;
}

export async function announceResolution(
  env: ResolverEnv,
  market: MarketView,
  outcome: string,
  reason: string,
  payouts: number,
): Promise<{ tweet_id?: string; error?: string }> {
  const creds = getCreds(env);
  if (!creds) return { error: "X API secrets not configured" };
  if (!market.source_tweet_id) return { error: "no source tweet for market" };

  const text = resolutionTweet(market.question, outcome, reason, payouts);
  const posted = await xCreateTweet(creds, text, market.source_tweet_id);
  if (!posted.ok) {
    return { error: `X API error ${posted.status}: ${String(posted.error)}` };
  }
  return { tweet_id: posted.id };
}

function missingSupabase(env: ResolverEnv): string | null {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return "Supabase secrets not configured";
  }
  return null;
}

export async function autoResolveMarket(
  env: ResolverEnv,
  marketId: string,
): Promise<
  Result<{ market: MarketView; payouts: number; proposal: ResolutionProposal; tweet_id?: string; announcement_error?: string }>
> {
  const missing = missingSupabase(env);
  if (missing) return { ok: false, error: missing };
  if (!env.XAI_API_KEY) return { ok: false, error: "XAI_API_KEY not configured" };

  const got = await getMarket(env, marketId);
  if (!got.ok) return got;

  if (got.market.status !== "open" && got.market.status !== "locked") {
    return { ok: false, error: `market is ${got.market.status}` };
  }

  const judged = await resolveMarketWithGrok(env, got.market);
  if (!judged.ok) return { ok: false, error: judged.error };

  if (got.market.status === "open") {
    const locked = await lockMarket(env, marketId);
    if (!locked.ok) return locked;
  }

  const resolved = await resolveMarket(env, marketId, judged.data.outcome);
  if (!resolved.ok) return resolved;

  const announce = await announceResolution(env, resolved.market, judged.data.outcome, judged.data.reason, resolved.payouts);

  return {
    ok: true,
    market: resolved.market,
    payouts: resolved.payouts,
    proposal: judged.data,
    tweet_id: announce.tweet_id,
    announcement_error: announce.error,
  };
}

export async function resolveDueMarkets(
  env: ResolverEnv,
): Promise<{ resolved: number; failed: number; results: ResolveSummary[] }> {
  const missing = missingSupabase(env);
  if (missing) {
    console.error("resolveDueMarkets:", missing);
    return { resolved: 0, failed: 0, results: [{ market_id: "", ok: false, error: missing }] };
  }
  if (!env.XAI_API_KEY) {
    console.error("resolveDueMarkets: XAI_API_KEY not configured");
    return { resolved: 0, failed: 0, results: [{ market_id: "", ok: false, error: "XAI_API_KEY not configured" }] };
  }

  const now = new Date().toISOString();
  const { data, error } = await getSupabase(env)
    .from("markets")
    .select("id")
    .lte("closes_at", now)
    .in("status", ["open", "closed"]);

  if (error) {
    console.error("resolveDueMarkets: failed to list due markets", error);
    return { resolved: 0, failed: 0, results: [] };
  }

  const ids: string[] = (data ?? []).map((row: { id: string }) => row.id);
  const results: ResolveSummary[] = [];
  let resolved = 0;
  let failed = 0;

  for (const marketId of ids) {
    const r = await autoResolveMarket(env, marketId);
    if (r.ok) {
      resolved++;
      results.push({
        market_id: marketId,
        ok: true,
        outcome: r.proposal.outcome,
        reason: r.proposal.reason,
        tweet_id: r.tweet_id,
        announcement_error: r.announcement_error,
      });
      console.log(`resolved ${marketId} -> ${r.proposal.outcome}: ${r.proposal.reason}`);
    } else {
      failed++;
      results.push({ market_id: marketId, ok: false, error: r.error });
      console.error(`failed to resolve ${marketId}: ${r.error}`);
    }
  }

  return { resolved, failed, results };
}
