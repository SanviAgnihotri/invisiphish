#!/usr/bin/env python3
"""Export a T3 Code thread so it can be imported on another machine.

This is the v2 successor to `transfer-thread.py`. The T3 Code storage moved
from the `orchestration_*` / `projection_*` tables to the `orchestration_v2_*`
tables, and the old script now exports empty sets for the projection tables,
so a thread exported with it arrives with no visible messages.

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

A third thing matters for a *summarised* transfer: the full history of a long
thread is a lot of rows, and most of it is tool output the reader does not
need. `--summarise` keeps the user's messages, the assistant's prose and the
final state of every table, and drops the bulk of the tool output, so the
imported thread carries the reasoning without the noise.

Usage:
    # on the source machine
    python scripts/deploy/transfer-thread-v2.py export \\
        --thread-id <thread-id> --session-id <session-id> \\
        --out /tmp/thread-transfer.json

    # on the target machine
    python scripts/deploy/transfer-thread-v2.py import \\
        --bundle /tmp/thread-transfer.json --target-workspace /home/av/invisiphish
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sqlite3
import sys
import time
from pathlib import Path

T3_DB = os.path.expanduser("~/.t3/userdata/statev2.sqlite")
OC_DB = os.path.expanduser("~/.local/share/opencode/opencode.db")

# The T3 projection tables that belong to a thread. They are exported in this
# order so that a reader of the bundle can follow the dependency chain:
# the thread, then its runs and nodes, then the messages and turn items that
# hang off them.
THREAD_TABLES = [
    "orchestration_v2_projection_threads",
    "orchestration_v2_projection_runs",
    "orchestration_v2_projection_run_attempts",
    "orchestration_v2_projection_nodes",
    "orchestration_v2_projection_provider_sessions",
    "orchestration_v2_projection_provider_threads",
    "orchestration_v2_projection_provider_turns",
    "orchestration_v2_projection_messages",
    "orchestration_v2_projection_turn_items",
    "orchestration_v2_projection_checkpoint_scopes",
    "orchestration_v2_projection_checkpoints",
    "orchestration_v2_turn_item_positions",
    "orchestration_v2_projection_provider_session_bindings",
    "orchestration_v2_effect_outbox",
    "orchestration_v2_projection_context_handoffs",
]

# The event log and its receipts, which need the sequence renumbering.
EVENT_TABLES = ["orchestration_events", "orchestration_command_receipts"]

# Tables whose rows are keyed by something other than the thread id.
INDIRECT_TABLES = {
    "orchestration_v2_projection_provider_threads": ("provider_thread_id", "%{thread}%"),
    "orchestration_v2_projection_provider_turns": ("provider_thread_id", "%{thread}%"),
}


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------


def connect(path: str, read_only: bool = False) -> sqlite3.Connection:
    if read_only:
        return sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    return sqlite3.connect(path)


def table_columns(connection: sqlite3.Connection, table: str) -> list[str]:
    try:
        return [row[1] for row in connection.execute(f'pragma table_info("{table}")')]
    except sqlite3.Error:
        return []


def rows_mentioning(
    connection: sqlite3.Connection, table: str, needle: str
) -> tuple[list[str], list[tuple]]:
    """Every row of `table` whose text mentions `needle`.

    The T3 tables have no single foreign key to the thread, so the rows that
    belong to a thread are found by looking for the thread id in the text.
    That is deliberately broad: a row that mentions the thread is a row the
    thread needs.
    """
    columns = table_columns(connection, table)
    if not columns:
        return [], []

    quoted = ", ".join(f'"{column}"' for column in columns)
    where = " or ".join(f'cast("{column}" as text) like ?' for column in columns)
    params = [f"%{needle}%"] * len(columns)

    rows = list(connection.execute(f"select {quoted} from \"{table}\" where {where}", params))
    return columns, rows


def rewrite(value, source_root: str, target_root: str):
    """Point every absolute path at the target machine's layout."""
    if isinstance(value, str) and source_root and source_root in value:
        return value.replace(source_root, target_root)
    if isinstance(value, dict):
        return {key: rewrite(item, source_root, target_root) for key, item in value.items()}
    if isinstance(value, list):
        return [rewrite(item, source_root, target_root) for item in value]
    return value


def summarise_turn_item(payload: str, limit: int = 400) -> str:
    """Shorten the payload of a turn item to what a reader needs.

    A tool call's output is the bulk of a long thread and the least useful
    part of it: the command is recorded, the output is not. The truncation is
    marked so the reader knows something was removed.
    """
    try:
        parsed = json.loads(payload)
    except (TypeError, ValueError):
        return payload[:limit] + ("..." if len(payload) > limit else "")

    if not isinstance(parsed, dict):
        return payload[:limit] + ("..." if len(payload) > limit else "")

    # The tool output lives under a few different keys depending on the
    # provider's shape.
    for key in ("output", "stdout", "result", "content"):
        value = parsed.get(key)
        if isinstance(value, str) and len(value) > limit:
            parsed[key] = value[:limit] + f"... [{len(value) - limit} more characters]"
        elif isinstance(value, dict):
            for inner in ("output", "stdout", "content"):
                text = value.get(inner)
                if isinstance(text, str) and len(text) > limit:
                    value[inner] = text[:limit] + f"... [{len(text) - limit} more characters]"

    # The message parts of a tool call carry the same bulk.
    for part in parsed.get("parts", []) or []:
        if isinstance(part, dict):
            for key in ("output", "text", "state"):
                value = part.get(key)
                if isinstance(value, str) and len(value) > limit:
                    part[key] = value[:limit] + f"... [{len(value) - limit} more characters]"
                elif isinstance(value, dict):
                    for inner in ("output", "content"):
                        text = value.get(inner)
                        if isinstance(text, str) and len(text) > limit:
                            value[inner] = (
                                text[:limit] + f"... [{len(text) - limit} more characters]"
                            )

    return json.dumps(parsed)


def summarise_event_payload(payload: str, limit: int = 300) -> str:
    """Shorten an event log payload.

    The event log is the largest part of a thread by far: it records every
    projection update, and each one carries a copy of the projection's
    payload. Those copies are what the projection tables already hold, so
    truncating them keeps the log's shape (the events, their order, their
    sequence numbers) without carrying the same bytes three times.

    The two fields that dominate are the file diff a `turn-item.updated`
    event carries in `newStr`, and the context handoff's `summaryText`.
    """
    try:
        parsed = json.loads(payload)
    except (TypeError, ValueError):
        return payload[:limit] + ("..." if len(payload) > limit else "")

    if not isinstance(parsed, dict):
        return payload[:limit] + ("..." if len(payload) > limit else "")

    # A file diff. The path and the shape of the change matter; the body of
    # the patch does not, because the file itself is in the repository.
    for key in ("newStr", "oldStr", "patch", "diff"):
        value = parsed.get(key)
        if isinstance(value, str) and len(value) > limit:
            parsed[key] = value[:limit] + f"... [{len(value) - limit} more characters]"

    # The context handoff's own summary, and the history it carries.
    for key in ("summaryText", "text"):
        value = parsed.get(key)
        if isinstance(value, str) and len(value) > limit:
            parsed[key] = value[:limit] + f"... [{len(value) - limit} more characters]"

    # The event's payload is usually a small wrapper around the state it
    # describes.
    for key in ("state", "payload", "data", "snapshot"):
        value = parsed.get(key)
        if isinstance(value, str) and len(value) > limit:
            parsed[key] = value[:limit] + f"... [{len(value) - limit} more characters]"
        elif isinstance(value, dict):
            for inner in ("payload_json", "output", "text", "content"):
                text = value.get(inner)
                if isinstance(text, str) and len(text) > limit:
                    value[inner] = text[:limit] + f"... [{len(text) - limit} more characters]"

    return json.dumps(parsed)


def summarise_opencode_message(data: str, limit: int = 400) -> str:
    """Shorten one opencode message the same way."""
    try:
        parsed = json.loads(data)
    except (TypeError, ValueError):
        return data[:limit] + ("..." if len(data) > limit else "")

    if isinstance(parsed, dict):
        for key in ("content", "text", "output"):
            value = parsed.get(key)
            if isinstance(value, str) and len(value) > limit:
                parsed[key] = value[:limit] + f"... [{len(value) - limit} more characters]"
            elif isinstance(value, list):
                for part in value:
                    if isinstance(part, dict):
                        for inner in ("text", "output"):
                            text = part.get(inner)
                            if isinstance(text, str) and len(text) > limit:
                                part[inner] = (
                                    text[:limit] + f"... [{len(text) - limit} more characters]"
                                )
                        state = part.get("state")
                        if isinstance(state, dict):
                            output = state.get("output")
                            if isinstance(output, str) and len(output) > limit:
                                state["output"] = (
                                    output[:limit]
                                    + f"... [{len(output) - limit} more characters]"
                                )

    return json.dumps(parsed)


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
        "summarised": bool(args.summarise),
        "t3": {},
        "opencode": {},
    }

    # --- the opencode session and its messages --------------------------
    session_columns = table_columns(oc, "session_v2")
    session_rows = list(
        oc.execute(
            f'select {", ".join(chr(34)+c+chr(34) for c in session_columns)} '
            f"from session_v2 where id = ?",
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

    if args.summarise:
        trimmed = []
        for row in message_rows:
            row = list(row)
            if "data" in message_columns:
                index = message_columns.index("data")
                row[index] = summarise_opencode_message(row[index] or "")
            trimmed.append(row)
        message_rows = trimmed

    bundle["opencode"]["session_message"] = {
        "columns": message_columns,
        "rows": [list(row) for row in message_rows],
    }

    # --- the T3 projection, event log and receipts ----------------------
    t3_tables = [
        row[0]
        for row in t3.execute("select name from sqlite_master where type='table'")
    ]

    for table in THREAD_TABLES + EVENT_TABLES:
        if table not in t3_tables:
            continue

        columns, rows = rows_mentioning(t3, table, args.thread_id)
        if not rows:
            continue

        if args.summarise:
            trimmed = []
            for row in rows:
                row = list(row)
                if "payload_json" in columns:
                    index = columns.index("payload_json")
                    if isinstance(row[index], str):
                        if table == "orchestration_events":
                            row[index] = summarise_event_payload(row[index])
                        else:
                            row[index] = summarise_turn_item(row[index])
                trimmed.append(row)
            rows = trimmed

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
    export_parser.add_argument(
        "--summarise",
        action="store_true",
        help="truncate the tool output, keeping the reasoning and the results",
    )

    import_parser = sub.add_parser("import")
    import_parser.add_argument("--bundle", required=True)
    import_parser.add_argument("--target-workspace", required=True)

    args = parser.parse_args()
    if args.command == "export":
        return export(args)
    return import_bundle(args)


if __name__ == "__main__":
    raise SystemExit(main())
