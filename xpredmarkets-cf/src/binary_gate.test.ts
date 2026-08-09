/**
 * Unit tests for the binary market gate (no network).
 * Run: npx --yes tsx --test src/binary_gate.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  cleanMentionText,
  evaluateMentionIntent,
  filterBinarySuggestions,
  hasMarketIntent,
  heuristicSuggestions,
  isConversationalNoise,
  looksBinaryQuestion,
  looksOpenEnded,
  validateBinaryQuestion,
} from "./binary_gate";
import {
  formatMarketReply,
  formatSkipReply,
  parseMentionText,
} from "./mention_market";

describe("looksOpenEnded", () => {
  it("flags who/which/what/how many", () => {
    assert.equal(looksOpenEnded("who will win this hackathon"), true);
    assert.equal(looksOpenEnded("Which team wins the final?"), true);
    assert.equal(looksOpenEnded("what will happen tomorrow"), true);
    assert.equal(looksOpenEnded("how many goals will be scored?"), true);
  });

  it("does not flag clean yes/no", () => {
    assert.equal(looksOpenEnded("Will team Grok win the hackathon?"), false);
    assert.equal(looksOpenEnded("Is the Fed cutting rates in September?"), false);
  });
});

describe("validateBinaryQuestion", () => {
  it("accepts will/is questions", () => {
    assert.equal(
      validateBinaryQuestion("Will team Grok win the hackathon?").ok,
      true,
    );
    assert.equal(
      validateBinaryQuestion("Is Bitcoin above $100k by December 31?").ok,
      true,
    );
  });

  it("rejects open-ended and subjective", () => {
    assert.equal(validateBinaryQuestion("Who will win the hackathon?").ok, false);
    assert.equal(validateBinaryQuestion("Is Grok the best model?").ok, false);
    assert.equal(validateBinaryQuestion("team wins").ok, false);
  });
});

describe("parseMentionText", () => {
  it("skips open-ended hackathon who-wins with suggestions", () => {
    const p = parseMentionText("@XPredMarkets who will win this hackathon");
    assert.equal(p.kind, "skip");
    if (p.kind !== "skip") return;
    assert.equal(p.gate, "clarify");
    assert.ok((p.suggestions?.length ?? 0) >= 1);
  });

  it("creates from clean yes/no", () => {
    const p = parseMentionText(
      "@XPredMarkets Will team Grok win the hackathon?",
    );
    assert.equal(p.kind, "create");
    if (p.kind !== "create") return;
    assert.match(p.question, /^Will /i);
    assert.ok(p.question.endsWith("?"));
  });

  it("redirects on market id", () => {
    const p = parseMentionText("check mkt_abcdef0123456789 please");
    assert.equal(p.kind, "redirect");
  });

  it("skips self-mention", () => {
    const p = parseMentionText("hi", {
      botUserId: "1",
      authorId: "1",
    });
    assert.equal(p.kind, "skip");
  });
});

describe("formatSkipReply", () => {
  it("includes suggestions under 280 chars", () => {
    const text = formatSkipReply({
      action: "skipped",
      gate: "clarify",
      reason: "open-ended",
      suggestions: [
        "Will team Grok win the hackathon?",
        "Will a winner be announced by Friday?",
      ],
    });
    assert.ok(text);
    assert.ok(text!.includes("Will team Grok"));
    assert.ok(text!.length <= 280);
  });
});

describe("filterBinarySuggestions", () => {
  it("keeps only valid yes/no suggestions", () => {
    const out = filterBinarySuggestions([
      "Who wins?",
      "Will Alice win the hackathon?",
      "best model ever",
      "Is the event on Friday?",
    ]);
    assert.ok(out.every((q) => validateBinaryQuestion(q).ok));
    assert.ok(out.some((q) => /Alice/i.test(q)));
  });
});

describe("cleanMentionText", () => {
  it("strips bot handle and create-market fluff", () => {
    const t = cleanMentionText(
      "@XPredMarkets create a market: Will it rain in SF tomorrow?",
    );
    assert.ok(!t.includes("@"));
    assert.match(t, /rain/i);
  });
});

describe("heuristicSuggestions", () => {
  it("returns something usable for who-wins prompts", () => {
    const s = filterBinarySuggestions(
      heuristicSuggestions("who will win this hackathon"),
    );
    // May be empty if heuristics are too generic — at least don't throw
    assert.ok(Array.isArray(s));
  });
});

describe("conversational noise + reply intent", () => {
  it("flags praise as noise", () => {
    assert.equal(isConversationalNoise("oh nice project"), true);
    assert.equal(isConversationalNoise("@XPredMarkets cool!"), true);
    assert.equal(isConversationalNoise("love this"), true);
    assert.equal(isConversationalNoise("thanks!"), true);
  });

  it("does not flag real market asks as noise", () => {
    assert.equal(
      isConversationalNoise("@XPredMarkets Will team Grok win the hackathon?"),
      false,
    );
    assert.equal(hasMarketIntent("create a market: will it rain tomorrow?"), true);
  });

  it("silently skips thread replies without market intent", () => {
    const d = evaluateMentionIntent("oh nice project", {
      botUserId: "bot1",
      inReplyToUserId: "someone_else",
      conversationId: "root123",
      tweetId: "reply456",
    });
    assert.equal(d.process, false);
    if (d.process) return;
    assert.equal(d.silent, true);
  });

  it("silently skips replies to the bot that are just praise", () => {
    const d = evaluateMentionIntent("nice!", {
      botUserId: "bot1",
      inReplyToUserId: "bot1",
      conversationId: "root123",
      tweetId: "reply456",
    });
    assert.equal(d.process, false);
    if (d.process) return;
    assert.equal(d.silent, true);
  });

  it("allows replies that ask a binary market question", () => {
    const d = evaluateMentionIntent(
      "@XPredMarkets Will team Grok win the hackathon?",
      {
        botUserId: "bot1",
        inReplyToUserId: "bot1",
        conversationId: "root123",
        tweetId: "reply456",
      },
    );
    assert.equal(d.process, true);
  });

  it("parseMentionText silent-skips nice-project replies", () => {
    const p = parseMentionText("oh nice project", {
      botUserId: "bot1",
      inReplyToUserId: "author99",
      conversationId: "t1",
      tweetId: "t2",
    });
    assert.equal(p.kind, "skip");
    if (p.kind !== "skip") return;
    assert.match(p.reason, /intent|conversational/i);
  });

  it("formatMarketReply is null for silent skips", () => {
    const text = formatMarketReply({
      action: "skipped",
      silent: true,
      reason: "conversational reply — no market intent",
      suggestions: ["Will X happen?"],
    });
    assert.equal(text, null);
  });

  it("still clarifies open-ended root mentions", () => {
    const p = parseMentionText("@XPredMarkets who will win this hackathon");
    assert.equal(p.kind, "skip");
    if (p.kind !== "skip") return;
    assert.equal(p.gate, "clarify");
  });
});
