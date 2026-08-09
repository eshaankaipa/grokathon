/**
 * Deterministic binary-market gate helpers.
 * Used before (and after) any LLM parse so we never create open-ended markets.
 */

const YES_NO_OPENER =
  /^(will|is|are|does|did|has|have|can|could|would|should)\b/i;

/** Open-ended / multi-outcome shapes that cannot be a single YES/NO market. */
const OPEN_ENDED =
  /^\s*(who|whom|whose|which|what|when|where|why|how(?:\s+many|\s+much|\s+long|\s+often)?)\b/i;

const OPEN_ENDED_INLINE =
  /\b(who will|who won|who wins|which (?:team|one|player|candidate|company)|what will|how many|how much)\b/i;

const SUBJECTIVE_TERMS = [
  "best",
  "worst",
  "greatest",
  "amazing",
  "awesome",
  "overrated",
  "underrated",
  "good",
  "bad",
  "beautiful",
  "ugly",
  "based",
  "cringe",
  "mid",
  "goat",
];

export type BinaryValidation =
  | { ok: true }
  | { ok: false; reason: string; code: string };

/** Strip bot handles and common "create market" command fluff. */
export function cleanMentionText(
  text: string,
  botUsername = "XPredMarkets",
): string {
  let t = (text ?? "").trim();
  t = t.replace(new RegExp(`@${botUsername}\\b`, "gi"), " ");
  t = t.replace(/@\w+/g, " ");
  t = t.replace(
    /\b(create|new|open|make|start)?\s*(a\s+)?(market|prediction|bet)\b[:\-]?\s*/gi,
    " ",
  );
  t = t.replace(/\b(please|pls|plz)\b/gi, " ");
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

export function looksOpenEnded(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (OPEN_ENDED.test(t)) return true;
  if (OPEN_ENDED_INLINE.test(t)) return true;
  return false;
}

export function looksBinaryQuestion(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (looksOpenEnded(t)) return false;
  // Prefer a sentence that ends with ?
  const q = t.match(/[^?]*\?/)?.[0]?.trim() ?? t;
  if (!YES_NO_OPENER.test(q)) return false;
  if (looksOpenEnded(q)) return false;
  return q.length >= 10;
}

export function validateBinaryQuestion(question: string): BinaryValidation {
  const q = (question ?? "").trim();
  if (!q) {
    return { ok: false, code: "empty", reason: "Question is empty." };
  }
  if (q.length < 10) {
    return {
      ok: false,
      code: "too_short",
      reason: "Question is too short for a market.",
    };
  }
  if (q.length > 280) {
    return {
      ok: false,
      code: "too_long",
      reason: "Question exceeds 280 characters.",
    };
  }
  if (!q.endsWith("?")) {
    return {
      ok: false,
      code: "not_a_question",
      reason: "Question must end with '?'.",
    };
  }
  if (!YES_NO_OPENER.test(q)) {
    return {
      ok: false,
      code: "not_yes_no",
      reason:
        "Question must be yes/no (start with Will/Is/Are/Does/Has/Can/…).",
    };
  }
  if (looksOpenEnded(q)) {
    return {
      ok: false,
      code: "open_ended",
      reason:
        "Open-ended (who/which/what/how many) questions cannot be a single yes/no market.",
    };
  }
  const lower = q.toLowerCase();
  for (const term of SUBJECTIVE_TERMS) {
    if (new RegExp(`\\b${term}\\b`, "i").test(lower)) {
      return {
        ok: false,
        code: "subjective",
        reason: `Question uses subjective term "${term}" without an objective criterion.`,
      };
    }
  }
  return { ok: true };
}

/**
 * Cheap non-LLM suggestions when Grok is unavailable.
 * Intentionally generic — prefer Grok for real alternatives.
 */
export function heuristicSuggestions(cleanedText: string): string[] {
  const base = cleanedText
    .replace(OPEN_ENDED, "")
    .replace(OPEN_ENDED_INLINE, " ")
    .replace(/[?]+/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!base || base.length < 4) {
    return [
      "Will [specific outcome] happen by [date]?",
      "Will [named person/team] win [event]?",
    ];
  }

  // If user asked "who will win X", suggest binary forms around X.
  const winMatch = cleanedText.match(
    /\b(?:who\s+will\s+win|winner\s+of)\s+(.+?)(?:\?|$)/i,
  );
  if (winMatch?.[1]) {
    const event = winMatch[1].replace(/[?]+/g, "").trim();
    return [
      `Will a specific named team/person win ${event}?`,
      `Will the winner of ${event} be announced within 7 days?`,
    ].map(clampSuggestion);
  }

  return [
    `Will ${base} resolve yes by a public source?`.replace(/\s+/g, " "),
    `Will ${base} happen by Friday?`.replace(/\s+/g, " "),
  ]
    .map((s) => (s.endsWith("?") ? s : `${s}?`))
    .map(clampSuggestion)
    .slice(0, 3);
}

function clampSuggestion(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= 120) return t.endsWith("?") ? t : `${t}?`;
  return `${t.slice(0, 117).trim()}?`;
}

/** Keep only suggestions that themselves pass the binary validator. */
export function filterBinarySuggestions(suggestions: string[]): string[] {
  const out: string[] = [];
  for (const s of suggestions) {
    let q = (s ?? "").trim();
    if (!q) continue;
    if (!q.endsWith("?")) q = `${q}?`;
    // Capitalize first letter
    q = q.charAt(0).toUpperCase() + q.slice(1);
    const v = validateBinaryQuestion(q);
    if (v.ok && !out.some((x) => x.toLowerCase() === q.toLowerCase())) {
      out.push(q);
    }
  }
  return out.slice(0, 3);
}

// --------------------------------------------------------------------------- #
// Intent / conversation filters — stop bot from jumping on casual replies
// --------------------------------------------------------------------------- #

/** Explicit "please make a market" style commands. */
const MARKET_COMMAND =
  /\b((create|open|make|start|new)\s+(a\s+)?(market|prediction|bet)|prediction\s*market|trade\s+on|odds\s+on)\b/i;

/** Conversational praise / filler that is never a market request. */
const CONVERSATIONAL_NOISE =
  /^(?:(?:oh|ah|wow|yo|hey|hi|hello|gm|gn)\s+)?(?:(?:very|so|super|really)\s+)?(?:nice|cool|awesome|amazing|great|love|sick|dope|fire|lit|based|interesting|impressive|incredible|fantastic|excellent|good|solid|clean)(?:\s+(?:project|work|job|bot|one|stuff|post|idea|demo|app|product))?[!.,\s]*$|^thanks?(?:\s+you)?[!.,\s]*$|^(?:ty|thx|tysm|lfg|let'?s go|congrats|congratulations|well done|good (?:job|work)|this is (?:cool|sick|dope|awesome|amazing|great)|love (?:this|it)|big fan)[!.,\s]*$/i;

const PRAISE_PHRASE =
  /\b(nice project|cool project|great (?:project|work|job|bot)|love (?:this|the project|the bot|it)|awesome (?:project|work|bot)|well done|congrats|congratulations|so cool|this is (?:cool|sick|dope|awesome|amazing)|good (?:job|work)|big fan)\b/i;

/**
 * True when the text is clearly trying to open/trade a market
 * (command words, or an already-binary yes/no question).
 */
export function hasMarketIntent(
  text: string,
  botUsername = "XPredMarkets",
): boolean {
  const raw = (text ?? "").trim();
  if (!raw) return false;

  if (MARKET_COMMAND.test(raw)) return true;
  if (/\bmkt_[a-f0-9]{16,}\b/i.test(raw)) return true;
  if (
    /(?:xmarket|xpred)\.[^\s]+\/market\//i.test(raw) ||
    /xpred\.aidenhuang\.com\/markets\//i.test(raw)
  ) {
    return true;
  }

  const cleaned = cleanMentionText(raw, botUsername);
  if (!cleaned) return false;

  // Already a yes/no question form
  if (looksBinaryQuestion(cleaned)) return true;
  if (cleaned.endsWith("?") && YES_NO_OPENER.test(cleaned)) return true;

  // "will X happen" without ? still counts as intent
  if (YES_NO_OPENER.test(cleaned) && cleaned.length >= 12) return true;

  // Open-ended but clearly about a future outcome (we'll CLARIFY, not silent-skip)
  if (
    looksOpenEnded(cleaned) &&
    /\b(win|wins|won|happen|announce|elected?|pass(?:es|ed)?|release|launch|close|price|score)\b/i.test(
      cleaned,
    )
  ) {
    return true;
  }

  return false;
}

/** Casual chat / praise — never create a market, never reply with suggestions. */
export function isConversationalNoise(
  text: string,
  botUsername = "XPredMarkets",
): boolean {
  const cleaned = cleanMentionText(text, botUsername);
  if (!cleaned) return true;

  // If they clearly want a market, not noise
  if (hasMarketIntent(text, botUsername)) return false;

  if (CONVERSATIONAL_NOISE.test(cleaned)) return true;
  if (PRAISE_PHRASE.test(cleaned) && cleaned.length <= 80) return true;

  // Very short non-question replies with no market words
  if (cleaned.length <= 40 && !cleaned.includes("?") && !MARKET_COMMAND.test(text)) {
    // single short utterance without predictive structure
    if (!YES_NO_OPENER.test(cleaned) && !looksOpenEnded(cleaned)) {
      return true;
    }
  }

  return false;
}

export type MentionIntentDecision =
  | { process: true }
  | { process: false; reason: string; silent: true };

/**
 * Decide whether a mention should enter the market pipeline at all.
 *
 * Replies in a thread (especially not directed at the bot) are ignored unless
 * they show clear market intent — stops "oh nice project" under a promo tweet
 * from spawning a market + bot reply.
 */
export function evaluateMentionIntent(
  text: string,
  opts?: {
    botUsername?: string;
    botUserId?: string;
    /** X in_reply_to_user_id — set when this tweet is a reply */
    inReplyToUserId?: string | null;
    /** X conversation_id — equals tweet id for root posts */
    conversationId?: string | null;
    tweetId?: string | null;
  },
): MentionIntentDecision {
  const botUsername = opts?.botUsername ?? "XPredMarkets";
  const botUserId = opts?.botUserId?.trim();
  const inReplyTo = opts?.inReplyToUserId?.trim() || null;
  const conversationId = opts?.conversationId?.trim() || null;
  const tweetId = opts?.tweetId?.trim() || null;

  if (isConversationalNoise(text, botUsername)) {
    return {
      process: false,
      silent: true,
      reason: "conversational reply — no market intent",
    };
  }

  const isReply =
    Boolean(inReplyTo) ||
    Boolean(conversationId && tweetId && conversationId !== tweetId);

  if (isReply) {
    const replyToBot = Boolean(botUserId && inReplyTo && inReplyTo === botUserId);
    const intent = hasMarketIntent(text, botUsername);

    if (!intent) {
      return {
        process: false,
        silent: true,
        reason: replyToBot
          ? "reply to bot without market intent"
          : "thread reply without market intent (not directed as a market request)",
      };
    }
  }

  return { process: true };
}
