#!/usr/bin/env bash
#
# Sync the project to the VPS over Tailscale.
#
# node_modules, build output and the Hugging Face weights are excluded: the
# VPS installs its own dependencies and the ONNX export is all the evaluation
# needs.
#
# Usage:
#   scripts/deploy/sync.sh [user@host]

set -euo pipefail

REMOTE="${1:-av@100.95.166.116}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REMOTE_DIR="${REMOTE_DIR:-/home/$(echo "$REMOTE" | cut -d@ -f1)/invisiphish}"

echo "==> syncing $ROOT -> $REMOTE:$REMOTE_DIR"
rsync -az --delete \
  --exclude node_modules \
  --exclude dist \
  --exclude .git \
  --exclude artifacts \
  --exclude 'research/ml/datasets/raw' \
  --exclude '*.tsbuildinfo' \
  --exclude 'public/models/*/model.safetensors' \
  --exclude 'public/models/*/training_args.bin' \
  --exclude '.env.local' \
  "$ROOT/" "$REMOTE:$REMOTE_DIR/"

echo "==> done"
