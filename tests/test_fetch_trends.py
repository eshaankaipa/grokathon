from ingestion.budget import RequestBudget
from ingestion.x_client import XIngestionClient


class _Resp:
    def __init__(self, payload):
        self._payload = payload
        self.status_code = 200
        self.headers = {"x-rate-limit-remaining": "100", "x-rate-limit-reset": "0"}
        self.text = ""

    def json(self):
        return self._payload


class _FakeSession:
    def __init__(self, payload):
        self._payload = payload
        self.calls = []

    def get(self, url, headers=None, params=None):
        self.calls.append((url, params))
        return _Resp(self._payload)


def test_fetch_trends_parses_and_spends_budget():
    payload = {"data": [{"trend_name": "#AI", "tweet_count": 1000},
                        {"trend_name": "Warriors", "tweet_count": None}]}
    budget = RequestBudget(max_requests=5)
    client = XIngestionClient(budget=budget, bearer_token="b", session=_FakeSession(payload))
    trends = client.fetch_trends(woeid=1)
    assert trends[0]["trend_name"] == "#AI"
    assert budget.spent == 1
