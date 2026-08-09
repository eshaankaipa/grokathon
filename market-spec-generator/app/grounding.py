from __future__ import annotations

from datetime import datetime, timezone

from .dates import date_support
from .llm import JSONLLM, LLMError
from .models import Classification, Grounding, TweetCluster
from .prompts import GROUNDING_SYSTEM, GROUNDING_USER


class Grounder:
    """Checks that a proposed market is supported by the posts it came from.

    The classifier reads tweet text and emits an event and a resolution date. It
    has no way to check either, so it can fill in a plausible-looking date from
    priors — and a market on a fixture that was never scheduled can never settle.

    Two signals:

    - Deterministic: does the post text actually reference this date? Cheap, no
      LLM call, and it catches the common failure outright.
    - Evidential: an LLM asked to quote the span of the posts supporting the
      claim. A claim it cannot quote is not supported.

    The deterministic signal alone can't decide, because a date can be legitimate
    without appearing in the text ("Super Bowl LXI" implies one). So `absent` and
    `mismatch` escalate to the evidence check rather than rejecting outright.
    """

    def __init__(self, llm: JSONLLM | None, *, strict: bool = True) -> None:
        self._llm = llm
        self._strict = strict

    async def check(
        self, classification: Classification, cluster: TweetCluster
    ) -> Grounding:
        today = datetime.now(timezone.utc).date()
        text = "\n".join(t.text for t in cluster.tweets)
        support = date_support(text, classification.resolution_date, today=today)

        if support == "explicit":
            return Grounding(
                supported=True, date_support=support, confidence=1.0,
                reason="The posts state this date directly.",
            )

        if support == "relative":
            return Grounding(
                supported=True, date_support=support, confidence=0.7,
                reason="The posts pin the timing relatively rather than by date.",
            )

        # 'absent' or 'mismatch' — the text does not back the date. Could still be
        # legitimate public knowledge, so ask for evidence before rejecting.
        if self._llm is None:
            return Grounding(
                supported=not self._strict, date_support=support, confidence=0.0,
                issues=[f"Resolution date is {support} from the source posts."],
                reason=(
                    "No evidence check configured and the posts do not support the date."
                    if self._strict else
                    "Date unsupported by the posts, but grounding is non-strict."
                ),
            )

        return await self._verify(classification, cluster, support, today.isoformat())

    async def _verify(
        self, classification: Classification, cluster: TweetCluster,
        support: str, today: str,
    ) -> Grounding:
        try:
            raw = await self._llm.json(
                system=GROUNDING_SYSTEM,
                user=GROUNDING_USER.format(
                    today=today,
                    event=classification.event,
                    resolution_date=classification.resolution_date or "unknown",
                    entities=", ".join(classification.entities) or "(none)",
                    date_support=support,
                    posts=cluster.digest(limit=15),
                ),
            )
        except LLMError as exc:
            # Fail closed: this guard exists to stop unfounded markets, so losing
            # it must not silently let them through.
            return Grounding(
                supported=not self._strict, date_support=support, confidence=0.0,
                issues=[f"Evidence check failed: {exc}"],
                reason="Could not verify the claim against the posts.",
            )

        issues = raw.get("issues") or []
        issues = [str(i).strip() for i in issues if str(i).strip()] if isinstance(issues, list) else []
        try:
            confidence = min(1.0, max(0.0, float(raw.get("confidence", 0.0))))
        except (TypeError, ValueError):
            confidence = 0.0

        supported = bool(raw.get("supported")) and confidence >= 0.5
        return Grounding(
            supported=supported,
            date_support=support,
            confidence=confidence,
            issues=issues,
            evidence=str(raw.get("evidence") or "").strip(),
            reason=str(raw.get("reason") or "").strip()
            or ("Claim is supported by the posts." if supported
                else "The posts do not support this event or date."),
        )
