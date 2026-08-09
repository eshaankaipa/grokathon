from __future__ import annotations

import re

from discovery.base import TopicSeed

_STOP = {"vs", "versus", "the", "a", "an", "and", "of", "at", "in", "on", "game", "match"}


def _key(name: str) -> frozenset[str]:
    tokens = re.findall(r"[a-z0-9]+", name.lower())
    meaningful = [t for t in tokens if t not in _STOP]
    return frozenset(meaningful or tokens)


def dedupe_seeds(seeds: list[TopicSeed]) -> list[TopicSeed]:
    """Collapse obvious duplicate seeds by normalized token set. Keeps first seen.

    Lightweight only — alias resolution (e.g. GSW == Warriors) is downstream.
    """
    seen: dict[frozenset[str], TopicSeed] = {}
    for s in seeds:
        k = _key(s.name)
        if k not in seen:
            seen[k] = s
    return list(seen.values())
