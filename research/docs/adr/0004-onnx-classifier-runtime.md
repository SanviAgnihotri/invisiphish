# ADR 0004: One checkpoint, loaded identically in the browser and in the harness

**Status:** accepted

## Context

The paper claims a specific set of numbers. If the browser and the evaluation
harness load different weights, or different precisions, the numbers describe
a system nobody runs.

## Decision

Train the classifier in PyTorch, export it to ONNX, and load it in both places
with `@xenova/transformers`. The evaluation harness imports the same modules
from `src/lib/ml/` that the browser and the API use, and runs the same
`runSemanticModule` code path.

## Consequences

* Every reported figure is produced by the code that ships. The harness cannot
  drift away from the application because it is the application.
* The float32 export is 268 MB, which is too large to serve comfortably to a
  browser. An int8 export is produced alongside it; the browser and the
  server must then both use the int8 model, which is why the choice is an
  explicit flag rather than a default that differs by environment.
* The int8 export is produced by a separate step from training, because the
  exporter needs the model on the CPU and training runs on an accelerator.
  Exporting a model that still lives on an MPS device raises "Placeholder
  storage has not been allocated".
