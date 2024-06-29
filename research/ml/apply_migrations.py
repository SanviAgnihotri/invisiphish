#!/usr/bin/env python3
"""
Apply the Neon database migrations.

The migrations in `db/migrations` are plain SQL and are idempotent, so running
this script repeatedly is safe.

Usage:
    python research/ml/apply_migrations.py
    DATABASE_ADMIN_URL=... python research/ml/apply_migrations.py
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

try:
    import psycopg
except ImportError:  # pragma: no cover
    print("psycopg is required: pip install 'psycopg[binary]'", file=sys.stderr)
    raise SystemExit(1)

ROOT = Path(__file__).resolve().parent.parent
MIGRATIONS = ROOT / "db" / "migrations"


def main() -> int:
    connection_string = os.environ.get("DATABASE_ADMIN_URL") or os.environ.get("DATABASE_URL")
    if not connection_string:
        print("Set DATABASE_ADMIN_URL (or DATABASE_URL) first.", file=sys.stderr)
        return 1

    files = sorted(MIGRATIONS.glob("*.sql"))
    if not files:
        print(f"No migrations found in {MIGRATIONS}", file=sys.stderr)
        return 1

    with psycopg.connect(connection_string, autocommit=True) as connection:
        for file in files:
            print(f"==> applying {file.name}")
            connection.execute(file.read_text(encoding="utf-8"))

    print(f"Applied {len(files)} migration(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
