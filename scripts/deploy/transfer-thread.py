#!/usr/bin/env python3
"""
Transfer a T3 Code thread, and the opencode session behind it, from one
machine to another.

The thread is split across two stores:

* `~/.t3/userdata/statev2.sqlite` - the T3 projection tables, the event log
  and the project record.
* `~/.local/share/opencode/opencode.db` - the opencode session and its
  messages.

Both are plain SQLite, and both machines run the same version, so the transfer
is a row copy. Two things need care:

* **Sequence numbers.** `orchestration_events.sequence` is an autoincrement
  primary key shared by every thread on the machine, and
  `orchestration_command_receipts.result_sequence` refers to it. The events
  are therefore renumbered to continue after the target's highest sequence, and
  the receipts are shifted by the same amount.
* **Paths.** The project, the session and any payload that mentions a
  workspace path are rewritten to the target's path, because the workspace
  lives at a different absolute path on the other machine.

Usage:
    # on the source machine
    python scripts/deploy/transfer-thread.py export \\
        --thread-id <thread-id> --session-id <session-id> \\
        --out /tmp/thread-transfer.json

    # on the target machine
    python scripts/deploy/transfer-thread.py import \\
        --bundle /tmp/thread-transfer.json --target-workspace /home/av/invisiphish
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sqlite3
import sys
import time
from pathlib import Path

T3_DB = os.path.expanduser("~/.t3/userdata/statev2.sqlite")
OC_DB = os.path.expanduser("~/.local/share/opencode/opencode.db")


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------


def connect(path: str, read_only: bool = False) -> sqlite3.Connection:
    if read_only:
        return sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    return sqlite3.connect(path)


def table_columns(connection: sqlite3.Connection, table: str) -> list[str]:
    return [row[1] for row in connection.execute(f"PRAGMA table_info('{table}')")]


def rows_mentioning(
    connection: sqlite3.Connection, table: str, needle: str
) -> tuple[list[str], list[tuple]]:
    """Select every row where any text column contains `needle`."""
    columns = table_columns(connection, table)
    if not columns:
        return [], []

    text_columns = [
        row[1]
        for row in connection.execute(f"PRAGMA table_info('{table}')")
        if (row[2] or "").upper() in ("TEXT", "VARCHAR", "CHAR", "")
    ]
    if not text_columns:
        return columns, []

    where = " or ".join(f'cast("{column}" as text) like ?' for column in text_columns)
    params = [f"%{needle}%"] * len(text_columns)

    selected = ", ".join(f'"{column}"' for column in columns)
    rows = list(connection.execute(f'select {selected} from "{table}" where {where}', params))
    return columns, rows


def rewrite(value, source_root: str, target_root: str):
    """Replace the source workspace path anywhere it appears in a value."""
    if isinstance(value, str):
        return value.replace(source_root, target_root)
    return value


# --------------------------------------------------------------------------
# export
# --------------------------------------------------------------------------


def export(args) -> int:
    t3 = connect(T3_DB, read_only=True)
    oc = connect(OC_DB, read_only=True)

    bundle: dict = {
        "thread_id": args.thread_id,
        "session_id": args.session_id,
        "project_id": args.project_id,
        "source_workspace": args.source_workspace,
        "target_workspace": args.target_workspace,
        "title": args.title,
        "t3": {},
        "opencode": {},
    }

    # --- the opencode session and its messages --------------------------
    session_columns = table_columns(oc, "session_v2")
    session_rows = list(
        oc.execute(
            f'select {", ".join(chr(34)+c+chr(34) for c in session_columns)} '
            f'from session_v2 where id = ?',
            (args.session_id,),
        )
    )
    bundle["opencode"]["session_v2"] = {
        "columns": session_columns,
        "rows": [list(row) for row in session_rows],
    }

    message_columns = table_columns(oc, "session_message")
    message_rows = list(
        oc.execute(
            f'select {", ".join(chr(34)+c+chr(34) for c in message_columns)} '
            f"from session_message where session_id = ?",
            (args.session_id,),
        )
    )
    bundle["opencode"]["session_message"] = {
        "columns": message_columns,
        "rows": [list(row) for row in message_rows],
    }

    # --- the T3 projection, event log and receipts ----------------------
    t3_tables = [
        row[0]
        for row in t3.execute("select name from sqlite_master where type='table'")
    ]

    for table in t3_tables:
        columns, rows = rows_mentioning(t3, table, args.thread_id)
        if not rows:
            continue
        bundle["t3"][table] = {"columns": columns, "rows": [list(row) for row in rows]}

    # The project record is keyed by project id rather than thread id.
    if args.project_id:
        project_columns = table_columns(t3, "projection_projects")
        project_rows = list(
            t3.execute(
                f'select {", ".join(chr(34)+c+chr(34) for c in project_columns)} '
                f"from projection_projects where project_id = ?",
                (args.project_id,),
            )
        )
        if project_rows:
            bundle["t3"]["projection_projects"] = {
                "columns": project_columns,
                "rows": [list(row) for row in project_rows],
            }

    # The events and the receipts need their sequence numbers moved.
    events = bundle["t3"].get("orchestration_events")
    if events and events["rows"]:
        index = events["columns"].index("sequence")
        sequences = [row[index] for row in events["rows"]]
        bundle["event_sequence_range"] = [min(sequences), max(sequences)]

    receipts = bundle["t3"].get("orchestration_command_receipts")
    if receipts and receipts["rows"] and "result_sequence" in receipts["columns"]:
        index = receipts["columns"].index("result_sequence")
        values = [row[index] for row in receipts["rows"] if row[index] is not None]
        if values:
            bundle["receipt_sequence_range"] = [min(values), max(values)]

    t3.close()
    oc.close()

    Path(args.out).write_text(json.dumps(bundle), encoding="utf-8")
    size = Path(args.out).stat().st_size / 1024
    print(f"wrote {args.out} ({size:.0f} KB)")
    for name, table in bundle["t3"].items():
        print(f"  t3.{name}: {len(table['rows'])} rows")
    for name, table in bundle["opencode"].items():
        print(f"  opencode.{name}: {len(table['rows'])} rows")
    return 0


# --------------------------------------------------------------------------
# import
# --------------------------------------------------------------------------


def import_bundle(args) -> int:
    bundle = json.loads(Path(args.bundle).read_text(encoding="utf-8"))
    target_root = args.target_workspace
    source_root = bundle.get("source_workspace", "")

    stamp = time.strftime("%Y%m%d-%H%M%S")
    backups = []

    for path in (T3_DB, OC_DB):
        if not os.path.exists(path):
            continue
        backup = f"{path}.bak-{stamp}"
        shutil.copy2(path, backup)
        backups.append(backup)
        print(f"  backed up {path} -> {backup}")

    # --- work out the sequence offset -----------------------------------
    offset = 0
    t3 = connect(T3_DB)
    t3.execute("PRAGMA busy_timeout = 10000")

    local_max = t3.execute("select coalesce(max(sequence), 0) from orchestration_events").fetchone()[0]
    if "event_sequence_range" in bundle:
        wanted_max = bundle["event_sequence_range"][1]
        target_max = local_max
        offset = target_max + 1 - bundle["event_sequence_range"][0]
        print(
            f"  event sequences {bundle['event_sequence_range'][0]}..{wanted_max} "
            f"-> {bundle['event_sequence_range'][0] + offset}..{wanted_max + offset} "
            f"(target max was {target_max})"
        )

    def shift(value):
        if offset and isinstance(value, int):
            return value + offset
        return value

    # --- import the T3 tables -------------------------------------------
    for table, payload in bundle["t3"].items():
        target_columns = table_columns(t3, table)
        if not target_columns:
            print(f"  !! {table} does not exist on the target, skipped")
            continue

        columns = payload["columns"]
        missing = [c for c in columns if c not in target_columns]
        if missing:
            print(f"  !! {table} is missing columns on the target: {missing}, skipped")
            continue

        keep = [index for index, column in enumerate(columns) if column in target_columns]
        kept_columns = [columns[index] for index in keep]

        placeholders = ", ".join("?" for _ in kept_columns)
        statement = (
            f'INSERT OR REPLACE INTO "{table}" ({", ".join(chr(34)+c+chr(34) for c in kept_columns)}) '
            f"VALUES ({placeholders})"
        )

        count = 0
        for row in payload["rows"]:
            values = []
            for index in keep:
                column = columns[index]
                value = row[index]
                if column == "sequence" and table == "orchestration_events":
                    value = shift(value)
                if column == "result_sequence" and table == "orchestration_command_receipts":
                    value = shift(value)
                values.append(rewrite(value, source_root, target_root))
            t3.execute(statement, values)
            count += 1

        print(f"  t3.{table}: {count} rows")
        if table == "orchestration_events":
            t3.execute("delete from sqlite_sequence where name = 'orchestration_events'")
            t3.execute(
                "insert into sqlite_sequence (name, seq) values ('orchestration_events', ?)",
                (local_max + offset,),
            )

    t3.commit()
    t3.close()

    # --- import the opencode session ------------------------------------
    oc = connect(OC_DB)
    oc.execute("PRAGMA busy_timeout = 10000")

    for table, payload in bundle["opencode"].items():
        target_columns = table_columns(oc, table)
        columns = payload["columns"]
        missing = [c for c in columns if c not in target_columns]
        if missing:
            print(f"  !! {table} is missing columns on the target: {missing}, skipped")
            continue

        keep = [index for index, column in enumerate(columns) if column in target_columns]
        kept_columns = [columns[index] for index in keep]
        placeholders = ", ".join("?" for _ in kept_columns)
        statement = (
            f'INSERT OR REPLACE INTO "{table}" ({", ".join(chr(34)+c+chr(34) for c in kept_columns)}) '
            f"VALUES ({placeholders})"
        )

        count = 0
        for row in payload["rows"]:
            values = [rewrite(row[index], source_root, target_root) for index in keep]
            oc.execute(statement, values)
            count += 1

        print(f"  opencode.{table}: {count} rows")

    oc.commit()
    oc.close()

    print("\n  restart the app so it picks the rows up:")
    print("    systemctl --user restart opencode oc-shim")
    print("    pm2 restart t3")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    export_parser = sub.add_parser("export")
    export_parser.add_argument("--thread-id", required=True)
    export_parser.add_argument("--session-id", required=True)
    export_parser.add_argument("--project-id", default=None)
    export_parser.add_argument("--source-workspace", required=True)
    export_parser.add_argument("--target-workspace", required=True)
    export_parser.add_argument("--title", default=None)
    export_parser.add_argument("--out", required=True)

    import_parser = sub.add_parser("import")
    import_parser.add_argument("--bundle", required=True)
    import_parser.add_argument("--target-workspace", required=True)

    args = parser.parse_args()
    if args.command == "export":
        return export(args)
    return import_bundle(args)


if __name__ == "__main__":
    raise SystemExit(main())
