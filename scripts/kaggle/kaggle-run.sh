#!/usr/bin/env bash
#
# Push the InvisiPhish training notebook to Kaggle, wait for the GPU run to
# finish, and download the exported model.
#
# Requirements:
#   * Kaggle credentials at ~/.research/kaggle/kaggle.json
#     (kaggle.com/settings -> API -> Create New Token)
#   * The repository reachable by the notebook. Either make it public on
#     GitHub and set REPO_URL inside the notebook, or upload the repository
#     as a Kaggle dataset named `invisiphish-repo` and point REPO_DIR at it.
#
# Usage:
#   scripts/kaggle/kaggle-run.sh [kaggle-username] [kernel-slug]
#
# Example:
#   scripts/kaggle/kaggle-run.sh your-username invisiphish-phishing-classifier

set -euo pipefail

KAGGLE="${KAGGLE_BIN:-$HOME/Library/Python/3.9/bin/kaggle}"
KERNEL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/kaggle/kernel"
OUTPUT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/kaggle/output"

USERNAME="${1:-${KAGGLE_USERNAME:-}}"
SLUG="${2:-invisiphish-phishing-classifier}"

if [[ ! -x "$KAGGLE" ]]; then
  echo "Kaggle CLI not found at $KAGGLE" >&2
  echo "Install it with: python3 -m pip install --user kaggle" >&2
  exit 1
fi

if [[ ! -f "$HOME/.research/kaggle/kaggle.json" ]]; then
  echo "No Kaggle credentials found at ~/.research/kaggle/kaggle.json" >&2
  echo "Create a token at https://www.kaggle.com/settings -> API -> Create New Token" >&2
  exit 1
fi

if [[ -z "$USERNAME" ]]; then
  echo "Usage: scripts/kaggle/kaggle-run.sh <kaggle-username> [kernel-slug]" >&2
  exit 1
fi

REF="$USERNAME/$SLUG"

echo "==> Pushing $KERNEL_DIR to Kaggle as $REF"
"$KAGGLE" kernels push -p "$KERNEL_DIR"

echo "==> Waiting for the GPU run to complete"
while true; do
  STATUS="$("$KAGGLE" kernels status "$REF" 2>&1 || true)"
  echo "    $STATUS"

  if [[ "$STATUS" == *"Complete"* ]]; then
    break
  fi

  if [[ "$STATUS" == *"Error"* || "$STATUS" == *"Cancelled"* ]]; then
    echo "Kernel failed. Fetch the log with:" >&2
    echo "  $KAGGLE kernels output $REF -p $OUTPUT_DIR" >&2
    exit 1
  fi

  sleep 60
done

echo "==> Downloading output to $OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"
"$KAGGLE" kernels output "$REF" -p "$OUTPUT_DIR"

echo "==> Done. Unpack the model into public/models:"
echo "    unzip $OUTPUT_DIR/invisiphish-model.zip -d public/models/"
