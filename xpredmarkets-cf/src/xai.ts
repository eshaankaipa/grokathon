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
  if (t.startsWith("```")) {
    const m = t.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    return m?.[1]?.trim() ?? t.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
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
