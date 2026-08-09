import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildSearchQueryFromQuestion,
  scoreTweetRelevance,
} from "./market_tweets";
import type { XSearchTweet } from "./x";

describe("buildSearchQueryFromQuestion", () => {
  it("strips stopwords and keeps entities", () => {
    const q = buildSearchQueryFromQuestion(
      "Will the Federal Reserve cut interest rates at its next meeting?",
    );
    assert.match(q, /Federal/i);
    assert.match(q, /Reserve/i);
    assert.match(q, /lang:en -is:retweet$/);
    assert.doesNotMatch(q, /\bwill\b/i);
    assert.doesNotMatch(q, /\bnext\b/i);
  });

  it("keeps tickers handles and years", () => {
    const q = buildSearchQueryFromQuestion(
      "Will $BTC hit $100000 before 2027? @elonmusk",
    );
    assert.match(q, /\$BTC/);
    assert.match(q, /2027/);
    assert.match(q, /@elonmusk/);
  });

  it("handles empty input safely", () => {
    assert.equal(buildSearchQueryFromQuestion("   "), "lang:en -is:retweet");
  });
});

describe("scoreTweetRelevance", () => {
  it("ranks higher engagement above lower", () => {
    const low: XSearchTweet = {
      id: "1",
      text: "a",
      public_metrics: {
        like_count: 1,
        retweet_count: 0,
        reply_count: 0,
        impression_count: 10,
      },
    };
    const high: XSearchTweet = {
      id: "2",
      text: "b",
      public_metrics: {
        like_count: 50,
        retweet_count: 20,
        reply_count: 10,
        impression_count: 10000,
      },
    };
    assert.ok(scoreTweetRelevance(high) > scoreTweetRelevance(low));
  });
});
