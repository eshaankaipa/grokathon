from __future__ import annotations

import re


def slug(name: str) -> str:
    """Stable topic_id from a display name: lowercase alnum tokens joined by '-'."""
    tokens = re.findall(r"[a-z0-9]+", name.lower())
    return "-".join(tokens) or "topic"
