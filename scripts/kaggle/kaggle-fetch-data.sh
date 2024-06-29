#!/usr/bin/env bash
#
# Download a Kaggle dataset into research/ml/datasets/raw.
#
# Usage:
#   scripts/kaggle/kaggle-fetch-data.sh <owner/dataset> [output-name]
#
# Example:
#   scripts/kaggle/kaggle-fetch-data.sh nasirfazil/phishingemaildataset phishing-emails

set -euo pipefail

KAGGLE="${KAGGLE_BIN:-$HOME/Library/Python/3.9/bin/kaggle}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RAW_DIR="$ROOT/ml/datasets/raw"

DATASET="${1:-}"
NAME="${2:-$(basename "${DATASET:-dataset}")}"

if [[ -z "$DATASET" ]]; then
  echo "Usage: scripts/kaggle/kaggle-fetch-data.sh <owner/dataset> [output-name]" >&2
  exit 1
fi

if [[ ! -f "$HOME/.research/kaggle/kaggle.json" ]]; then
  echo "No Kaggle credentials found at ~/.research/kaggle/kaggle.json" >&2
  exit 1
fi

mkdir -p "$RAW_DIR/$NAME"

echo "==> Downloading $DATASET"
"$KAGGLE" datasets download -d "$DATASET" -p "$RAW_DIR/$NAME" --unzip

echo "==> Saved to research/ml/datasets/raw/$NAME"
find "$RAW_DIR/$NAME" -maxdepth 2 -type f | head -20
