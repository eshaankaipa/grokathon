from datetime import UTC, datetime

import pytest

from classifier import CandidateTopic
from ingestion.budget import BudgetExceeded, RequestBudget
from ingestion.x_client import XIngestionClient

_NOW = datetime(2026, 8, 8, 20, 0, tzinfo=UTC).timestamp()

COUNTS = {
    "data": [{"tweet_count": 100}, {"tweet_count": 200}, {"tweet_count": 600}],
    "meta": {"total_tweet_count": 9000},
}
SEARCH = {
    "data": [
        {"id": "1", "text": "warriors lakers tonight", "author_id": "a1",
         "created_at": "2026-08-08T18:00:00.000Z",
         "public_metrics": {"like_count": 100, "reply_count": 10, "retweet_count": 20,
                            "quote_count": 5, "bookmark_count": 3, "impression_count": 0}},
        {"id": "2", "text": "steph going off", "author_id": "a2",
         "created_at": "2026-08-08T19:00:00.000Z",
         "public_metrics": {"like_count": 50, "reply_count": 2, "retweet_count": 4,
                            "quote_count": 1, "bookmark_count": 0, "impression_count": 0}},
        {"id": "3", "text": "dup author low engagement", "author_id": "a1",
         "created_at": "2026-08-08T19:30:00.000Z",
         "public_metrics": {"like_count": 5, "reply_count": 0, "retweet_count": 0,
                            "quote_count": 0, "bookmark_count": 0}},
    ]
}


class _Resp:
    def __init__(self, payload, status=200, headers=None, text=""):
        self._payload = payload
        self.status_code = status
        self.headers = headers or {"x-rate-limit-remaining": "100", "x-rate-limit-reset": "0"}
        self.text = text

    def json(self):
        return self._payload


class _FakeSession:
    def __init__(self, counts=COUNTS, search=SEARCH, headers=None):
        self._counts = counts
        self._search = search
        self._headers = headers
        self.calls = []

    def get(self, url, headers=None, params=None):
        self.calls.append((url, params))
        payload = self._counts if "counts/recent" in url else self._search
        return _Resp(payload, headers=self._headers)


def _client(session, budget=None, sleep=None):
    return XIngestionClient(
        budget=budget or RequestBudget(max_requests=10),
        bearer_token="fake-bearer",
        session=session,
        now=lambda: _NOW,
        sleep=sleep or (lambda s: None),
    )


def test_build_candidate_topic_derives_features():
    sess = _FakeSession()
    ct = _client(sess).build_candidate_topic(
        topic_id="t", topic_name="Warriors vs Lakers", query="warriors lakers")
    assert isinstance(ct, CandidateTopic)
    assert ct.post_count == 9000
    assert ct.unique_author_count == 2
    assert ct.engagement_count == 200            # 138 + 57 + 5, excludes impressions
    assert ct.impression_count is None           # all impressions 0 -> None
    assert ct.volume_velocity == 600.0           # last hourly bucket
    assert ct.volume_growth == 4.0               # 600 / mean(100,200)
    assert ct.topic_age_minutes == 120.0         # oldest post at 18:00Z vs now 20:00Z
    assert ct.representative_posts[0] == "warriors lakers tonight"  # highest engagement
    assert len(sess.calls) == 2                  # one counts + one search


def test_min_volume_prefilter_skips_expensive_search():
    sess = _FakeSession(counts={"data": [], "meta": {"total_tweet_count": 5}})
    ct = _client(sess).build_candidate_topic(
        topic_id="t", topic_name="tiny", query="tiny", min_volume=1000)
    assert ct is None
    assert len(sess.calls) == 1                  # search skipped -> cost saved


def test_budget_blocks_before_second_call():
    sess = _FakeSession()
    client = _client(sess, budget=RequestBudget(max_requests=1))
    with pytest.raises(BudgetExceeded):
        client.build_candidate_topic(topic_id="t", topic_name="x", query="x")
    assert len(sess.calls) == 1                  # counts spent the only unit


def test_low_rate_limit_triggers_backoff_sleep():
    slept = []
    sess = _FakeSession(headers={"x-rate-limit-remaining": "1",
                                 "x-rate-limit-reset": "9999999999"})
    client = XIngestionClient(budget=RequestBudget(10), bearer_token="b",
                              session=sess, now=lambda: 0.0, sleep=lambda s: slept.append(s))
    client.fetch_counts("q")
    assert slept and slept[0] > 0


def test_missing_bearer_raises_before_spending(monkeypatch):
    monkeypatch.delenv("X_BEARER_TOKEN", raising=False)
    budget = RequestBudget(10)
    client = XIngestionClient(budget=budget, bearer_token=None, session=_FakeSession())
    with pytest.raises(RuntimeError):
        client.fetch_counts("q")
    assert budget.spent == 0


def test_non_200_raises():
    class _ErrSession(_FakeSession):
        def get(self, url, headers=None, params=None):
            self.calls.append((url, params))
            return _Resp({}, status=429, text="rate limited")

    with pytest.raises(RuntimeError):
        _client(_ErrSession()).fetch_counts("q")


def test_counts_buckets_sorted_by_start():
    counts = {"data": [
        {"start": "2026-08-08T19:00:00Z", "tweet_count": 600},
        {"start": "2026-08-08T17:00:00Z", "tweet_count": 100},
        {"start": "2026-08-08T18:00:00Z", "tweet_count": 200},
    ], "meta": {"total_tweet_count": 900}}
    total, series = _client(_FakeSession(counts=counts)).fetch_counts("q")
    assert total == 900
    assert series == [100, 200, 600]


def test_zero_engagement_is_measured_not_missing():
    zero_search = {"data": [
        {"id": "1", "text": "quiet post", "author_id": "a1",
         "created_at": "2026-08-08T18:00:00.000Z",
         "public_metrics": {"like_count": 0, "reply_count": 0, "retweet_count": 0,
                            "quote_count": 0, "bookmark_count": 0, "impression_count": 0}},
    ]}
    ct = _client(_FakeSession(search=zero_search)).build_candidate_topic(
        topic_id="t", topic_name="quiet", query="quiet")
    assert ct.engagement_count == 0
    assert ct.unique_author_count == 1
    assert ct.impression_count is None
