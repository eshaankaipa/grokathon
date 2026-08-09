"""Settle markets whose resolution date has arrived.

    python -m scripts.resolve                # sweep today
    python -m scripts.resolve 2026-12-31     # sweep as of a date

Set AUTO_SETTLE=1 in .env to let the LLM settle what it confidently knows.
Anything it can't answer becomes pending_resolution for a human, listed at the
end and settleable via POST /markets/{id}/settle.
"""

from __future__ import annotations

import asyncio
import sys

from app import deps


async def main() -> None:
    on_date = sys.argv[1] if len(sys.argv) > 1 else None
    svc = deps.build()
    try:
        due = svc.store.due_for_resolution(on_date=on_date or "9999-12-31")
        print(f"auto_settle={svc.settings.auto_settle}  due={len(due)}")

        result = await svc.resolver.sweep(on_date=on_date)
        print(f"\nchecked {result.checked} | settled {result.settled} | "
              f"needs review {result.pending_review}")

        for s in result.settlements:
            mark = {"YES": "YES ", "NO": "NO  ", "VOID": "VOID"}.get(s.outcome or "", "??? ")
            print(f"\n  [{mark}] {s.question}")
            print(f"         status: {s.status}  confidence: {s.confidence:.2f}")
            if s.evidence:
                print(f"         {s.evidence}")

        pending = svc.store.list(status="pending_resolution", limit=50)
        if pending:
            print(f"\n{len(pending)} market(s) awaiting a human:")
            for m in pending:
                print(f"  {m.id}  {m.question}")
    finally:
        svc.close()


if __name__ == "__main__":
    asyncio.run(main())
