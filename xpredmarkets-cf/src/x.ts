/**
 * Minimal X API v2 client using OAuth 1.0a user context (Web Crypto).
 */

export interface XCreds {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessTokenSecret: string;
}

function percentEncode(s: string): string {
  return encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function randomNonce(bytes = 16): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmacSha1Base64(key: string, data: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(data));
  const bytes = new Uint8Array(sig);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

async function oauth1Header(
  method: string,
  url: string,
  creds: XCreds,
  extraParams: Record<string, string> = {},
): Promise<string> {
  const oauth: Record<string, string> = {
    oauth_consumer_key: creds.apiKey,
    oauth_nonce: randomNonce(),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: creds.accessToken,
    oauth_version: "1.0",
  };

  const all: Record<string, string> = { ...oauth, ...extraParams };
  const paramString = Object.keys(all)
    .sort()
    .map((k) => `${percentEncode(k)}=${percentEncode(all[k])}`)
    .join("&");

  const base = [
    method.toUpperCase(),
    percentEncode(url),
    percentEncode(paramString),
  ].join("&");

  const signingKey = `${percentEncode(creds.apiSecret)}&${percentEncode(creds.accessTokenSecret)}`;
  const signature = await hmacSha1Base64(signingKey, base);
  oauth.oauth_signature = signature;

  const header =
    "OAuth " +
    Object.keys(oauth)
      .sort()
      .map((k) => `${percentEncode(k)}="${percentEncode(oauth[k])}"`)
      .join(", ");
  return header;
}

export async function xGetMe(creds: XCreds): Promise<{
  ok: true;
  user: {
    id: string;
    username: string;
    name: string;
    description?: string;
    public_metrics?: Record<string, number>;
  };
} | { ok: false; status: number; error: unknown }> {
  const url =
    "https://api.x.com/2/users/me?user.fields=username,name,description,public_metrics";
  const auth = await oauth1Header("GET", "https://api.x.com/2/users/me", creds, {
    "user.fields": "username,name,description,public_metrics",
  });
  const res = await fetch(url, {
    headers: { Authorization: auth },
  });
  const body = await res.json();
  if (!res.ok) {
    return { ok: false, status: res.status, error: body };
  }
  const d = (body as { data: Record<string, unknown> }).data;
  return {
    ok: true,
    user: {
      id: String(d.id),
      username: String(d.username),
      name: String(d.name),
      description: d.description as string | undefined,
      public_metrics: d.public_metrics as Record<string, number> | undefined,
    },
  };
}

export async function xCreateTweet(
  creds: XCreds,
  text: string,
  replyTo?: string,
): Promise<
  | { ok: true; id: string; text: string }
  | { ok: false; status: number; error: unknown }
> {
  const url = "https://api.x.com/2/tweets";
  const auth = await oauth1Header("POST", url, creds);
  const payload: Record<string, unknown> = { text };
  if (replyTo) {
    payload.reply = { in_reply_to_tweet_id: replyTo };
  }
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: auth,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  if (!res.ok) {
    return { ok: false, status: res.status, error: body };
  }
  const data = (body as { data: { id: string; text: string } }).data;
  return { ok: true, id: data.id, text: data.text };
}

export interface XMention {
  id: string;
  text: string;
  author_id?: string;
  author_username?: string;
  author_name?: string;
  created_at?: string;
  conversation_id?: string;
  in_reply_to_user_id?: string;
  url: string;
}

export interface XMentionsResult {
  ok: true;
  user_id: string;
  mentions: XMention[];
  meta?: {
    result_count?: number;
    newest_id?: string;
    oldest_id?: string;
    next_token?: string;
  };
}

export async function xGetMentions(
  creds: XCreds,
  userId: string,
  opts: {
    maxResults?: number;
    sinceId?: string;
    paginationToken?: string;
  } = {},
): Promise<XMentionsResult | { ok: false; status: number; error: unknown }> {
  const baseUrl = `https://api.x.com/2/users/${userId}/mentions`;
  const params: Record<string, string> = {
    max_results: String(Math.min(Math.max(opts.maxResults ?? 10, 5), 100)),
    "tweet.fields":
      "created_at,author_id,conversation_id,in_reply_to_user_id,public_metrics",
    expansions: "author_id",
    "user.fields": "username,name,public_metrics",
  };
  if (opts.sinceId) params.since_id = opts.sinceId;
  if (opts.paginationToken) params.pagination_token = opts.paginationToken;

  const qs = Object.keys(params)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
    .join("&");
  const fullUrl = `${baseUrl}?${qs}`;

  const auth = await oauth1Header("GET", baseUrl, creds, params);
  const res = await fetch(fullUrl, {
    headers: { Authorization: auth },
  });
  const body = (await res.json()) as {
    data?: Array<Record<string, unknown>>;
    includes?: { users?: Array<Record<string, unknown>> };
    meta?: {
      result_count?: number;
      newest_id?: string;
      oldest_id?: string;
      next_token?: string;
    };
    errors?: unknown;
    detail?: string;
    title?: string;
  };

  if (!res.ok) {
    return { ok: false, status: res.status, error: body };
  }

  const usersById = new Map<string, { username?: string; name?: string }>();
  for (const u of body.includes?.users ?? []) {
    usersById.set(String(u.id), {
      username: u.username as string | undefined,
      name: u.name as string | undefined,
    });
  }

  const mentions: XMention[] = (body.data ?? []).map((t) => {
    const authorId = t.author_id ? String(t.author_id) : undefined;
    const author = authorId ? usersById.get(authorId) : undefined;
    const id = String(t.id);
    return {
      id,
      text: String(t.text ?? ""),
      author_id: authorId,
      author_username: author?.username,
      author_name: author?.name,
      created_at: t.created_at as string | undefined,
      conversation_id: t.conversation_id
        ? String(t.conversation_id)
        : undefined,
      in_reply_to_user_id: t.in_reply_to_user_id
        ? String(t.in_reply_to_user_id)
        : undefined,
      url: author?.username
        ? `https://x.com/${author.username}/status/${id}`
        : `https://x.com/i/status/${id}`,
    };
  });

  return {
    ok: true,
    user_id: userId,
    mentions,
    meta: body.meta,
  };
}

// ---------------------------------------------------------------------------
// App-only bearer token helpers (used by the background sweeper)
// ---------------------------------------------------------------------------

export interface XSearchTweet {
  id: string;
  text: string;
  author_id?: string;
  created_at?: string;
  public_metrics?: Record<string, number>;
}

export interface XTrend {
  trend_name: string;
  tweet_count?: number;
}

export type XCountsResult =
  | { ok: true; total: number; buckets: number[] }
  | { ok: false; status: number; error: unknown };

export type XSearchResult =
  | { ok: true; tweets: XSearchTweet[] }
  | { ok: false; status: number; error: unknown };

export type XTrendsResult =
  | { ok: true; trends: XTrend[] }
  | { ok: false; status: number; error: unknown };

function xBearerHeaders(bearer: string): Record<string, string> {
  return {
    Authorization: `Bearer ${bearer}`,
    "Content-Type": "application/json",
  };
}

export async function xBearerTrends(
  bearer: string,
  woeid = 1,
): Promise<XTrendsResult> {
  const url = `https://api.x.com/2/trends/by/woeid/${woeid}?trend.fields=trend_name,tweet_count`;
  const res = await fetch(url, { headers: xBearerHeaders(bearer) });
  const body = (await res.json()) as {
    data?: Array<Record<string, unknown>>;
    errors?: unknown;
  };
  if (!res.ok) {
    return { ok: false, status: res.status, error: body };
  }
  const trends: XTrend[] = (body.data ?? []).map((t) => ({
    trend_name: String(t.trend_name ?? t.name ?? ""),
    tweet_count: typeof t.tweet_count === "number" ? t.tweet_count : undefined,
  }));
  return { ok: true, trends: trends.filter((t) => t.trend_name) };
}

export async function xBearerCounts(
  bearer: string,
  query: string,
): Promise<XCountsResult> {
  const url = new URL("https://api.x.com/2/tweets/counts/recent");
  url.searchParams.set("query", query);
  url.searchParams.set("granularity", "hour");
  const res = await fetch(url.toString(), { headers: xBearerHeaders(bearer) });
  const body = (await res.json()) as {
    meta?: { total_tweet_count?: number };
    data?: Array<{ tweet_count?: number }>;
    errors?: unknown;
  };
  if (!res.ok) {
    return { ok: false, status: res.status, error: body };
  }
  const total = body.meta?.total_tweet_count ?? 0;
  const buckets = (body.data ?? [])
    .sort((a, b) => 0)
    .map((b) => b.tweet_count ?? 0);
  return { ok: true, total, buckets };
}

export async function xBearerSearch(
  bearer: string,
  query: string,
  maxResults = 20,
): Promise<XSearchResult> {
  const url = new URL("https://api.x.com/2/tweets/search/recent");
  url.searchParams.set("query", query);
  url.searchParams.set("max_results", String(Math.min(Math.max(maxResults, 10), 100)));
  url.searchParams.set("tweet.fields", "created_at,public_metrics,author_id");
  url.searchParams.set("sort_order", "relevancy");
  const res = await fetch(url.toString(), { headers: xBearerHeaders(bearer) });
  const body = (await res.json()) as {
    data?: Array<Record<string, unknown>>;
    errors?: unknown;
  };
  if (!res.ok) {
    return { ok: false, status: res.status, error: body };
  }
  const tweets: XSearchTweet[] = (body.data ?? []).map((t) => ({
    id: String(t.id),
    text: String(t.text ?? ""),
    author_id: t.author_id ? String(t.author_id) : undefined,
    created_at: t.created_at as string | undefined,
    public_metrics: t.public_metrics as Record<string, number> | undefined,
  }));
  return { ok: true, tweets };
}
