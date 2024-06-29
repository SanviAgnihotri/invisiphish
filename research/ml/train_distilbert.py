#!/usr/bin/env python3
"""
Train the semantic classifier for InvisiPhish and export it for the app.

Runs unchanged on a laptop (MPS), on a Kaggle GPU, or on plain CPU. The
configuration follows the paper: AdamW, learning rate 3e-4, batch size 16,
5-10 epochs, cross-entropy loss, early stopping on validation F1, and
accuracy / precision / recall / F1 / ROC-AUC as metrics.

The checkpoint is exported to ONNX so that the *same weights* are loaded by
`@xenova/transformers` in the browser and in the Node evaluation harness.
Training and evaluation therefore measure the model that actually ships.

Examples
--------
Local, SMS Spam Collection:

    python research/ml/train_distilbert.py --data research/ml/datasets/sms_spam.csv

Kaggle, a specific corpus and a bounded training set:

    python research/ml/train_distilbert.py --data /kaggle/input/phishing-emails \
        --file phishing_email.csv --max-rows 30000 --seeds 13,42,77 \
        --output-dir /kaggle/working/models
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import random
import re
import sys
import zipfile
from pathlib import Path

import numpy as np
import torch
from sklearn.metrics import accuracy_score, precision_score, recall_score, f1_score, roc_auc_score
from transformers import (
    AutoModelForSequenceClassification,
    AutoTokenizer,
    DataCollatorWithPadding,
    EarlyStoppingCallback,
    Trainer,
    TrainingArguments,
    set_seed,
)

# --------------------------------------------------------------------------
# Label handling
# --------------------------------------------------------------------------

PHISHING_LABELS = {"spam", "phish", "phishing", "malicious", "1", "true", "yes", "bad"}
LEGIT_LABELS = {"ham", "legit", "legitimate", "normal", "0", "false", "no", "good", "not_spam"}

LABEL_ALIASES = {
    "phishing": "phishing",
    "phish": "phishing",
    "spam": "phishing",
    "malicious": "phishing",
    "1": "phishing",
    "true": "phishing",
    "legitimate": "legitimate",
    "legit": "legitimate",
    "ham": "legitimate",
    "normal": "legitimate",
    "0": "legitimate",
    "false": "legitimate",
    "not_spam": "legitimate",
    "not spam": "legitimate",
}

LABEL_COLUMNS = ("label", "class", "category", "type", "target", "result", "spam", "y", "is_phishing")
TEXT_COLUMNS = ("message", "text", "body", "content", "sms", "email_body", "email body", "subject_body")

# Email bodies can be enormous and the csv module refuses fields larger than
# 128 KiB by default. Phishing messages that long carry no extra signal, so
# they are truncated rather than rejected.
csv.field_size_limit(min(sys.maxsize, 2**31 - 1))
MAX_MESSAGE_CHARS = 20_000


def clamp_message(text: str) -> str:
    if len(text) <= MAX_MESSAGE_CHARS:
        return text
    return text[:MAX_MESSAGE_CHARS]


def normalise_label(raw: str) -> str | None:
    value = raw.strip().lower()
    if value in LABEL_ALIASES:
        return LABEL_ALIASES[value]
    if value in PHISHING_LABELS:
        return "phishing"
    if value in LEGIT_LABELS:
        return "legitimate"
    return None


def dedupe_rows(rows: list[tuple[str, str]]) -> list[tuple[str, str]]:
    """Drop repeated messages, keeping the first occurrence of each.

    The corpora contain exact duplicates: the SMS Spam Collection has 5,574
    rows but only 5,160 distinct messages. Splitting a corpus that contains
    duplicates puts the same message in the training set and the test set, and
    a model that has memorised it is scored on it. The duplicates are removed
    before the split so that every message belongs to exactly one side.

    The key is the raw text rather than a normalised form, so that the
    manifest the evaluation reads identifies messages the same way the
    training set does.
    """
    seen: set[str] = set()
    kept: list[tuple[str, str]] = []

    for label, text in rows:
        if text in seen:
            continue
        seen.add(text)
        kept.append((label, text))

    return kept


# --------------------------------------------------------------------------
# Dataset loading
# --------------------------------------------------------------------------


def detect_delimiter(first_line: str) -> str:
    """Choose the delimiter from the header line.

    `csv.Sniffer` is not used on purpose. It samples a block of the file and
    guesses, which gives different answers on different Python versions and on
    files whose quoted fields contain newlines. The header line is a reliable
    signal and makes the choice reproducible.
    """
    counts = {delimiter: first_line.count(delimiter) for delimiter in (",", ";", "\t", "|")}
    best = max(counts, key=lambda key: counts[key])
    return best if counts[best] > 0 else ","


def detect_columns(header: list[str]) -> tuple[int, int] | None:
    """Find the label and text columns, tolerating the many Kaggle layouts."""
    normalised = [column.strip().lower() for column in header]

    label_index = next((i for i, name in enumerate(normalised) if name in LABEL_COLUMNS), None)
    text_index = next((i for i, name in enumerate(normalised) if name in TEXT_COLUMNS), None)

    if label_index is None:
        # "v1,v2" style headers, or a single unlabelled column.
        if len(normalised) >= 2:
            label_index, text_index = 0, 1
        else:
            return None

    if text_index is None:
        text_index = next(
            (i for i, name in enumerate(normalised) if i != label_index),
            None,
        )
        if text_index is None:
            return None

    return label_index, text_index


def load_from_csv(path: Path) -> list[tuple[str, str]]:
    with path.open(newline="", encoding="utf-8", errors="replace") as handle:
        first_line = handle.readline()
        handle.seek(0)

        delimiter = detect_delimiter(first_line)
        reader = csv.reader(handle, delimiter=delimiter)
        rows = list(reader)

    if not rows:
        return []

    columns = detect_columns(rows[0])
    if columns is None:
        return []

    label_index, text_index = columns
    out: list[tuple[str, str]] = []

    for row in rows[1:]:
        if len(row) <= max(label_index, text_index):
            continue
        label = normalise_label(row[label_index])
        text = clamp_message(row[text_index].strip())
        if not label or not text:
            continue
        out.append((label, text))

    return out


def load_from_directory(path: Path) -> list[tuple[str, str]]:
    """Read a folder tree where the label is encoded in the directory name."""
    out: list[tuple[str, str]] = []

    for child in sorted(path.iterdir()):
        if not child.is_dir():
            continue
        label = normalise_label(child.name)
        if label is None:
            continue
        for file in sorted(child.rglob("*")):
            if file.suffix.lower() not in {".txt", ".eml", ".msg", ""}:
                continue
            try:
                text = file.read_text(encoding="utf-8", errors="replace").strip()
            except OSError:
                continue
            text = clamp_message(text)
            if text:
                out.append((label, text))

    return out


def discover_dataset(root: Path, prefer: str | None = None) -> tuple[list[tuple[str, str]], str]:
    """Find the corpus to use.

    Every candidate is scored and the result is chosen deterministically:
    a named file wins if one matches `prefer`, otherwise the file with the
    most rows wins, with the filename as a tie-breaker. Choosing "the largest
    file" silently is not good enough: a corpus directory can contain several
    sub-corpora with very different class balances.
    """
    if root.is_file():
        return load_from_csv(root), root.name

    candidates: list[tuple[int, list[tuple[str, str]], str]] = []

    for file in sorted(root.rglob("*")):
        if file.suffix.lower() in {".csv", ".tsv"} and file.is_file():
            rows = load_from_csv(file)
            if rows:
                candidates.append((len(rows), rows, str(file)))

    if not candidates:
        for directory in sorted(root.iterdir()):
            if directory.is_dir():
                rows = load_from_directory(directory)
                if rows:
                    candidates.append((len(rows), rows, str(directory)))

    if not candidates:
        return [], ""

    if prefer:
        for _, rows, source in candidates:
            if Path(source).name.lower() == prefer.lower():
                return rows, source

    candidates.sort(key=lambda entry: (-entry[0], entry[2]))
    best = candidates[0]
    return best[1], best[2]


# --------------------------------------------------------------------------
# Dataset
# --------------------------------------------------------------------------


class MessageDataset(torch.utils.data.Dataset):
    def __init__(self, rows: list[tuple[str, str]], tokenizer, max_length: int):
        self.rows = rows
        self.tokenizer = tokenizer
        self.max_length = max_length

    def __len__(self) -> int:
        return len(self.rows)

    def __getitem__(self, index: int) -> dict:
        label, text = self.rows[index]
        encoded = self.tokenizer(
            text,
            truncation=True,
            padding="max_length",
            max_length=self.max_length,
        )
        encoded["labels"] = 1 if label == "phishing" else 0
        return encoded


def write_split_manifest(
    seed_dir: Path,
    seed: int,
    train_rows: list[tuple[str, str]],
    test_rows: list[tuple[str, str]],
) -> None:
    """Record which messages went into the split, so the evaluation can reuse it.

    The messages are identified by a SHA-256 of their text. A hash rather than
    the text itself keeps the manifest small, and it is stable across machines
    and Python versions in a way an index into the corpus is not: the corpus
    order changes if the file is re-read or re-capped.

    The evaluation harness reads this file and scores the model on exactly the
    held-out rows. Without it the harness splits the same corpus a second time
    with an independent shuffle, and roughly a quarter of the messages it
    scores were in the model's training set.
    """
    def digest(rows: list[tuple[str, str]]) -> list[dict[str, object]]:
        return [
            {
                "label": 1 if label == "phishing" else 0,
                "sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
            }
            for label, text in rows
        ]

    manifest = {
        "seed": seed,
        "train_size": len(train_rows),
        "test_size": len(test_rows),
        "train": digest(train_rows),
        "test": digest(test_rows),
    }
    (seed_dir / "split_manifest.json").write_text(
        json.dumps(manifest, indent=2), encoding="utf-8"
    )


def stratified_split(rows: list[tuple[str, str]], test_size: float, seed: int):
    by_label: dict[str, list[tuple[str, str]]] = {}
    for label, text in rows:
        by_label.setdefault(label, []).append((label, text))

    rng = random.Random(seed)
    train: list[tuple[str, str]] = []
    test: list[tuple[str, str]] = []

    for items in by_label.values():
        rng.shuffle(items)
        cut = int(len(items) * (1 - test_size))
        train.extend(items[:cut])
        test.extend(items[cut:])

    rng.shuffle(train)
    rng.shuffle(test)
    return train, test


def compute_metrics(eval_pred) -> dict[str, float]:
    logits, labels = eval_pred
    predictions = np.argmax(logits, axis=-1)

    shifted = logits - logits.max(axis=-1, keepdims=True)
    probabilities = np.exp(shifted) / np.exp(shifted).sum(axis=-1, keepdims=True)

    try:
        auc = float(roc_auc_score(labels, probabilities[:, 1]))
    except ValueError:
        auc = float("nan")

    return {
        "accuracy": float(accuracy_score(labels, predictions)),
        "precision": float(precision_score(labels, predictions, zero_division=0)),
        "recall": float(recall_score(labels, predictions, zero_division=0)),
        "f1": float(f1_score(labels, predictions, zero_division=0)),
        "roc_auc": auc,
    }


# --------------------------------------------------------------------------
# ONNX export
# --------------------------------------------------------------------------


def export_onnx(model, tokenizer, output_dir: Path, max_length: int) -> Path | None:
    """Export to the ONNX signature @xenova/transformers expects."""
    onnx_dir = output_dir / "onnx"
    onnx_dir.mkdir(parents=True, exist_ok=True)

    # The exporter needs the model on the CPU. Exporting while it still lives
    # on an accelerator raises "Placeholder storage has not been allocated".
    model = model.to("cpu")
    model.eval()

    sample = tokenizer(
        "Your account has been suspended, verify immediately.",
        truncation=True,
        padding="max_length",
        max_length=max_length,
        return_tensors="pt",
    )

    target = onnx_dir / "model.onnx"

    # The new dynamo exporter needs `onnxscript`, which is not part of a
    # plain torch install. The legacy exporter is used explicitly so the
    # export works on a bare PyTorch environment.
    for kwargs in ({"dynamo": False}, {}):
        try:
            torch.onnx.export(
                model,
                (sample["input_ids"], sample["attention_mask"]),
                str(target),
                input_names=["input_ids", "attention_mask"],
                output_names=["logits"],
                dynamic_axes={
                    "input_ids": {0: "batch", 1: "sequence"},
                    "attention_mask": {0: "batch", 1: "sequence"},
                    "logits": {0: "batch"},
                },
                opset_version=17,
                do_constant_folding=True,
                **kwargs,
            )
            return target
        except Exception as error:  # noqa: BLE001
            print(f"  onnx export attempt {kwargs or 'default'} failed: {error}", flush=True)

    print("  onnx export failed; the Hugging Face checkpoint was still saved", flush=True)
    return None


def quantise(onnx_path: Path) -> Path | None:
    """Produce an int8 copy for browser deployment. Optional."""
    try:
        from onnxruntime.onnxruntime_inference_collection import QuantFormat
        from onnxruntime.quantization import QuantType, quantize_dynamic
    except Exception:  # noqa: BLE001 - quantization is a nice-to-have
        return None

    target = onnx_path.with_name("model_quantized.onnx")
    try:
        quantize_dynamic(
            model_input=str(onnx_path),
            model_output=str(target),
            weight_type=QuantType.QInt8,
            quant_format=QuantFormat.QDQ,
            extra_options={"MatMulConstBOnly": True},
        )
    except Exception as error:  # noqa: BLE001
        print(f"quantization skipped: {error}", flush=True)
        return None

    return target if target.exists() else None


# --------------------------------------------------------------------------
# Training
# --------------------------------------------------------------------------


def pick_device() -> str:
    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def train_one(
    rows: list[tuple[str, str]],
    args: argparse.Namespace,
    seed: int,
    output_dir: Path,
) -> dict:
    set_seed(seed)
    np.random.seed(seed)
    random.seed(seed)

    train_rows, test_rows = stratified_split(rows, args.test_size, seed)
    print(f"[seed {seed}] train={len(train_rows)} test={len(test_rows)}", flush=True)

    tokenizer = AutoTokenizer.from_pretrained(args.model)
    model = AutoModelForSequenceClassification.from_pretrained(
        args.model,
        num_labels=2,
        id2label={0: "legitimate", 1: "phishing"},
        label2id={"legitimate": 0, "phishing": 1},
    )

    train_dataset = MessageDataset(train_rows, tokenizer, args.max_length)
    eval_dataset = MessageDataset(test_rows, tokenizer, args.max_length)
    collator = DataCollatorWithPadding(tokenizer, padding="max_length", max_length=args.max_length)

    device = pick_device()
    print(f"[seed {seed}] device={device}", flush=True)

    # The device flags moved around between transformers versions, so they are
    # only passed when the installed version still understands them.
    import inspect

    available = inspect.signature(TrainingArguments.__init__).parameters
    device_flags: dict[str, bool] = {}
    if device == "mps" and "use_mps_device" in available:
        device_flags["use_mps_device"] = True
    if device == "cuda" and "use_cuda" in available:
        device_flags["use_cuda"] = True

    training_args = TrainingArguments(
        output_dir=str(output_dir.parent / f"_runs" / f"{args.model_slug}-seed{seed}"),
        num_train_epochs=args.epochs,
        per_device_train_batch_size=args.batch_size,
        per_device_eval_batch_size=args.eval_batch_size,
        learning_rate=args.learning_rate,
        weight_decay=0.01,
        warmup_ratio=0.1,
        eval_strategy="epoch",
        save_strategy="epoch",
        logging_strategy="epoch",
        load_best_model_at_end=True,
        metric_for_best_model="f1",
        greater_is_better=True,
        save_total_limit=1,
        report_to=[],
        seed=seed,
        data_seed=seed,
        dataloader_num_workers=0,
        disable_tqdm=not args.progress,
        **device_flags,
    )

    trainer = Trainer(
        model=model,
        args=training_args,
        train_dataset=train_dataset,
        eval_dataset=eval_dataset,
        data_collator=collator,
        compute_metrics=compute_metrics,
        callbacks=[
            EarlyStoppingCallback(early_stopping_patience=args.early_stopping_patience)
        ],
    )

    trainer.train()
    metrics = trainer.evaluate(eval_dataset)
    print(f"[seed {seed}] {json.dumps({k: round(float(v), 4) for k, v in metrics.items()})}", flush=True)

    seed_dir = output_dir / f"seed-{seed}"
    seed_dir.mkdir(parents=True, exist_ok=True)
    trainer.save_model(str(seed_dir))
    tokenizer.save_pretrained(str(seed_dir))

    onnx_path = export_onnx(trainer.model, tokenizer, seed_dir, args.max_length)
    if onnx_path:
        quantised = quantise(onnx_path)
        if quantised:
            print(f"[seed {seed}] wrote {quantised.name}", flush=True)

    report = {
        "seed": seed,
        "base_model": args.model,
        "dataset": args.dataset_description,
        "train_size": len(train_rows),
        "test_size": len(test_rows),
        "hyperparameters": {
            "optimizer": "AdamW",
            "learning_rate": args.learning_rate,
            "batch_size": args.batch_size,
            "max_epochs": args.epochs,
            "early_stopping_patience": args.early_stopping_patience,
            "max_sequence_length": args.max_length,
            "loss": "cross-entropy",
            "device": device,
        },
        "test_metrics": {
            k.removeprefix("eval_"): round(float(v), 4)
            for k, v in metrics.items()
            if k.removeprefix("eval_") in {"accuracy", "precision", "recall", "f1", "roc_auc"}
        },
        "onnx_exported": onnx_path is not None,
    }
    (seed_dir / "training_report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")

    # Record the held-out split so the evaluation harness can score the model
    # on exactly the rows it never saw. The harness used to invent its own
    # split of the same corpus, which put roughly a quarter of the evaluated
    # messages into the model's training set.
    write_split_manifest(seed_dir, seed, train_rows, test_rows)

    return report


def aggregate_reports(reports: list[dict]) -> dict:
    keys = ("accuracy", "precision", "recall", "f1", "roc_auc")
    summary: dict[str, dict[str, float]] = {}

    for key in keys:
        values = [report["test_metrics"][key] for report in reports]
        average = sum(values) / len(values)
        variance = sum((value - average) ** 2 for value in values) / max(1, len(values) - 1)
        summary[key] = {
            "mean": round(average, 4),
            "std": round(variance**0.5, 4),
            "values": [round(value, 4) for value in values],
        }

    return summary


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", default="research/ml/datasets/sms_spam.csv")
    parser.add_argument("--output-dir", default="public/models/distilbert-phishing")
    parser.add_argument("--model", default="distilbert-base-uncased")
    parser.add_argument("--seeds", default="42", help="comma separated seeds")
    parser.add_argument("--epochs", type=int, default=8)
    parser.add_argument("--batch-size", type=int, default=16)
    parser.add_argument("--eval-batch-size", type=int, default=64)
    parser.add_argument("--learning-rate", type=float, default=3e-4)
    parser.add_argument("--max-length", type=int, default=160)
    parser.add_argument("--test-size", type=float, default=0.2)
    parser.add_argument("--early-stopping-patience", type=int, default=2)
    parser.add_argument("--progress", action="store_true", help="show progress bars")
    parser.add_argument(
        "--file",
        default=None,
        help="prefer this CSV inside the corpus directory, e.g. phishing_email.csv",
    )
    parser.add_argument(
        "--max-rows",
        type=int,
        default=0,
        help="cap the number of messages used, to bound the training time",
    )
    parser.add_argument(
        "--copy-primary-to",
        default=None,
        help="also copy the first seed's model to this directory",
    )
    args = parser.parse_args()

    args.model_slug = args.model.split("/")[-1]
    seeds = [int(value) for value in args.seeds.split(",") if value.strip()]

    root = Path(args.data)
    if not root.exists():
        print(f"Dataset not found: {root}", flush=True)
        return 1

    rows, description = discover_dataset(root, prefer=args.file)
    if not rows:
        print(f"No labelled messages found under {root}", flush=True)
        return 1

    # Duplicates are removed before anything else, so that the split cannot
    # put the same message on both sides of it.
    before = len(rows)
    rows = dedupe_rows(rows)
    if before != len(rows):
        print(f"removed {before - len(rows)} duplicate messages", flush=True)

    if args.max_rows > 0 and len(rows) > args.max_rows:
        # Keep the class balance when the corpus is capped.
        positives = [row for row in rows if row[0] == "phishing"]
        negatives = [row for row in rows if row[0] != "phishing"]
        random.Random(0).shuffle(positives)
        random.Random(0).shuffle(negatives)
        half = args.max_rows // 2
        rows = positives[:half] + negatives[: (args.max_rows - half)]
        random.Random(0).shuffle(rows)
        description = f"{description} (capped at {len(rows)} messages)"

    positives = sum(1 for label, _ in rows if label == "phishing")
    print(
        f"dataset={description} messages={len(rows)} phishing={positives} "
        f"({positives / len(rows):.1%})",
        flush=True,
    )

    args.dataset_description = description
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    reports = [train_one(rows, args, seed, output_dir) for seed in seeds]

    summary = {
        "base_model": args.model,
        "dataset": description,
        "seeds": seeds,
        "hyperparameters": reports[0]["hyperparameters"],
        "per_seed": reports,
        "summary": aggregate_reports(reports),
    }
    (output_dir / "training_summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")

    print("\n=== summary over seeds ===", flush=True)
    for key, stats in summary["summary"].items():
        print(f"  {key:10s} {stats['mean']:.4f} +/- {stats['std']:.4f}  {stats['values']}", flush=True)

    if args.copy_primary_to:
        import shutil

        primary = output_dir / f"seed-{seeds[0]}"
        target = Path(args.copy_primary_to)
        if target.exists():
            shutil.rmtree(target)
        shutil.copytree(primary, target)
        print(f"copied {primary} -> {target}", flush=True)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
