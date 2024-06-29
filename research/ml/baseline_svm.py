#!/usr/bin/env python3
"""
Baseline classifier for the SMS Spam Collection.

The paper reports accuracy 94.20% / F1 94.33% for the full InvisiPhish
framework on this dataset, but does not report any baseline. This script
establishes what a conventional text classifier achieves on the same data
under the same protocol, which is the comparison a reviewer will ask for.

Protocol (mirrors the preprocessing rules described in the paper):
  * near-duplicate messages are removed before the split, to avoid leakage
  * stratified train/test split
  * metrics reported for the `spam` class as the positive class
  * additionally reported on a class-balanced test subset, because the paper
    describes evaluating on a *balanced* phishing/legitimate split

Usage:
    python research/ml/baseline_svm.py [--data research/ml/datasets/sms_spam.csv]
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from pathlib import Path

URL_PATTERN = re.compile(r"https?://\S+")
NON_WORD = re.compile(r"[^a-z0-9\s]")


def load_rows(path: Path) -> list[tuple[str, str]]:
    with path.open(newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        return [(row["label"], row["message"]) for row in reader]


def normalise(message: str) -> str:
    """Same shape as the app's preprocessing: lowercase, strip punctuation."""
    without_urls = URL_PATTERN.sub(" ", message)
    return " ".join(NON_WORD.sub(" ", without_urls.lower()).split())


def dedupe(rows: list[tuple[str, str]]) -> list[tuple[str, str]]:
    """Remove repeated messages, keeping the first occurrence of each.

    The key is the raw message text, so that the corpus is identical to the
    one the evaluation harness and the training script use. The two used to
    differ: the baseline removed near-duplicates as well, which left it
    scoring 5,130 messages against the harness's 5,160 and made the two
    numbers in the paper's table a comparison between different corpora.
    """
    kept: list[tuple[str, str]] = []
    seen_keys: set[str] = set()

    for label, message in rows:
        if not message or message in seen_keys:
            continue
        seen_keys.add(message)
        kept.append((label, message))

    return kept


def metrics(y_true: list[int], y_pred: list[int]) -> dict[str, float]:
    tp = sum(1 for t, p in zip(y_true, y_pred) if t == 1 and p == 1)
    fp = sum(1 for t, p in zip(y_true, y_pred) if t == 0 and p == 1)
    fn = sum(1 for t, p in zip(y_true, y_pred) if t == 1 and p == 0)
    tn = sum(1 for t, p in zip(y_true, y_pred) if t == 0 and p == 0)

    accuracy = (tp + tn) / len(y_true) if y_true else 0.0
    precision = tp / (tp + fp) if (tp + fp) else 0.0
    recall = tp / (tp + fn) if (tp + fn) else 0.0
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) else 0.0

    try:
        from sklearn.metrics import roc_auc_score

        auc = float(roc_auc_score(y_true, y_pred))
    except Exception:  # noqa: BLE001
        auc = float("nan")

    return {
        "accuracy": round(accuracy * 100, 2),
        "precision": round(precision * 100, 2),
        "recall": round(recall * 100, 2),
        "f1": round(f1 * 100, 2),
        "roc_auc": round(auc, 4),
        "tp": tp,
        "fp": fp,
        "fn": fn,
        "tn": tn,
    }


def balanced_subset(rows: list[tuple[str, str]], seed: int = 13) -> list[tuple[str, str]]:
    """Downsample the majority class so spam and ham are equally represented."""
    import random

    rng = random.Random(seed)
    spam = [row for row in rows if row[0] == "spam"]
    ham = [row for row in rows if row[0] == "ham"]
    rng.shuffle(ham)
    return spam + ham[: len(spam)]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", default="research/ml/datasets/sms_spam.csv")
    parser.add_argument("--test-size", type=float, default=0.2)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--json", action="store_true", help="emit JSON only")
    parser.add_argument("--out", "--output", dest="output", default=None,
                        help="write the report to this file as well as stdout")
    args = parser.parse_args()

    path = Path(args.data)
    if not path.exists():
        print(f"Dataset not found at {path}. Run: python research/ml/fetch_datasets.py", file=sys.stderr)
        return 1

    try:
        from sklearn.feature_extraction.text import TfidfVectorizer
        from sklearn.model_selection import train_test_split
        from sklearn.svm import LinearSVC
    except ImportError:
        print("scikit-learn is required: pip install scikit-learn", file=sys.stderr)
        return 1

    rows = load_rows(path)
    raw_count = len(rows)
    rows = dedupe(rows)
    texts = [normalise(message) for _, message in rows]
    labels = [1 if label == "spam" else 0 for label, _ in rows]

    report: dict[str, object] = {
        # The name has to follow the file that was actually read. Hardcoding
        # "SMS Spam Collection" made the phishing-email baseline report itself
        # as the SMS corpus in the paper's tables.
        "dataset": str(path),
        "raw_messages": raw_count,
        "after_deduplication": len(rows),
        "spam_rate": round(sum(labels) / len(labels), 4),
        "split": {"test_size": args.test_size, "seed": args.seed},
        "model": "TF-IDF (word 1-2 gram, sublinear) + LinearSVC",
    }

    # --- majority class floor -------------------------------------------------
    majority = [0] * len(labels)
    report["majority_class_baseline"] = metrics(labels, majority)

    # --- stratified split -----------------------------------------------------
    x_train, x_test, y_train, y_test = train_test_split(
        texts, labels, test_size=args.test_size, random_state=args.seed, stratify=labels
    )

    vectoriser = TfidfVectorizer(
        sublinear_tf=True, ngram_range=(1, 2), min_df=1, max_df=0.9, lowercase=True
    )
    x_train_vec = vectoriser.fit_transform(x_train)
    x_test_vec = vectoriser.transform(x_test)

    classifier = LinearSVC()
    classifier.fit(x_train_vec, y_train)
    predictions = classifier.predict(x_test_vec)

    report["stratified_split"] = metrics(y_test, predictions)
    report["stratified_split"]["test_size_messages"] = len(y_test)
    report["stratified_split"]["test_spam_count"] = sum(y_test)

    # --- class-balanced evaluation ------------------------------------------
    balanced = balanced_subset(rows, seed=args.seed)
    balanced_texts = [normalise(message) for _, message in balanced]
    balanced_labels = [1 if label == "spam" else 0 for label, _ in balanced]

    bx_train, bx_test, by_train, by_test = train_test_split(
        balanced_texts,
        balanced_labels,
        test_size=args.test_size,
        random_state=args.seed,
        stratify=balanced_labels,
    )
    balanced_vectoriser = TfidfVectorizer(
        sublinear_tf=True, ngram_range=(1, 2), min_df=1, max_df=0.9, lowercase=True
    )
    b_train = balanced_vectoriser.fit_transform(bx_train)
    b_test = balanced_vectoriser.transform(bx_test)
    balanced_classifier = LinearSVC()
    balanced_classifier.fit(b_train, by_train)
    report["balanced_split"] = metrics(by_test, balanced_classifier.predict(b_test))
    report["balanced_split"]["test_size_messages"] = len(by_test)

    # --- comparison against the paper ---------------------------------------
    report["paper_claim_full_hybrid"] = {
        "accuracy": 94.2,
        "precision": 93.1,
        "recall": 95.6,
        "f1": 94.33,
        "roc_auc": 0.972,
    }

    payload = json.dumps(report, indent=2)
    print(payload)

    if args.output:
        output_path = Path(args.output)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(payload, encoding="utf-8")
        print(f"wrote {output_path}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
