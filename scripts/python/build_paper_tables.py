#!/usr/bin/env python3
"""
Generate the paper's tables from the evaluation output.

The tables are produced from `research/results/evaluation*.json` rather than typed by
hand, so they cannot drift away from the numbers the code actually produced.
Each table is written in the format used by the Springer LNCS template.

Usage:
    python scripts/python/build_paper_tables.py \
        --evaluation research/results/evaluation_sms.json \
        --baseline research/results/baseline_sms.json \
        --output research/paper/tables.md
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def fmt(value: float, digits: int = 2) -> str:
    return f"{value:.{digits}f}"


def load(path: str | None) -> dict | None:
    if not path:
        return None
    file = Path(path)
    if not file.exists():
        return None
    return json.loads(file.read_text(encoding="utf-8"))


def main_results_table(evaluation: dict, baseline: dict | None) -> str:
    """Table 1 - main results with and without baselines."""
    rows = evaluation["main_results"]
    variants = list(rows.keys())

    lines = [
        "| Model | Acc. (%) | Prec. (%) | Rec. (%) | F1 (%) | ROC-AUC |",
        "|---|---|---|---|---|---|",
    ]

    if baseline:
        for name, key in [
            ("Majority class", "majority_class_baseline"),
            ("TF-IDF + LinearSVC", "stratified_split"),
            ("TF-IDF char + LinearSVC", "balanced_split"),
        ]:
            entry = baseline.get(key)
            if not entry:
                continue
            lines.append(
                f"| {name} | {fmt(entry['accuracy'])} | {fmt(entry['precision'])} | "
                f"{fmt(entry['recall'])} | {fmt(entry['f1'])} | {fmt(entry['roc_auc'], 4)} |"
            )

    for variant in variants:
        row = rows[variant]
        std = row["f1"]["std"]
        std_note = f" $\\pm${fmt(std)}" if std > 0 else ""
        lines.append(
            f"| **{variant}** | {fmt(row['accuracy']['mean'])} | {fmt(row['precision']['mean'])} | "
            f"{fmt(row['recall']['mean'])} | {fmt(row['f1']['mean'])}{std_note} | "
            f"{fmt(row['roc_auc']['mean'], 4)} |"
        )

    return "\n".join(lines)


def ablation_table(evaluation: dict) -> str:
    """Table 2 - the corrected ablation."""
    rows = evaluation["main_results"]
    lines = [
        "| Variant | Acc. (%) | Prec. (%) | Rec. (%) | F1 (%) | ROC-AUC |",
        "|---|---|---|---|---|---|",
    ]
    for variant, row in rows.items():
        lines.append(
            f"| {variant} | {fmt(row['accuracy']['mean'])} | {fmt(row['precision']['mean'])} | "
            f"{fmt(row['recall']['mean'])} | {fmt(row['f1']['mean'])} | {fmt(row['roc_auc']['mean'], 4)} |"
        )
    return "\n".join(lines)


def weights_table(evaluation: dict) -> str:
    """The fitted fusion weights, per seed."""
    lines = [
        "| Seed | DistilBERT | URL intel. | FP-Growth | Intent |",
        "|---|---|---|---|---|",
    ]
    for entry in evaluation.get("fitted_weights", []):
        weights = {w["module"]: w["weight"] for w in entry["weights"]}
        lines.append(
            f"| {entry['seed']} | {fmt(weights.get('semantic', 0))} | "
            f"{fmt(weights.get('url-intel', 0))} | {fmt(weights.get('pattern', 0))} | "
            f"{fmt(weights.get('intent', 0))} |"
        )
    return "\n".join(lines)


def templates_table(evaluation: dict, limit: int = 12) -> str:
    """Table 3 - the mined recurring scam templates."""
    lines = [
        "| # | Recurring template | Malicious | Legitimate | Lift |",
        "|---|---|---|---|---|",
    ]
    for index, template in enumerate(evaluation.get("mined_templates", [])[:limit], start=1):
        lines.append(
            f"| {index} | `{template['template']}` | {template['spamSupport']} | "
            f"{template['hamSupport']} | {fmt(template['lift'], 1)} |"
        )
    return "\n".join(lines)


def latency_table(evaluation: dict) -> str:
    """Table 4 - system evaluation."""
    latency = evaluation.get("latency", {})
    labels = {
        "semantic": "DistilBERT (ONNX)",
        "url-intel": "URL intelligence",
        "pattern": "FP-Growth matching",
        "intent": "Intent analysis",
    }
    lines = ["| Module | Mean (ms) | p95 (ms) |", "|---|---|---|"]
    for module, label in labels.items():
        entry = latency.get(module)
        if not entry:
            continue
        lines.append(f"| {label} | {fmt(entry['mean'])} | {fmt(entry['p95'])} |")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evaluation", required=True)
    parser.add_argument("--baseline", default=None)
    parser.add_argument("--output", default="research/paper/tables.md")
    parser.add_argument("--title", default=None)
    args = parser.parse_args()

    evaluation = load(args.evaluation)
    if not evaluation:
        print(f"No evaluation file at {args.evaluation}")
        return 1
    baseline = load(args.baseline)

    # The corpus is named from the data that was evaluated, so a table can
    # never claim to be about a corpus it was not run on. The default used to
    # say "SMS Spam Collection" for every table, including the phishing one.
    title = args.title
    if title is None:
        dataset = str(evaluation.get("dataset", ""))
        if "phishing" in dataset.lower():
            title = "Phishing email corpus (primary corpus)"
        elif "sms" in dataset.lower():
            title = "SMS Spam Collection (baseline corpus)"
        else:
            title = dataset or "evaluation corpus"

    parts = [
        f"<!-- Generated by scripts/python/build_paper_tables.py from {Path(args.evaluation).name} -->",
        f"<!-- Corpus: {title} -->",
        "",
        "### Table 1. Detection performance on the test split",
        "",
        "Fusion weights fitted on the validation split; mean over "
        f"{len(evaluation.get('seeds', []))} seeds.",
        "",
        main_results_table(evaluation, baseline),
        "",
        "### Table 2. Module ablation",
        "",
        "Single-module and leave-one-out variants. The generative explanation "
        "module is not listed: it verbalises the evidence and cannot change a "
        "classification, so it has no accuracy to ablate.",
        "",
        ablation_table(evaluation),
        "",
        "### Table 3. Fitted fusion weights",
        "",
        weights_table(evaluation),
        "",
        "### Table 4. Recurring scam templates mined by FP-Growth",
        "",
        templates_table(evaluation),
        "",
        "### Table 5. System evaluation: per-module latency",
        "",
        latency_table(evaluation),
        "",
    ]

    output = ROOT / args.output
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text("\n".join(parts), encoding="utf-8")

    print(f"Wrote {output}")
    print("\n".join(parts[:40]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
