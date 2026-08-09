/**
 * Grok / xAI parser: gate mentions into CREATE vs REJECT/CLARIFY,
 * and only then produce a structured binary market record.
 */

import {
  cleanMentionText,
  filterBinarySuggestions,
  heuristicSuggestions,
  looksBinaryQuestion,
  looksOpenEnded,
  validateBinaryQuestion,
} from "./binary_gate";

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

/** Gate decision for a user mention. */
export type MentionGateDecision = "create" | "reject" | "clarify";

export type MentionGateOk = {
  ok: true;
  decision: MentionGateDecision;
  reason: string;
  /** Present only when decision === "create" and post-validated. */
  market?: GrokMarketParse;
  /** 1–3 binary yes/no alternatives the user can reply with. */
  suggestions: string[];
};

export type MentionGateResult =
  | MentionGateOk
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

function resolveClosesAt(
  cleaned: string,
  rawCloses: string | undefined,
  endOfToday: Date,
  endOfTomorrow: Date,
): string {
  const lower = cleaned.toLowerCase();
  const isToday = /\b(today|tonight|this (morning|afternoon|evening))\b/.test(lower);
  const isTomorrow = /\btomorrow\b/.test(lower);
  if (isToday) return endOfToday.toISOString();
  if (isTomorrow) return endOfTomorrow.toISOString();
  if ((rawCloses ?? "").trim()) {
    const d = new Date(rawCloses!);
    const min = new Date();
    if (Number.isFinite(d.getTime()) && d > min) return d.toISOString();
  }
  return defaultClosesAt();
}

type GrokGateRaw = {
  decision?: string;
  reason?: string;
  question?: string;
  description?: string;
  resolution_criteria?: string;
  category?: string;
  closes_at?: string;
  suggestions?: unknown;
};

/**
 * Assess a mention: only CREATE when it is a clean, resolvable yes/no.
 * Otherwise REJECT/CLARIFY and return similar binary suggestions the user can reply with.
 */
export async function assessMentionWithGrok(
  text: string,
  apiKey: string,
  opts?: { botUsername?: string; model?: string },
): Promise<MentionGateResult> {
  const model = opts?.model ?? "grok-latest";
  const cleaned = cleanMentionText(text, opts?.botUsername ?? "XPredMarkets");
  if (!cleaned) {
    return { ok: false, error: "empty mention after stripping @handles" };
  }

  // Fast path: clearly open-ended → never create; still ask Grok for good suggestions.
  const forcedClarify = looksOpenEnded(cleaned) && !looksBinaryQuestion(cleaned);

  const nowDate = new Date();
  const now = nowDate.toISOString();
  const endOfToday = new Date(nowDate);
  endOfToday.setUTCHours(23, 59, 59, 999);
  const endOfTomorrow = new Date(endOfToday);
  endOfTomorrow.setUTCDate(endOfToday.getUTCDate() + 1);

  const prompt = `You are a gatekeeper for a BINARY prediction-market bot (YES/NO only).

Decide whether this tweet can become ONE clean, objectively resolvable yes/no market.

decision must be exactly one of:
- CREATE — the tweet already states (or clearly intends) a single verifiable YES/NO claim. A neutral observer could settle it from public info. Question must start with Will/Is/Are/Does/Has/Can/… and end with ?.
- CLARIFY — topic is real but not yet a yes/no market (open-ended who/which/what/how many, missing named outcome, missing date, too vague). Do NOT invent a specific winner or force a random binary rewrite of the user's intent.
- REJECT — never tradeable: subjective opinion, joke/meme/spam, already resolved, unverifiable, or harmful/private-life content.

Hard rules:
- NEVER CREATE for "who will win…", "which team…", "what will happen…", "how many…"
- NEVER CREATE subjective markets ("best", "overrated", "amazing") without a numeric public criterion
- Do NOT silently rewrite multi-outcome questions into yes/no and CREATE them
- DO CREATE when the user already wrote a clear Will/Is/Are/Does yes/no with a named subject (person/team/thing), even if the event is informal — e.g. "Will team Grok win the hackathon?" is CREATE (resolve via official winner announcement). Prefer CREATE over CLARIFY for already-binary phrasing.
- Use CLARIFY when the claim is multi-outcome, missing any proposition, or too ambiguous to settle at all
- On CLARIFY or REJECT, suggestions MUST be 2-3 alternative questions that ARE valid yes/no, close in spirit to what the user asked, each starting with Will/Is/Are/… and ending with ?, under 120 chars, objectively resolvable. Prefer concrete named alternatives over placeholders like "Team A".
- On CREATE, suggestions may be empty []; question + resolution_criteria are required
- resolution_criteria must say what makes YES and what makes NO
- category: one of ${CATEGORIES.join(", ")}
- closes_at: ISO 8601 future timestamp. Defaults: today/tonight -> ${endOfToday.toISOString()}; tomorrow -> ${endOfTomorrow.toISOString()}; else 7 days from ${now}

Tweet: ${cleaned}

Return ONLY JSON:
{"decision":"CREATE|CLARIFY|REJECT","reason":"","question":"","description":"","resolution_criteria":"","category":"Other","closes_at":"","suggestions":["",""]}`;

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
            content: `You gate binary prediction markets. Current UTC: ${now}. Respond with valid JSON only. Prefer CLARIFY over CREATE when unsure. Never force open-ended questions into CREATE.`,
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

    let parsed: GrokGateRaw;
    try {
      parsed = JSON.parse(extractJson(raw)) as GrokGateRaw;
    } catch (e) {
      return {
        ok: false,
        error: `xAI did not return valid JSON: ${e instanceof Error ? e.message : String(e)}`,
      };
    }

    const decisionRaw = String(parsed.decision ?? "")
      .trim()
      .toUpperCase();
    let decision: MentionGateDecision =
      decisionRaw === "CREATE"
        ? "create"
        : decisionRaw === "REJECT"
          ? "reject"
          : "clarify";

    // Deterministic override: open-ended text never creates.
    if (forcedClarify && decision === "create") {
      decision = "clarify";
    }

    const reason =
      (parsed.reason ?? "").trim() ||
      (decision === "create"
        ? "valid binary market"
        : "not a clean yes/no market");

    const rawSuggestions = Array.isArray(parsed.suggestions)
      ? parsed.suggestions.map((s) => String(s ?? "").trim()).filter(Boolean)
      : [];
    let suggestions = filterBinarySuggestions(rawSuggestions);
    if (suggestions.length === 0 && decision !== "create") {
      suggestions = filterBinarySuggestions(heuristicSuggestions(cleaned));
    }

    if (decision !== "create") {
      return {
        ok: true,
        decision,
        reason: forcedClarify
          ? `Open-ended question cannot be a single yes/no market. ${reason}`
          : reason,
        suggestions,
      };
    }

    let question = (parsed.question ?? "").trim();
    if (!question.endsWith("?") && question.length > 0) {
      question = `${question}?`;
    }
    // Capitalize
    if (question) {
      question = question.charAt(0).toUpperCase() + question.slice(1);
    }

    const validation = validateBinaryQuestion(question);
    if (!validation.ok) {
      // Model tried CREATE but failed validation → clarify + suggestions
      if (suggestions.length === 0) {
        suggestions = filterBinarySuggestions([
          ...rawSuggestions,
          ...heuristicSuggestions(cleaned),
          question,
        ]);
      }
      return {
        ok: true,
        decision: "clarify",
        reason: validation.reason,
        suggestions,
      };
    }

    const closes_at = resolveClosesAt(
      cleaned,
      parsed.closes_at,
      endOfToday,
      endOfTomorrow,
    );

    return {
      ok: true,
      decision: "create",
      reason,
      suggestions: [],
      market: {
        question,
        description: (parsed.description ?? "").trim(),
        resolution_criteria:
          (parsed.resolution_criteria ?? "").trim() ||
          "Resolves YES if the stated condition is met per public sources; otherwise NO.",
        category: normalizeCategory(parsed.category ?? "Other"),
        closes_at,
      },
    };
  } catch (e) {
    return {
      ok: false,
      error: `grok assess failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * Backward-compatible wrapper: only succeeds when the gate says CREATE.
 * Prefer assessMentionWithGrok for mention handling.
 */
export async function parseMarketWithGrok(
  text: string,
  apiKey: string,
  opts?: { botUsername?: string; model?: string },
): Promise<GrokParseResult> {
  const gate = await assessMentionWithGrok(text, apiKey, opts);
  if (!gate.ok) return gate;
  if (gate.decision !== "create" || !gate.market) {
    return {
      ok: false,
      error: gate.reason || `mention gate: ${gate.decision}`,
    };
  }
  return { ok: true, data: gate.market };
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
