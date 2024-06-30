#!/usr/bin/env bash
#
# Prepare the VPS: Node 22, the Python environment, and the directories the
# evaluation and the Kaggle watcher need.
#
# Run it on the VPS, or over ssh:
#   ssh av@100.95.166.116 'bash -s' < scripts/deploy/provision.sh

set -euo pipefail

APP_DIR="${APP_DIR:-$HOME/invisiphish}"
NODE_VERSION="${NODE_VERSION:-22.18.0}"
LOG_DIR="${LOG_DIR:-$HOME/invisiphish-logs}"

echo "==> user: $(whoami)  home: $HOME"

# --- Node 22 ---------------------------------------------------------------
if ! command -v node >/dev/null || [ "$(node -v | cut -d. -f1 | tr -d 'v')" -lt 20 ]; then
  echo "==> installing Node ${NODE_VERSION}"
  mkdir -p /opt/node
  curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" -o /tmp/node.tar.xz
  tar -xJf /tmp/node.tar.xz -C /opt/node --strip-components=1
  rm -f /tmp/node.tar.xz
  echo 'export PATH=/opt/node/bin:$PATH' >> "$HOME/.bashrc"
fi
export PATH=/opt/node/bin:$PATH
echo "==> node $(node -v)  npm $(npm --version)"

# --- Python environment ----------------------------------------------------
PYBIN="$(command -v python3.12 || command -v python3)"
echo "==> python: $($PYBIN -V)"

# --- directories -----------------------------------------------------------
mkdir -p "$APP_DIR" "$LOG_DIR" "$HOME/.config/invisiphish"
chmod 700 "$HOME/.config/invisiphish"

# --- install the project dependencies --------------------------------------
if [ -f "$APP_DIR/package.json" ]; then
  echo "==> npm install"
  cd "$APP_DIR"
  npm ci --no-audit --no-fund || npm install --no-audit --no-fund
fi

echo "==> provision complete"
