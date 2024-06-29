#!/usr/bin/env bash
#
# Watch a Kaggle kernel until it finishes, then download the output.
#
# Three things are monitored:
#
#   1. the kernel status, polled through the Kaggle API
#   2. the notebook's heartbeat, published to ntfy.sh, so progress is visible
#      while the run is in flight (a running kernel does not expose its log)
#   3. the wall clock, so a run that has clearly stalled is flagged
#
# On failure the kernel log is fetched and the failing stage is printed, so
# the cause can be acted on immediately.
#
# Usage:
#   scripts/kaggle/kaggle-watch.sh [kernel-ref] [output-dir]
#
# Environment:
#   KAGGLE_API_TOKEN   required
#   HEARTBEAT_TOPIC    defaults to invisiphish-kaggle-v1
#   POLL_SECONDS       defaults to 60
#   STALL_MINUTES      defaults to 300 (flag a run that has not finished)

set -uo pipefail

KAGGLE="${KAGGLE_BIN:-}"
if [[ -z "$KAGGLE" ]]; then
  for candidate in "$HOME/.venvs/kaggle/bin/kaggle" "$HOME/.local/bin/kaggle" "$HOME/bin/kaggle"; do
    if [[ -x "$candidate" ]]; then KAGGLE="$candidate"; break; fi
  done
fi
if [[ -z "$KAGGLE" ]]; then
  KAGGLE="$(command -v kaggle || true)"
fi
if [[ -z "$KAGGLE" || ! -x "$KAGGLE" ]]; then
  echo "kaggle CLI not found" >&2
  exit 1
fi
PYTHON="${PYTHON:-/usr/bin/python3}"
REF="${1:-cptadityavyas/invisiphish-training-and-evaluation}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT_DIR="${2:-$ROOT/kaggle/output}"
LOG="${KAGGLE_WATCH_LOG:-$ROOT/kaggle/watch.log}"
POLL_SECONDS="${POLL_SECONDS:-60}"
STALL_MINUTES="${STALL_MINUTES:-300}"
HEARTBEAT_TOPIC="${HEARTBEAT_TOPIC:-invisiphish-kaggle-v1}"
AUTO_RETRY="${AUTO_RETRY:-1}"
MAX_RETRIES="${MAX_RETRIES:-2}"
RETRIES=0

mkdir -p "$OUTPUT_DIR" "$(dirname "$LOG")"

log() {
  echo "$(date '+%F %T') $*" >> "$LOG"
}

log "watching $REF (poll ${POLL_SECONDS}s, stall after ${STALL_MINUTES}m, log $LOG)"

START=$(date +%s)
LAST_BEAT=""

while true; do
  STATUS="$("$KAGGLE" kernels status "$REF" 2>&1 | tail -1)"
  ELAPSED=$(( ($(date +%s) - START) / 60 ))

  # Mirror the notebook's heartbeat into the local log.
  BEAT="$(curl -s --max-time 15 "https://ntfy.sh/${HEARTBEAT_TOPIC}/json?poll=1&since=10m" 2>/dev/null \
    | /usr/bin/python3 -c "
import sys, json
lines = []
for raw in sys.stdin:
    try:
        lines.append(json.loads(raw).get('message', ''))
    except Exception:
        pass
print(lines[-1] if lines else '')
" 2>/dev/null)"

  if [[ -n "$BEAT" && "$BEAT" != "$LAST_BEAT" ]]; then
    log "beat: $BEAT"
    LAST_BEAT="$BEAT"
  fi

  log "status: ${STATUS##*status } (${ELAPSED}m elapsed)"

  # The CLI reports the state as "KernelWorkerStatus.COMPLETE", so the match
  # has to be case-insensitive: testing for "Complete" never matches and the
  # watcher polls a finished kernel forever.
  if [[ "${STATUS^^}" == *"COMPLETE"* ]]; then
    log "completed, downloading output"
    "$PYTHON" "$ROOT/scripts/kaggle-fetch-output.py" \
      --kernel "$REF" --dest "$OUTPUT_DIR" >> "$LOG" 2>&1
    log "done -> $OUTPUT_DIR"
    exit 0
  fi

  if [[ "${STATUS^^}" == *"ERROR"* || "${STATUS^^}" == *"CANCELLED"* ]]; then
    log "FAILED, fetching the log"
    "$PYTHON" "$ROOT/scripts/kaggle-fetch-output.py" \
      --kernel "$REF" --dest "$OUTPUT_DIR" \
      --include '.*\.log$' --exclude '^_runs/' >> "$LOG" 2>&1

    log "---- failure summary ----"
    LOGFILE="$(ls -t "$OUTPUT_DIR"/*.log 2>/dev/null | head -1)"
    if [[ -n "$LOGFILE" ]]; then
      # The log is JSON lines; pull out the last error and the cell it failed in.
      /usr/bin/python3 - "$LOGFILE" >> "$LOG" 2>&1 <<'PY'
import json, re, sys
path = sys.argv[1]
messages = []
for raw in open(path, encoding="utf-8", errors="replace"):
    raw = raw.strip().lstrip(',')
    if not raw.startswith('{'):
        continue
    try:
        entry = json.loads(raw)
    except Exception:
        continue
    data = entry.get("data")
    if isinstance(data, str):
        messages.append((entry.get("stream_name", "?"), data))
for stream, data in messages[-40:]:
    print(f"  [{stream}] {data.rstrip()}")
PY
    fi
    log "---- end failure summary ----"

    # An infrastructure failure is worth retrying; a code failure is not.
    if [[ "$AUTO_RETRY" == "1" && $RETRIES -lt $MAX_RETRIES ]]; then
      if grep -qiE "connection reset|timed out|503|502|temporary failure|rate limit" "$LOGFILE" 2>/dev/null; then
        RETRIES=$((RETRIES + 1))
        log "transient failure detected, re-pushing (attempt $((RETRIES + 1)))"
        "$KAGGLE" kernels push -p "$ROOT/kaggle/kernel" >> "$LOG" 2>&1
        START=$(date +%s)
        sleep 30
        continue
      fi
    fi

    exit 1
  fi

  if [[ $ELAPSED -ge $STALL_MINUTES ]]; then
    log "WARNING: still running after ${ELAPSED} minutes. Last beat: ${LAST_BEAT:-none}"
  fi

  sleep "$POLL_SECONDS"
done
