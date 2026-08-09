"""Apply sql/*.sql to Supabase over a direct Postgres connection.

    python -m scripts.supabase_migrate            # apply
    python -m scripts.supabase_migrate --dry-run  # connect and show what would run

Needs DATABASE_URL in .env — the Supabase REST API cannot run DDL, only a
Postgres connection can. Get it from:

    Dashboard -> Project Settings -> Database -> Connection string -> URI

It looks like:

    postgresql://postgres.fxoiyujqvfnclobriker:PASSWORD@aws-0-REGION.pooler.supabase.com:5432/postgres

Use the **session** pooler (port 5432) rather than the transaction pooler (6543):
transaction mode does not support the DDL and prepared statements used here.

Every statement in the migration is idempotent, so re-running is safe.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

ROOT = Path(__file__).resolve().parent.parent
SQL_DIR = ROOT / "sql"


def main() -> int:
    dry_run = "--dry-run" in sys.argv
    url = os.getenv("DATABASE_URL", "").strip()

    if not url:
        print("DATABASE_URL is not set.\n")
        print("The Supabase REST API cannot run DDL — this needs a direct Postgres")
        print("connection. Copy the URI from:")
        print("  Dashboard -> Project Settings -> Database -> Connection string -> URI")
        print("and put it in .env as DATABASE_URL (use port 5432, the session pooler).")
        return 1

    try:
        import psycopg
    except ImportError:
        print("psycopg is not installed. Run: pip install 'psycopg[binary]'")
        return 1

    files = sorted(SQL_DIR.glob("*.sql"))
    if not files:
        print(f"no .sql files in {SQL_DIR}")
        return 1

    # Never print the URL: it contains the database password.
    host = url.split("@")[-1].split("/")[0] if "@" in url else "(unparsed)"
    print(f"connecting to {host}")

    try:
        with psycopg.connect(url, connect_timeout=15) as conn:
            with conn.cursor() as cur:
                cur.execute("select current_database(), current_user, version()")
                db, user, version = cur.fetchone()
                print(f"  connected: {db} as {user}")
                print(f"  {version.split(',')[0]}")

                cur.execute("select extname from pg_extension where extname = 'vector'")
                print(f"  pgvector: {'already enabled' if cur.fetchone() else 'not yet enabled'}")

                for path in files:
                    if dry_run:
                        print(f"\n--- would apply {path.name} "
                              f"({len(path.read_text().splitlines())} lines) ---")
                        continue
                    print(f"\napplying {path.name} ...")
                    cur.execute(path.read_text())
                    print(f"  ok")

            if dry_run:
                conn.rollback()
                print("\ndry run — nothing was committed")
                return 0
            conn.commit()
    except Exception as exc:  # psycopg raises a wide family; surface it plainly
        print(f"\nFAILED: {type(exc).__name__}: {exc}")
        if "password authentication failed" in str(exc):
            print("  The password in DATABASE_URL is wrong. It is the database")
            print("  password, not the service_role API key.")
        elif "could not translate host name" in str(exc):
            print("  Host not found — check the connection string was copied whole.")
        return 1

    print("\nmigration applied. Verify with: python -m scripts.supabase_check")
    return 0


if __name__ == "__main__":
    sys.exit(main())
