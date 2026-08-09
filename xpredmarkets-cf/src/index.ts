import { landingPage } from "./html";
import {
  buy,
  createMarket,
  createUser,
  creditUser,
  getMarket,
  getPositions,
  getUserByApiKey,
  listMarkets,
  listTrades,
  lockMarket,
  quote,
  resolveMarket,
  sell,
  userToPublic,
  type QuoteAction,
  type QuoteSide,
  type Trade,
  type User,
} from "./market";
import {
  formatMarketReply,
  processMentionToMarket,
  processMentionWithGate,
  processMentionsBatch,
} from "./mention_market";
import { processMentionToSupabase } from "./mention_supabase";
import { marketOgResponse } from "./og";
import {
  xCreateTweet,
  xGetMe,
  xGetMentions,
  type XCreds,
  type XMention,
} from "./x";
import { resolveMarketWithGrok } from "./xai";
import { announceResolution, autoResolveMarket, resolveDueMarkets } from "./resolver";
import { autoCreateModernMarket } from "./modern_markets";

export interface Env {
  DB: D1Database;
  BOT_USERNAME: string;
  BOT_NAME: string;
  X_API_KEY: string;
  X_API_SECRET: string;
  X_ACCESS_TOKEN: string;
  X_ACCESS_TOKEN_SECRET: string;
  ADMIN_TOKEN: string;
  XAI_API_KEY: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
}

async function getMarketAny(
  env: Env,
  marketId: string,
): Promise<ReturnType<typeof getMarket>> {
  return getMarket(env, marketId);
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

/** Map market Result to HTTP response (400/401/404 on error). */
function resultJson(
  r: { ok: true } | { ok: false; error: string },
  statusOk = 200,
): Response {
  if (r.ok) return json(r, statusOk);
  const err = String(r.error).toLowerCase();
  let status = 400;
  if (
    err.includes("unauthorized") ||
    err.includes("api key") ||
    err.includes("invalid key")
  ) {
    status = 401;
  } else if (err.includes("not found")) {
    status = 404;
  }
  return json({ ok: false, error: r.error }, status);
}

function getCreds(env: Env): XCreds | null {
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

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.byteLength !== bb.byteLength) {
    // still do a compare to reduce trivial timing leaks on length
    let dummy = 0;
    for (let i = 0; i < ab.byteLength; i++) dummy |= ab[i];
    return false;
  }
  let out = 0;
  for (let i = 0; i < ab.byteLength; i++) out |= ab[i] ^ bb[i];
  return out === 0;
}

function requireAdmin(request: Request, env: Env): Response | null {
  if (!env.ADMIN_TOKEN) {
    return json({ error: "ADMIN_TOKEN not configured" }, 500);
  }
  const auth = request.headers.get("Authorization") || "";
  const headerToken = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const urlToken = new URL(request.url).searchParams.get("token") || "";
  const token = headerToken || urlToken;
  if (!token || !timingSafeEqual(token, env.ADMIN_TOKEN)) {
    return json({ error: "unauthorized" }, 401);
  }
  return null;
}

/** Extract raw user API key from Authorization: Bearer or X-Api-Key. */
function extractUserApiKey(request: Request): string | null {
  const xKey = request.headers.get("X-Api-Key")?.trim();
  if (xKey) return xKey;

  const auth = request.headers.get("Authorization") || "";
  if (auth.startsWith("Bearer ")) {
    const token = auth.slice(7).trim();
    if (token) return token;
  }
  return null;
}

/**
 * Require a user API key. Rejects admin token on user routes.
 * Returns either a Response (error) or the authenticated User.
 */
async function requireUser(
  request: Request,
  env: Env,
): Promise<User | Response> {
  const rawKey = extractUserApiKey(request);
  if (!rawKey) {
    return json(
      { ok: false, error: "missing api key (Authorization: Bearer or X-Api-Key)" },
      401,
    );
  }

  // Admin token must not be used on user routes
  if (env.ADMIN_TOKEN && timingSafeEqual(rawKey, env.ADMIN_TOKEN)) {
    return json(
      {
        ok: false,
        error: "admin token cannot be used on user routes; use a user api key",
      },
      401,
    );
  }

  const user = await getUserByApiKey(env, rawKey);
  if (!user) {
    return json({ ok: false, error: "invalid api key" }, 401);
  }
  return user;
}

function isUser(v: User | Response): v is User {
  return !(v instanceof Response);
}

async function readJsonBody<T>(
  request: Request,
): Promise<{ ok: true; body: T } | { ok: false; response: Response }> {
  try {
    const body = (await request.json()) as T;
    return { ok: true, body };
  } catch {
    return {
      ok: false,
      response: json({ ok: false, error: "invalid JSON body" }, 400),
    };
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, "") || "/";
    const segments = path.split("/").filter(Boolean);
    const method = request.method;

    // -------------------------------------------------------------------------
    // Health / X bot routes (unchanged)
    // -------------------------------------------------------------------------

    if (path === "/health") {
      return json({ ok: true, service: "xpredmarkets-cf" });
    }

    if (path === "/whoami" || path === "/status") {
      const creds = getCreds(env);
      if (!creds) {
        return json(
          { ok: false, error: "X API secrets not configured" },
          500,
        );
      }
      const me = await xGetMe(creds);
      if (!me.ok) {
        return json(me, me.status);
      }
      const count = await env.DB.prepare(
        `SELECT COUNT(*) as n FROM posts`,
      ).first<{ n: number }>();
      return json({
        ok: true,
        service: "xpredmarkets-cf",
        user: me.user,
        posts_logged: count?.n ?? 0,
      });
    }

    if (path === "/posts" && method === "GET") {
      const limit = Math.min(
        parseInt(url.searchParams.get("limit") ?? "20", 10) || 20,
        100,
      );
      const rows = await env.DB.prepare(
        `SELECT tweet_id, text, reply_to, url, created_at FROM posts ORDER BY id DESC LIMIT ?`,
      )
        .bind(limit)
        .all();
      return json({ ok: true, posts: rows.results ?? [] });
    }

    // Live mentions from X API (admin) — optional ?persist=1 to upsert into D1
    if (path === "/mentions" && method === "GET") {
      const denied = requireAdmin(request, env);
      if (denied) return denied;

      const creds = getCreds(env);
      if (!creds) {
        return json({ ok: false, error: "X API secrets not configured" }, 500);
      }

      const me = await xGetMe(creds);
      if (!me.ok) {
        return json({ ok: false, error: me.error }, me.status);
      }

      const limit = Math.min(
        parseInt(url.searchParams.get("limit") ?? "10", 10) || 10,
        100,
      );
      const sinceId = url.searchParams.get("since_id") || undefined;
      const paginationToken =
        url.searchParams.get("pagination_token") || undefined;
      const persist =
        url.searchParams.get("persist") === "1" ||
        url.searchParams.get("persist") === "true";

      const result = await xGetMentions(creds, me.user.id, {
        maxResults: limit,
        sinceId,
        paginationToken,
      });
      if (!result.ok) {
        return json({ ok: false, error: result.error }, result.status);
      }

      let persisted = 0;
      if (persist && result.mentions.length) {
        persisted = await persistMentions(env, result.mentions);
      }

      return json({
        ok: true,
        user: { id: me.user.id, username: me.user.username },
        count: result.mentions.length,
        mentions: result.mentions,
        meta: result.meta,
        persisted: persist ? persisted : undefined,
      });
    }

    // Mentions already stored in D1 (public read of cache)
    if (path === "/mentions/cached" && method === "GET") {
      const limit = Math.min(
        parseInt(url.searchParams.get("limit") ?? "50", 10) || 50,
        200,
      );
      const sinceId = url.searchParams.get("since_id");
      const rows = sinceId
        ? await env.DB.prepare(
            `SELECT tweet_id, text, author_id, author_username, author_name,
                    conversation_id, url, tweet_created_at, first_seen_at, last_seen_at
             FROM mentions
             WHERE CAST(tweet_id AS INTEGER) > CAST(? AS INTEGER)
             ORDER BY tweet_id DESC LIMIT ?`,
          )
            .bind(sinceId, limit)
            .all()
        : await env.DB.prepare(
            `SELECT tweet_id, text, author_id, author_username, author_name,
                    conversation_id, url, tweet_created_at, first_seen_at, last_seen_at
             FROM mentions
             ORDER BY first_seen_at DESC LIMIT ?`,
          )
            .bind(limit)
            .all();
      return json({
        ok: true,
        count: rows.results?.length ?? 0,
        mentions: rows.results ?? [],
      });
    }

    // ------------------------------------------------------------------
    // Mention → market wrapper
    // ------------------------------------------------------------------

    /**
     * POST /markets/from-mention
     * Body: { text, tweet_id?, author_id?, author_username?, liquidity?, force_create?, announce? }
     * Creates a market from mention text, or redirects to an existing match.
     * announce=true → reply on X with market URL (needs tweet_id).
     */
    if (path === "/markets/from-mention" && method === "POST") {
      const denied = requireAdmin(request, env);
      if (denied) return denied;

      const parsed = await readJsonBody<{
        text?: string;
        tweet_id?: string;
        author_id?: string;
        author_username?: string;
        liquidity?: number;
        force_create?: boolean;
        announce?: boolean;
        in_reply_to_user_id?: string;
        conversation_id?: string;
      }>(request);
      if (!parsed.ok) return parsed.response;
      const b = parsed.body;
      if (!b.text?.trim()) {
        return json({ ok: false, error: "text required" }, 400);
      }

      const botUsername = env.BOT_USERNAME || "XPredMarkets";
      let botUserId: string | undefined;
      const creds = getCreds(env);
      if (creds) {
        const me = await xGetMe(creds);
        if (me.ok) botUserId = me.user.id;
      }

      // Prefer Grok binary gate whenever XAI is configured; never force-create open-ended.
      const useGrok = Boolean(env.XAI_API_KEY && String(env.XAI_API_KEY).trim());
      const replyMeta = {
        in_reply_to_user_id: b.in_reply_to_user_id,
        conversation_id: b.conversation_id,
      };

      const result = useGrok
        ? env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY
          ? await processMentionToSupabase(env as Env & { XAI_API_KEY: string }, {
              text: b.text,
              tweet_id: b.tweet_id,
              author_id: b.author_id,
              author_username: b.author_username,
              botUsername,
              botUserId,
              liquidity: b.liquidity,
              ...replyMeta,
            })
          : await processMentionWithGate(env, {
              text: b.text,
              tweet_id: b.tweet_id,
              author_id: b.author_id,
              author_username: b.author_username,
              botUsername,
              botUserId,
              liquidity: b.liquidity,
              force_create: b.force_create,
              ...replyMeta,
            })
        : await processMentionToMarket(env, {
            text: b.text,
            tweet_id: b.tweet_id,
            author_id: b.author_id,
            author_username: b.author_username,
            botUsername,
            botUserId,
            liquidity: b.liquidity,
            force_create: b.force_create,
            ...replyMeta,
          });
      if (!result.ok) return resultJson(result);

      const { ok: _ok, ...payload } = result;
      void _ok;

      let announcement: unknown;
      // Announce creates / redirects / clarify suggestions — never silent skips
      if (b.announce && creds && !payload.silent) {
        const reply = formatMarketReply(payload);
        if (reply && b.tweet_id) {
          const posted = await xCreateTweet(creds, reply, b.tweet_id);
          announcement = posted.ok
            ? {
                ok: true,
                id: posted.id,
                url: `https://x.com/${botUsername}/status/${posted.id}`,
                text: reply,
              }
            : { ok: false, error: posted.error };
        } else if (reply && !b.tweet_id) {
          announcement = {
            ok: false,
            error: "announce requires tweet_id to reply",
            text: reply,
          };
        }
      }

      return json({ ok: true, ...payload, announcement });
    }

    /**
     * POST /mentions/process
     * Pull live mentions from X, then for each run the create-or-redirect wrapper.
     * Query/body: limit, since_id, persist, announce, liquidity
     */
    if (path === "/mentions/process" && method === "POST") {
      const denied = requireAdmin(request, env);
      if (denied) return denied;

      const creds = getCreds(env);
      if (!creds) {
        return json({ ok: false, error: "X API secrets not configured" }, 500);
      }

      let body: {
        limit?: number;
        since_id?: string;
        pagination_token?: string;
        persist?: boolean;
        announce?: boolean;
        liquidity?: number;
      } = {};
      try {
        if ((request.headers.get("content-type") || "").includes("json")) {
          body = (await request.json()) as typeof body;
        }
      } catch {
        /* empty body ok */
      }

      const limit = Math.min(
        body.limit ??
          parseInt(url.searchParams.get("limit") ?? "10", 10) ??
          10,
        100,
      );
      const sinceId =
        body.since_id || url.searchParams.get("since_id") || undefined;
      const paginationToken =
        body.pagination_token ||
        url.searchParams.get("pagination_token") ||
        undefined;
      const persist =
        body.persist === true ||
        url.searchParams.get("persist") === "1" ||
        url.searchParams.get("persist") === "true";
      const announce =
        body.announce === true ||
        url.searchParams.get("announce") === "1" ||
        url.searchParams.get("announce") === "true";

      const me = await xGetMe(creds);
      if (!me.ok) {
        return json({ ok: false, error: me.error }, me.status);
      }

      const live = await xGetMentions(creds, me.user.id, {
        maxResults: Math.max(limit, 5),
        sinceId,
        paginationToken,
      });
      if (!live.ok) {
        return json({ ok: false, error: live.error }, live.status);
      }

      if (persist && live.mentions.length) {
        await persistMentions(env, live.mentions);
      }

      const batch = await processMentionsBatch(env, live.mentions, {
        botUsername: env.BOT_USERNAME || me.user.username,
        botUserId: me.user.id,
        liquidity: body.liquidity,
      });

      const announcements: unknown[] = [];
      if (announce) {
        for (const r of batch.results) {
          if (!r.tweet_id) continue;
          // Don't re-announce already-processed tweets or silent skips
          if (r.already_processed || r.silent) continue;
          const text = formatMarketReply(r);
          if (!text) continue;
          const posted = await xCreateTweet(creds, text, r.tweet_id);
          announcements.push({
            tweet_id: r.tweet_id,
            market_id: r.market_id,
            action: r.action,
            gate: r.gate,
            text,
            post: posted.ok
              ? {
                  ok: true,
                  id: posted.id,
                  url: `https://x.com/${me.user.username}/status/${posted.id}`,
                }
              : { ok: false, error: posted.error },
          });
        }
      }

      return json({
        ok: true,
        fetched: live.mentions.length,
        created: batch.created,
        redirected: batch.redirected,
        skipped: batch.skipped,
        results: batch.results,
        meta: live.meta,
        announcements: announce ? announcements : undefined,
      });
    }

    // GET /mentions/markets — history of mention→market links
    if (path === "/mentions/markets" && method === "GET") {
      const denied = requireAdmin(request, env);
      if (denied) return denied;
      const limit = Math.min(
        parseInt(url.searchParams.get("limit") ?? "50", 10) || 50,
        200,
      );
      const rows = await env.DB.prepare(
        `SELECT tweet_id, market_id, action, question, author_username, processed_at
         FROM mention_markets
         ORDER BY processed_at DESC
         LIMIT ?`,
      )
        .bind(limit)
        .all();
      return json({ ok: true, links: rows.results ?? [] });
    }

    if (path === "/post" && method === "POST") {
      const denied = requireAdmin(request, env);
      if (denied) return denied;

      const creds = getCreds(env);
      if (!creds) {
        return json({ ok: false, error: "X API secrets not configured" }, 500);
      }

      let body: { text?: string; reply_to?: string };
      try {
        body = (await request.json()) as { text?: string; reply_to?: string };
      } catch {
        return json({ ok: false, error: "invalid JSON body" }, 400);
      }

      const text = (body.text ?? "").trim();
      if (!text) return json({ ok: false, error: "text required" }, 400);
      if (text.length > 280) {
        return json({ ok: false, error: "text exceeds 280 characters" }, 400);
      }

      const result = await xCreateTweet(creds, text, body.reply_to);
      if (!result.ok) {
        await env.DB.prepare(
          `INSERT INTO events (event_type, detail, created_at) VALUES (?, ?, ?)`,
        )
          .bind("post_error", JSON.stringify(result.error), Math.floor(Date.now() / 1000))
          .run();
        return json({ ok: false, error: result.error }, result.status);
      }

      const username = env.BOT_USERNAME || "XPredMarkets";
      const postUrl = `https://x.com/${username}/status/${result.id}`;
      const now = Math.floor(Date.now() / 1000);
      await env.DB.prepare(
        `INSERT INTO posts (tweet_id, text, reply_to, url, created_at, raw_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          result.id,
          result.text,
          body.reply_to ?? null,
          postUrl,
          now,
          JSON.stringify(result),
        )
        .run();

      await env.DB.prepare(
        `INSERT INTO events (event_type, detail, created_at) VALUES (?, ?, ?)`,
      )
        .bind("post", result.id, now)
        .run();

      return json({
        ok: true,
        id: result.id,
        text: result.text,
        url: postUrl,
      });
    }

    // -------------------------------------------------------------------------
    // Prediction markets — public
    // -------------------------------------------------------------------------

    // GET /markets
    if (segments[0] === "markets" && segments.length === 1 && method === "GET") {
      const status = url.searchParams.get("status") || undefined;
      const limitRaw = url.searchParams.get("limit");
      const limit = limitRaw
        ? parseInt(limitRaw, 10)
        : undefined;
      return resultJson(
        await listMarkets(env, {
          status,
          limit: Number.isFinite(limit as number) ? limit : undefined,
        }),
      );
    }

    // GET /markets/:id/trades
    if (
      segments[0] === "markets" &&
      segments.length === 3 &&
      segments[2] === "trades" &&
      method === "GET"
    ) {
      const marketId = segments[1];
      const limitRaw = url.searchParams.get("limit");
      const limit = limitRaw ? parseInt(limitRaw, 10) : 20;
      return resultJson(await listTrades(env, marketId, limit));
    }

    // GET /markets/:id/og | /og.png | /og.svg — dynamic OG image
    if (
      segments[0] === "markets" &&
      segments.length === 3 &&
      (segments[2] === "og" ||
        segments[2] === "og.png" ||
        segments[2] === "og.svg") &&
      method === "GET"
    ) {
      const marketId = segments[1];
      const m = await getMarket(env, marketId);
      if (!m.ok) return resultJson(m);
      const format = segments[2] === "og.svg" ? "svg" : "png";
      try {
        return await marketOgResponse(m.market, format);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return json({ ok: false, error: `og render failed: ${message}` }, 500);
      }
    }

    // GET /markets/:id
    if (
      segments[0] === "markets" &&
      segments.length === 2 &&
      method === "GET"
    ) {
      const marketId = segments[1];
      const m = await getMarket(env, marketId);
      if (!m.ok) return resultJson(m);
      const trades = await listTrades(env, marketId, 20);
      return json({
        ok: true,
        market: m.market,
        trades: trades.ok ? trades.trades : [],
        og_image: `https://xpred.aidenhuang.com/markets/${marketId}/og.png`,
      });
    }

    // -------------------------------------------------------------------------
    // Prediction markets — user
    // -------------------------------------------------------------------------

    // POST /users  (public registration — no auth)
    if (segments[0] === "users" && segments.length === 1 && method === "POST") {
      const parsed = await readJsonBody<{ display_name?: string }>(request);
      if (!parsed.ok) return parsed.response;
      return resultJson(
        await createUser(env, parsed.body.display_name ?? ""),
      );
    }

    // GET /me
    if (path === "/me" && method === "GET") {
      const auth = await requireUser(request, env);
      if (!isUser(auth)) return auth;
      return json({ ok: true, user: userToPublic(auth) });
    }

    // GET /me/positions
    if (path === "/me/positions" && method === "GET") {
      const auth = await requireUser(request, env);
      if (!isUser(auth)) return auth;
      return resultJson(await getPositions(env, auth.id));
    }

    // POST /markets/:id/quote
    if (
      segments[0] === "markets" &&
      segments.length === 3 &&
      segments[2] === "quote" &&
      method === "POST"
    ) {
      const auth = await requireUser(request, env);
      if (!isUser(auth)) return auth;
      const marketId = segments[1];
      const parsed = await readJsonBody<{
        side?: string;
        action?: string;
        amount?: number;
        shares?: number;
      }>(request);
      if (!parsed.ok) return parsed.response;
      const { side, action, amount, shares } = parsed.body;
      return resultJson(
        await quote(env, marketId, {
          side: side as QuoteSide,
          action: action as QuoteAction,
          amount,
          shares,
        }),
      );
    }

    // POST /markets/:id/buy
    if (
      segments[0] === "markets" &&
      segments.length === 3 &&
      segments[2] === "buy" &&
      method === "POST"
    ) {
      const auth = await requireUser(request, env);
      if (!isUser(auth)) return auth;
      const marketId = segments[1];
      const parsed = await readJsonBody<{ side?: string; amount?: number }>(
        request,
      );
      if (!parsed.ok) return parsed.response;
      return resultJson(
        await buy(
          env,
          auth.id,
          marketId,
          parsed.body.side as QuoteSide,
          Number(parsed.body.amount),
        ),
      );
    }

    // POST /markets/:id/sell
    if (
      segments[0] === "markets" &&
      segments.length === 3 &&
      segments[2] === "sell" &&
      method === "POST"
    ) {
      const auth = await requireUser(request, env);
      if (!isUser(auth)) return auth;
      const marketId = segments[1];
      const parsed = await readJsonBody<{ side?: string; shares?: number }>(
        request,
      );
      if (!parsed.ok) return parsed.response;
      return resultJson(
        await sell(
          env,
          auth.id,
          marketId,
          parsed.body.side as QuoteSide,
          Number(parsed.body.shares),
        ),
      );
    }

    // -------------------------------------------------------------------------
    // Prediction markets — admin
    // -------------------------------------------------------------------------

    // POST /markets
    if (segments[0] === "markets" && segments.length === 1 && method === "POST") {
      const denied = requireAdmin(request, env);
      if (denied) return denied;
      const parsed = await readJsonBody<{
        question?: string;
        description?: string;
        rules?: string;
        liquidity?: number;
        resolve_by?: number;
      }>(request);
      if (!parsed.ok) return parsed.response;
      const b = parsed.body;
      return resultJson(
        await createMarket(env, {
          question: b.question ?? "",
          description: b.description,
          rules: b.rules,
          liquidity: b.liquidity,
          resolve_by: b.resolve_by,
          created_by: "admin",
        }),
      );
    }

    // POST /markets/:id/lock
    if (
      segments[0] === "markets" &&
      segments.length === 3 &&
      segments[2] === "lock" &&
      method === "POST"
    ) {
      const denied = requireAdmin(request, env);
      if (denied) return denied;
      return resultJson(await lockMarket(env, segments[1]));
    }

    // POST /markets/:id/resolve
    if (
      segments[0] === "markets" &&
      segments.length === 3 &&
      segments[2] === "resolve" &&
      method === "POST"
    ) {
      const denied = requireAdmin(request, env);
      if (denied) return denied;
      const marketId = segments[1];
      const parsed = await readJsonBody<{ outcome?: string }>(request);
      if (!parsed.ok) return parsed.response;
      const outcome = parsed.body.outcome;
      if (outcome !== "yes" && outcome !== "no" && outcome !== "void") {
        return json(
          { ok: false, error: "outcome must be yes, no, or void" },
          400,
        );
      }
      const resolved = await resolveMarket(env, marketId, outcome);
      if (!resolved.ok) return resultJson(resolved);
      const announce = await announceResolution(env, resolved.market, outcome, "", resolved.payouts);
      return json({
        ok: true,
        market: resolved.market,
        payouts: resolved.payouts,
        tweet_id: announce.tweet_id,
        announcement_error: announce.error,
      });
    }

    // POST /markets/:id/judge — propose an outcome using Grok + web search
    if (
      segments[0] === "markets" &&
      segments.length === 3 &&
      segments[2] === "judge" &&
      method === "POST"
    ) {
      const denied = requireAdmin(request, env);
      if (denied) return denied;
      const marketId = segments[1];
      const got = await getMarket(env, marketId);
      if (!got.ok) return resultJson(got);
      const judged = await resolveMarketWithGrok(env, got.market);
      if (!judged.ok) return json({ ok: false, error: judged.error }, 400);
      return json({
        ok: true,
        market: got.market,
        proposal: judged.data,
      });
    }

    // POST /markets/:id/auto-resolve — lock + resolve using Grok + web search
    if (
      segments[0] === "markets" &&
      segments.length === 3 &&
      segments[2] === "auto-resolve" &&
      method === "POST"
    ) {
      const denied = requireAdmin(request, env);
      if (denied) return denied;
      const marketId = segments[1];
      return resultJson(await autoResolveMarket(env, marketId));
    }

    // POST /markets/resolve-due — run the auto resolver over all due markets
    if (
      segments[0] === "markets" &&
      segments.length === 2 &&
      segments[1] === "resolve-due" &&
      method === "POST"
    ) {
      const denied = requireAdmin(request, env);
      if (denied) return denied;
      return json({ ok: true, ...(await resolveDueMarkets(env)) });
    }

    // POST /users/:id/credit
    if (
      segments[0] === "users" &&
      segments.length === 3 &&
      segments[2] === "credit" &&
      method === "POST"
    ) {
      const denied = requireAdmin(request, env);
      if (denied) return denied;
      const userId = segments[1];
      const parsed = await readJsonBody<{ amount?: number }>(request);
      if (!parsed.ok) return parsed.response;
      return resultJson(
        await creditUser(env, userId, Number(parsed.body.amount)),
      );
    }

    // -------------------------------------------------------------------------
    // Dashboard / root
    // -------------------------------------------------------------------------

    if (path === "/" && method === "GET") {
      const accept = request.headers.get("Accept") || "";
      if (accept.includes("application/json") && !accept.includes("text/html")) {
        return json({
          ok: true,
          service: "xpredmarkets-cf",
          routes: [
            "GET  /                      — dashboard",
            "GET  /health                — liveness",
            "GET  /status                — bot identity",
            "GET  /whoami                — same as status",
            "GET  /posts                 — logged posts",
            "POST /post                  — create post (admin token)",
            "GET  /mentions              — live mentions from X (admin token)",
            "GET  /mentions/cached       — mentions stored in D1",
            "POST /mentions/process      — fetch mentions → create/redirect markets (admin)",
            "GET  /mentions/markets      — mention→market link history (admin)",
            "POST /markets/from-mention  — single mention → create or redirect (admin)",
            "GET  /markets               — list markets",
            "GET  /markets/:id           — market detail + recent trades",
            "GET  /markets/:id/og        — OG image PNG 1200×630",
            "GET  /markets/:id/og.png    — same as /og",
            "GET  /markets/:id/og.svg    — SVG source (debug)",
            "GET  /markets/:id/trades    — trade history",
            "POST /users                 — register (display_name)",
            "GET  /me                    — current user (api key)",
            "GET  /me/positions          — user positions (api key)",
            "POST /markets/:id/quote     — price quote (api key)",
            "POST /markets/:id/buy       — buy shares (api key)",
            "POST /markets/:id/sell      — sell shares (api key)",
            "POST /markets               — create market (admin)",
            "POST /markets/:id/lock      — lock market (admin)",
            "POST /markets/:id/resolve   — resolve market (admin)",
            "POST /markets/:id/judge     — propose outcome with Grok web search (admin)",
            "POST /markets/:id/auto-resolve — lock + resolve with Grok web search (admin)",
            "POST /markets/resolve-due   — resolve all past-due markets (admin)",
            "POST /users/:id/credit      — credit user (admin)",
          ],
        });
      }

      const creds = getCreds(env);
      let whoami: unknown = { error: "secrets missing" };
      if (creds) {
        const me = await xGetMe(creds);
        whoami = me.ok
          ? { user: me.user }
          : { error: me.error, status: me.status };
      }
      const recent = await env.DB.prepare(
        `SELECT tweet_id, text, reply_to, url, created_at FROM posts ORDER BY id DESC LIMIT 20`,
      ).all();

      const html = landingPage({
        botName: env.BOT_NAME || "X Prediction Markets",
        botUsername: env.BOT_USERNAME || "XPredMarkets",
        whoami,
        recent: recent.results ?? [],
      });
      return new Response(html, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    }

    return json({ error: "not found" }, 404);
  },

  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    const cron = controller.cron;
    if (cron === "*/1 * * * *") {
      ctx.waitUntil(autoCreateModernMarket(env));
    } else {
      ctx.waitUntil(resolveDueMarkets(env));
    }
  },
};

async function persistMentions(
  env: Env,
  mentions: XMention[],
): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  let n = 0;
  for (const m of mentions) {
    const res = await env.DB
      .prepare(
        `INSERT INTO mentions (
           tweet_id, text, author_id, author_username, author_name,
           conversation_id, url, tweet_created_at, first_seen_at, last_seen_at, raw_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(tweet_id) DO UPDATE SET
           text = excluded.text,
           author_username = excluded.author_username,
           author_name = excluded.author_name,
           last_seen_at = excluded.last_seen_at,
           raw_json = excluded.raw_json`,
      )
      .bind(
        m.id,
        m.text,
        m.author_id ?? null,
        m.author_username ?? null,
        m.author_name ?? null,
        m.conversation_id ?? null,
        m.url,
        m.created_at ?? null,
        now,
        now,
        JSON.stringify(m),
      )
      .run();
    if (res.success) n += 1;
  }
  return n;
}
