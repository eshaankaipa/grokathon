/**
 * Grok / xAI parser: turn a tweet mention into a structured market record.
 */

export type GrokMarketParse = {
  question: string;
  description: string;
  resolution_criteria: string;
  category: string;
  closes_at: string; // ISO 8601
};

export type GrokParseResult =
  | { ok: true; data: GrokMarketParse }
  | { ok: false; error: string };

const XAI_BASE_URL = "https://api.x.ai/v1";

const CATEGORIES = [
  "Sports",
  "Politics",
  "Tech",
  "Crypto",
  "Entertainment",
  "Science",
  "Other",
];

function defaultClosesAt(): string {
  const d = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  return d.toISOString();
}

function normalizeCategory(c: string): string {
  const s = (c ?? "").trim();
  const match = CATEGORIES.find(
    (x) => x.toLowerCase() === s.toLowerCase(),
  );
  return match ?? "Other";
}

function stripMentions(text: string, botUsername = "XPredMarkets"): string {
  return text
    .replace(new RegExp(`\\b@${botUsername}\\b`, "gi"), " ")
    .replace(/@\w+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractJson(text: string): string {
  const t = text.trim();
  if (t.startsWith("{")) {
    try {
      JSON.parse(t);
      return t;
    } catch { /* fall through to first-object extraction */ }
  }
  if (t.startsWith("```")) {
    const m = t.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    return m?.[1]?.trim() ?? t.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  }
  const start = t.indexOf("{");
  if (start === -1) return t;
  for (let i = start + 1; i < t.length; i++) {
    if (t[i] === "}") {
      const candidate = t.slice(start, i + 1);
      try {
        JSON.parse(candidate);
        return candidate;
      } catch { /* continue to next } */ }
    }
  }
  return t;
}

export async function parseMarketWithGrok(
  text: string,
  apiKey: string,
  opts?: { botUsername?: string; model?: string },
): Promise<GrokParseResult> {
  const model = opts?.model ?? "grok-latest";
  const cleaned = stripMentions(text, opts?.botUsername ?? "XPredMarkets");
  if (!cleaned) {
    return { ok: false, error: "empty mention after stripping @handles" };
  }

  const nowDate = new Date();
  const now = nowDate.toISOString();
  const endOfToday = new Date(nowDate);
  endOfToday.setUTCHours(23, 59, 59, 999);
  const endOfTomorrow = new Date(endOfToday);
  endOfTomorrow.setUTCDate(endOfToday.getUTCDate() + 1);

  const prompt = `You parse a tweet into a structured prediction market. Return ONLY a compact JSON object with these keys and no other text:

- question: a clear, concise prediction market question (10-280 chars, preferably ending with ?)
- description: 1-2 sentences of helpful context, or an empty string
- resolution_criteria: a concrete, verifiable rule for how the market resolves
- category: one of ${CATEGORIES.join(", ")}
- closes_at: an ISO 8601 timestamp for a sensible close date. Use these defaults unless an explicit, different close time is clearly stated:
  - today/tonight/this afternoon -> ${endOfToday.toISOString()}
  - tomorrow -> ${endOfTomorrow.toISOString()}
  - any other date in the past or unspecified -> 7 days from ${now}

Tweet to parse: ${cleaned}`;

  try {
    const res = await fetch(`${XAI_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content: `You are a helpful prediction-market parser. The current UTC time is ${new Date().toISOString()}. Always respond with valid JSON only. The closes_at field must be a future ISO 8601 timestamp after the current time.`,
          },
          { role: "user", content: prompt },
        ],
        response_format: { type: "json_object" },
        temperature: 0.2,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        ok: false,
        error: `xAI API error ${res.status}: ${body.slice(0, 200)}`,
      };
    }

    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const raw = json.choices?.[0]?.message?.content?.trim() ?? "";
    if (!raw) {
      return { ok: false, error: "xAI returned empty content" };
    }

    let parsed: Partial<GrokMarketParse>;
    try {
      parsed = JSON.parse(extractJson(raw)) as Partial<GrokMarketParse>;
    } catch (e) {
      return {
        ok: false,
        error: `xAI did not return valid JSON: ${e instanceof Error ? e.message : String(e)}`,
      };
    }

    const question = (parsed.question ?? "").trim();
    if (question.length < 10 || question.length > 280) {
      return { ok: false, error: `parsed question length ${question.length} is outside 10-280` };
    }

    const lower = cleaned.toLowerCase();
    const isToday = /\b(today|tonight|this (morning|afternoon|evening))\b/.test(lower);
    const isTomorrow = /\btomorrow\b/.test(lower);

    let closes_at = defaultClosesAt();
    if (isToday) {
      closes_at = endOfToday.toISOString();
    } else if (isTomorrow) {
      closes_at = endOfTomorrow.toISOString();
    } else if ((parsed.closes_at ?? "").trim()) {
      const d = new Date(parsed.closes_at!);
      const min = new Date();
      closes_at = Number.isFinite(d.getTime()) && d > min ? d.toISOString() : defaultClosesAt();
    }

    return {
      ok: true,
      data: {
        question,
        description: (parsed.description ?? "").trim(),
        resolution_criteria: (parsed.resolution_criteria ?? "").trim() ||
          "Resolves based on publicly available information.",
        category: normalizeCategory(parsed.category ?? "Other"),
        closes_at,
      },
    };
  } catch (e) {
    return {
      ok: false,
      error: `grok parse failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

export type ResolutionProposal = {
  outcome: "yes" | "no" | "void";
  reason: string;
  raw: string;
};

export type GrokResolutionResult =
  | { ok: true; data: ResolutionProposal }
  | { ok: false; error: string };

export async function resolveMarketWithGrok(
  env: { XAI_API_KEY: string },
  market: {
    question: string;
    description: string | null;
    rules: string | null;
    resolve_by: number | null;
  },
  opts?: { model?: string },
): Promise<GrokResolutionResult> {
  if (!env.XAI_API_KEY) return { ok: false, error: "XAI_API_KEY not configured" };

  const now = new Date().toISOString();
  const closeAt = market.resolve_by
    ? new Date(market.resolve_by * 1000).toISOString()
    : "not specified";

  const prompt = `You are a JSON-only prediction market judge. Use web search to determine the resolution.

Market question: ${market.question}
Description: ${market.description || ""}
Resolution criteria: ${market.rules || "Resolves based on publicly available information."}
Current UTC time: ${now}
Market closes / resolve_by: ${closeAt}

Search the web for authoritative, current, publicly available information. Then return ONLY a compact JSON object with this exact shape and no other text before or after:

{"outcome": "yes" | "no" | "void", "reason": "1 sentence explaining the factual basis"}

- "yes" if the event clearly happened / the condition is true.
- "no" if it clearly did not.
- "void" only if the question is unresolvable, ambiguous, or there is no publicly available answer.`;

  try {
    const res = await fetch(`${XAI_BASE_URL}/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.XAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: opts?.model ?? "grok-4.5",
        input: [{ role: "user", content: prompt }],
        tools: [{ type: "web_search" }],
        temperature: 0.2,
        text: { format: { type: "json_object" } },
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        ok: false,
        error: `xAI API error ${res.status}: ${body.slice(0, 200)}`,
      };
    }

    const json = (await res.json()) as {
      output?: Array<{
        type: string;
        content?: Array<{ type: string; text?: string }>;
        text?: string;
      }>;
    };

    const message = json.output?.find((o) => o.type === "message");
    const text = message?.content?.[0]?.text ?? message?.text ?? "";
    if (!text) return { ok: false, error: "xAI returned empty response" };

    const raw = extractJson(text);
    let parsed: Partial<ResolutionProposal>;
    try {
      parsed = JSON.parse(raw) as Partial<ResolutionProposal>;
    } catch (e) {
      return {
        ok: false,
        error: `xAI did not return valid JSON: ${e instanceof Error ? e.message : String(e)}`,
      };
    }

    const outcome = (parsed.outcome ?? "").toLowerCase().trim();
    if (outcome !== "yes" && outcome !== "no" && outcome !== "void") {
      return { ok: false, error: `invalid outcome: ${outcome}` };
    }

    return {
      ok: true,
      data: {
        outcome: outcome as ResolutionProposal["outcome"],
        reason: (parsed.reason ?? "").trim() || "no reason given",
        raw: text,
      },
    };
  } catch (e) {
    return {
      ok: false,
      error: `resolve with grok failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
