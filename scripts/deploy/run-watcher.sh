#!/usr/bin/env bash
# Loop so that a transient failure in the watcher never leaves the run
# unsupervised. The watcher exits non-zero on a kernel failure; the loop backs
# off and tries again.
set -uo pipefail
source "$HOME/.config/invisiphish/env" 2>/dev/null || true
# The watcher runs as a child process, so the configuration has to be exported
# rather than merely set.
export KAGGLE_API_TOKEN KAGGLE_BIN HEARTBEAT_TOPIC
cd "$HOME/invisiphish"

while true; do
  bash scripts/kaggle/kaggle-watch.sh >> "$HOME/invisiphish-logs/watcher.out" 2>&1
  echo "[$(date '+%F %T')] watcher exited with $? - restarting in 60s" \
    >> "$HOME/invisiphish-logs/watcher.out"
  sleep 60
done
