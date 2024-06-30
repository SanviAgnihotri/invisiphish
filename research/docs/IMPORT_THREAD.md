# Importing this thread into T3 Code on the MacBook

This is the T3 Code thread that ran on the VPS. The bundle beside this file
carries it in a summarised form: the messages, the reasoning and the results
are all there, but the bulk of the tool output is truncated so that the
bundle is 30 MB rather than 300 MB.

## What is in the bundle

| | |
|---|---|
| Thread | `7f067ac7-2ebf-48a2-8a07-d81287a4aa73` |
| opencode session | `ses_ea48adb46ffeVhAKajX2QqvGSf` |
| T3 tables | 18 (thread, runs, nodes, messages, turn items, event log, ...) |
| opencode tables | 2 (the session and its 382 messages) |

The event log and the command receipts carry sequence numbers that are shared
across every thread on a machine, so the importer renumbers them to continue
after the target's highest sequence. The importer also rewrites the absolute
workspace paths, because the workspace lives at a different path on the
MacBook.

## Before you start

**Both databases are backed up automatically** by the importer, with a
timestamp:

```
~/.t3/userdata/statev2.sqlite.bak-YYYYmmdd-HHMMSS
~/.local/share/opencode/opencode.db.bak-YYYYmmdd-HHMMSS
```

**Stop T3 Code and opencode first.** They hold the databases open, and
importing underneath a running server is how the store gets corrupted:

```bash
# quit T3 Code from its menu, or:
pm2 stop t3
systemctl --user stop opencode oc-shim
```

## Import

The script is `scripts/deploy/transfer-thread-v2.py` in the repository. It is the
successor to `transfer-thread.py`: the T3 Code storage moved from the
`orchestration_*` tables to the `orchestration_v2_*` tables, and the old
script now exports empty projection tables, so a thread exported with it
arrives with no visible messages.

```bash
cd ~/invisiphish
git pull                              # if you have not fetched yet
python3 scripts/deploy/transfer-thread-v2.py import \
    --bundle ~/Downloads/thread-bundle.json \
    --target-workspace ~/.t3/scratch/2026-10-20-what-has-taken-80-of-48590673
```

The output should list roughly:

```
  t3.orchestration_v2_projection_threads: 1 rows
  t3.orchestration_v2_projection_messages: 242 rows
  t3.orchestration_v2_projection_turn_items: 820 rows
  t3.orchestration_events: 14575 rows
  opencode.session_message: 380 rows
```

## Restart and check

```bash
systemctl --user restart opencode oc-shim
pm2 restart t3
```

The thread should appear in T3 Code with its title, its messages and the tool
calls it made. The scratch workspace path on the MacBook is
`~/.t3/scratch/2026-10-20-what-has-taken-80-of-48590673`; the thread's own
worktree was on the VPS, so the files it edited are **not** on the MacBook -
they are in the GitHub repository.

## If something looks wrong

Roll back by restoring the backups:

```bash
cp ~/.t3/userdata/statev2.sqlite.bak-YYYYmmdd-HHMMSS ~/.t3/userdata/statev2.sqlite
cp ~/.local/share/opencode/opencode.db.bak-YYYYmmdd-HHMMSS ~/.local/share/opencode/opencode.db
```

and restart the app.

## The same thread without the database surgery

If you would rather not import the rows at all, the substance of the thread
is in `HANDOFF.md` and in the commit history of the repository:

```bash
git log --oneline
git show fb63eaa --stat
```

`HANDOFF.md` records what the run produced, every bug that was found and
fixed, and the order the remaining work has to happen in. The three commits
carry the whole change: the fixes, the notes, and this guide.
