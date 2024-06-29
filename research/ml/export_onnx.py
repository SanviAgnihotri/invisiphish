#!/usr/bin/env python3
"""
Export a saved Hugging Face checkpoint to ONNX for the browser and Node.

The training script can export directly, but converting separately is useful
when training was interrupted (for example by the MPS ONNX-export issue) and
the checkpoint itself is already on disk.

Usage:
    python research/ml/export_onnx.py --model-dir public/models/distilbert-phishing \
        --max-length 160
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import torch
from transformers import AutoModelForSequenceClassification, AutoTokenizer


def export_onnx(model, tokenizer, output_dir: Path, max_length: int) -> Path:
    onnx_dir = output_dir / "onnx"
    onnx_dir.mkdir(parents=True, exist_ok=True)

    # The model must be on the CPU for the ONNX exporter. Exporting a model
    # that still lives on an accelerator raises "Placeholder storage has not
    # been allocated".
    model = model.to('cpu')
    model.eval()

    sample = tokenizer(
        "Your account has been suspended, verify immediately.",
        truncation=True,
        padding="max_length",
        max_length=max_length,
        return_tensors="pt",
    )

    target = onnx_dir / "model.onnx"

    # The new dynamo exporter needs `onnxscript`, which is not part of a plain
    # torch install, so the legacy exporter is requested explicitly.
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
            print(f"onnx export attempt {kwargs or 'default'} failed: {error}", flush=True)

    raise SystemExit("ONNX export failed")


def quantise(onnx_path: Path) -> Path | None:
    try:
        from onnxruntime.onnxruntime_inference_collection import QuantFormat
        from onnxruntime.quantization import QuantType, quantize_dynamic
    except Exception:  # noqa: BLE001
        print("onnxruntime is not available, skipping quantisation")
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
        print(f"quantisation skipped: {error}")
        return None

    return target if target.exists() else None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-dir", default="public/models/distilbert-phishing")
    parser.add_argument("--max-length", type=int, default=160)
    args = parser.parse_args()

    model_dir = Path(args.model_dir)
    if not (model_dir / "config.json").exists():
        print(f"No checkpoint found at {model_dir}")
        return 1

    tokenizer = AutoTokenizer.from_pretrained(str(model_dir))
    model = AutoModelForSequenceClassification.from_pretrained(str(model_dir))

    onnx_path = export_onnx(model, tokenizer, model_dir, args.max_length)
    print(f"wrote {onnx_path} ({onnx_path.stat().st_size / 1e6:.1f} MB)")

    quantised = quantise(onnx_path)
    if quantised:
        print(f"wrote {quantised} ({quantised.stat().st_size / 1e6:.1f} MB)")

    manifest = {
        "model_dir": str(model_dir),
        "onnx": str(onnx_path.relative_to(model_dir)),
        "quantised": str(quantised.relative_to(model_dir)) if quantised else None,
        "max_length": args.max_length,
        "labels": model.config.id2label,
    }
    (model_dir / "export_manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
