# ADR 0003: Fusion weights are fitted, not chosen

**Status:** accepted

## Context

The aggregation engine combines four module scores into one verdict. The
relative weight of each module decides how much each detector counts, so the
weights are a model, not a constant.

Hand-set weights turned out to be the single most damaging choice in the
system. With weights of 0.40 / 0.25 / 0.20 / 0.15 the full hybrid scored an F1
of 64.9 on the SMS corpus, because the two modules that had nothing to work
with dragged the average below the decision threshold. The same pipeline with
fitted weights scored 93.6.

## Decision

Fit the weights on a held-out validation split, by coordinate ascent on
validation F1, and report them alongside the hand-set defaults. The test split
is never seen during fitting.

## Consequences

* The fusion weights become a learned component with a protocol, not a
  preference, and they have to be reported.
* The harness has to carve a validation split out of the training data, which
  slightly reduces the amount of data available for training the semantic
  model.
* On a corpus where one module dominates, the fitter discovers that on its
  own. That is a result about the corpus, not a failure of the method, and it
  is exactly what the ablation table is for.
* The cost is negligible: fitting takes about a second per seed.
