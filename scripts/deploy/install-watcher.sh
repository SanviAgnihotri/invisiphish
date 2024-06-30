#!/usr/bin/env bash
#
# Install the InvisiPhish control plane on the VPS.
#
# The VPS is the control plane, not the compute node. It holds the code and the
# credentials, and it watches the Kaggle kernel so that the run keeps being
# supervised without the laptop having to stay awake.
#
# Everything that actually runs a model stays on Kaggle.
#
# Run it on the VPS, or over ssh:
#   ssh av@100.95.166.116 'bash -s' < scripts/deploy/install-watcher.sh

set -euo pipefail

APP_DIR="${APP_DIR:-$HOME/invisiphish}"
LOG_DIR="${LOG_DIR:-$HOME/invisiphish-logs}"
CONFIG_DIR="${CONFIG_DIR:-$HOME/.config/invisiphish}"
VENV_DIR="${VENV_DIR:-$HOME/.venvs/kaggle}"
KAGGLE_API_TOKEN="${KAGGLE_API_TOKEN:-}"

echo "==> directories"
mkdir -p "$APP_DIR" "$LOG_DIR" "$CONFIG_DIR" "$HOME/.kaggle"
chmod 700 "$CONFIG_DIR"

# --- Kaggle CLI ------------------------------------------------------------
# The current Kaggle CLI needs Python 3.9 or newer, which the VPS has. It is
# installed into the user site-packages because `python3-venv` is not present
# on the image and installing it would need root.
KAGGLE_BIN=""

if ! python3 -c "import kaggle" >/dev/null 2>&1; then
  echo "==> installing the Kaggle CLI"
  if ! python3 -m pip install --quiet --user --upgrade kaggle kagglehub; then
    python3 -m pip install --quiet --user --break-system-packages --upgrade kaggle kagglehub
  fi
fi

for candidate in "$HOME/.local/bin/kaggle" "$HOME/bin/kaggle" "$(command -v kaggle || true)"; do
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then
    KAGGLE_BIN="$candidate"
    break
  fi
done

if [ -z "$KAGGLE_BIN" ]; then
  echo "!! the Kaggle CLI could not be installed, the watcher will not work" >&2
  exit 1
fi

echo "==> kaggle CLI: $KAGGLE_BIN"

# --- credentials -----------------------------------------------------------
if [ -n "$KAGGLE_API_TOKEN" ]; then
  echo "==> writing the Kaggle token"
  printf '%s' "$KAGGLE_API_TOKEN" > "$HOME/.research/kaggle/access_token"
  chmod 600 "$HOME/.research/kaggle/access_token"

  cat > "$CONFIG_DIR/env" <<ENVFILE
# InvisiPhish control plane configuration.
# 600, never committed.
KAGGLE_API_TOKEN=$KAGGLE_API_TOKEN
KAGGLE_BIN=$KAGGLE_BIN
HEARTBEAT_TOPIC=invisiphish-kaggle-v1
ENVFILE
  chmod 600 "$CONFIG_DIR/env"
else
  echo "==> KAGGLE_API_TOKEN not supplied, the watcher will not authenticate"
fi

# --- the other secrets, for the application itself -------------------------
# These are not needed to watch a Kaggle run, but they belong on the server
# rather than on a laptop that gets lost.
if [ ! -f "$APP_DIR/.env.local" ]; then
  cat > "$APP_DIR/.env.local" <<'ENVFILE'
# Neon (Postgres). DATABASE_URL must use a role WITHOUT BYPASSRLS.
DATABASE_URL=
DATABASE_ADMIN_URL=
NEON_AUTH_BASE_URL=

# Generative explanation layer, server-side only.
GEMINI_API_KEY=
GEMINI_MODEL=gemini-3.8-flash

MODEL_DIR=./public/models/
ENVFILE
  chmod 600 "$APP_DIR/.env.local"
fi

# --- the watcher, kept alive by cron ---------------------------------------
echo "==> installing the watcher"

cat > "$APP_DIR/scripts/vps/run-watcher.sh" <<'RUNNER'
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
RUNNER
chmod +x "$APP_DIR/scripts/vps/run-watcher.sh"

# cron keeps the loop alive across reboots and accidental kills.
CRON_LINE="*/5 * * * * pgrep -f 'run-watcher.sh' >/dev/null 2>&1 || (setsid nohup $APP_DIR/scripts/vps/run-watcher.sh >> $LOG_DIR/watcher.out 2>&1 &)"

if crontab -l 2>/dev/null | grep -q "run-watcher.sh"; then
  crontab -l 2>/dev/null | grep -v "run-watcher.sh" | crontab -
fi
(crontab -l 2>/dev/null; echo "$CRON_LINE") | crontab -

if ! pgrep -f "run-watcher.sh" >/dev/null 2>&1; then
  setsid nohup "$APP_DIR/scripts/vps/run-watcher.sh" >> "$LOG_DIR/watcher.out" 2>&1 &
  sleep 2
fi

echo "==> watcher state"
pgrep -af "run-watcher.sh" || echo "  (not running)"
echo "==> logs: $LOG_DIR/watcher.out"
