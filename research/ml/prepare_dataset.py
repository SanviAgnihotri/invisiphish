#!/usr/bin/env python3
"""
Normalise any supported corpus into the `label,message` CSV the evaluation
harness reads.

The Kaggle phishing corpora arrive in several shapes: a single CSV, a folder
of `.txt` files whose parent directory names the class, or a CSV with
unconventional column names. The same loader the training script uses is
applied here, so training and evaluation always see identical data.

The corpus is chosen explicitly. A corpus directory can hold several
sub-corpora with very different class balances - the phishing email collection
ships seven files, including a preprocessed balanced combination of all of
them - and picking "the largest file" silently is not good enough.

Usage:
    python research/ml/prepare_dataset.py --data /kaggle/input/phishing-emails \
        --file phishing_email.csv --max-rows 30000 \
        --output research/ml/datasets/phishing_emails.csv
"""

from __future__ import annotations

import argparse
import csv
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from train_distilbert import discover_dataset, load_from_csv  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", default="research/ml/datasets/sms_spam.csv")
    parser.add_argument("--output", default="research/ml/datasets/phishing.csv")
    parser.add_argument("--file", default=None, help="prefer this CSV inside the corpus directory")
    parser.add_argument("--max-rows", type=int, default=0, help="cap the number of rows")
    args = parser.parse_args()

    root = Path(args.data)
    if not root.exists():
        print(f"Not found: {root}", file=sys.stderr)
        return 1

    # List the candidates so the choice is visible in the run log.
    if root.is_dir():
        print("candidates:")
        for csv_file in sorted(root.rglob("*")):
            if csv_file.suffix.lower() in {".csv", ".tsv"} and csv_file.is_file():
                try:
                    count = len(load_from_csv(csv_file))
                except Exception as error:  # noqa: BLE001
                    count = f"unreadable ({error.__class__.__name__})"
                print(f"  {csv_file}  rows={count}")

    rows, description = discover_dataset(root, prefer=args.file)
    if not rows:
        print(f"No labelled messages found under {root}", file=sys.stderr)
        return 1

    if args.max_rows > 0 and len(rows) > args.max_rows:
        import random

        positives = [row for row in rows if row[0] == "phishing"]
        negatives = [row for row in rows if row[0] != "phishing"]
        random.Random(0).shuffle(positives)
        random.Random(0).shuffle(negatives)
        half = args.max_rows // 2
        rows = positives[:half] + negatives[: (args.max_rows - half)]
        random.Random(0).shuffle(rows)

    positives = sum(1 for label, _ in rows if label == "phishing")
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)

    with output.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["label", "message"])
        for label, message in rows:
            writer.writerow(["spam" if label == "phishing" else "ham", message])

    print(f"source : {description}")
    print(f"rows   : {len(rows)}")
    print(f"phishing: {positives} ({positives / max(1, len(rows)):.1%})")
    print(f"written: {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
