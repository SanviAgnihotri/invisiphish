#!/usr/bin/env python3
"""
Download the SMS Spam Collection (Almeida, Gomez Hidalgo & Yamakami, 2011)
from the official UCI repository and normalise it into a single CSV.

The paper evaluates on this dataset as its baseline corpus, so being able to
re-fetch it exactly is a prerequisite for reproducing the reported numbers.

Usage:
    python research/ml/fetch_datasets.py [--output research/ml/datasets]

Output:
    research/ml/datasets/sms_spam.csv   columns: label,message   (label in {ham,spam})
"""

from __future__ import annotations

import argparse
import csv
import io
import sys
import urllib.request
import zipfile
from pathlib import Path

UCI_URL = "https://archive.ics.uci.edu/static/public/228/sms+spam+collection.zip"
INNER_FILE = "SMSSpamCollection"


def download(url: str) -> bytes:
    print(f"Downloading {url} ...")
    request = urllib.request.Request(url, headers={"User-Agent": "invisiphish/0.2"})
    with urllib.request.urlopen(request, timeout=120) as response:
        return response.read()


def parse_collection(raw: bytes) -> list[tuple[str, str]]:
    """The raw file is `label<TAB>message` with one message per line."""
    text = raw.decode("utf-8", errors="replace")
    rows: list[tuple[str, str]] = []

    for line in text.splitlines():
        if not line.strip():
            continue
        label, _, message = line.partition("\t")
        label = label.strip().lower()
        if label not in {"ham", "spam"}:
            continue
        rows.append((label, message.strip()))

    return rows


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", default="research/ml/datasets", help="output directory")
    args = parser.parse_args()

    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)
    target = output_dir / "sms_spam.csv"

    try:
        archive = download(UCI_URL)
    except Exception as error:  # noqa: BLE001 - surfaced to the operator
        print(f"Download failed: {error}", file=sys.stderr)
        return 1

    with zipfile.ZipFile(io.BytesIO(archive)) as bundle:
        name = next(
            (entry for entry in bundle.namelist() if entry.endswith(INNER_FILE)),
            None,
        )
        if name is None:
            print(f"Could not find {INNER_FILE} inside the archive", file=sys.stderr)
            return 1
        raw = bundle.read(name)

    rows = parse_collection(raw)
    if not rows:
        print("No rows parsed from the dataset", file=sys.stderr)
        return 1

    with target.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["label", "message"])
        writer.writerows(rows)

    spam = sum(1 for label, _ in rows if label == "spam")
    print(f"Wrote {len(rows)} messages to {target}")
    print(f"  spam: {spam} ({spam / len(rows):.1%})   ham: {len(rows) - spam}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
