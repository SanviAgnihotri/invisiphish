# ADR 0002: Explanations may only cite computed evidence

**Status:** accepted

## Context

The paper's explainability contribution is that a generative module explains a
detection "grounded strictly in features computed by InvisiPhish". A language
model given the raw message can produce a fluent, confident and completely
wrong explanation, and nothing in the system would notice.

## Decision

Two hard constraints:

1. The generative layer receives a **closed table of computed evidence**, never
   the raw message. Attacker-controlled text therefore never enters the prompt.
2. Every claim the model produces must cite the identifiers of the evidence it
   rests on. Claims whose citations do not resolve to a real evidence item are
   removed before the explanation is shown, and the groundedness of the
   explanation is reported alongside it.

The recommended actions shown to the user are drawn from a closed vocabulary
keyed to the kinds of evidence that justify them, so the model cannot invent
advice that no signal supports.

## Consequences

* Prompt injection at the explanation step is removed rather than mitigated:
  an injected instruction cannot produce a citation that resolves.
* The system can report how grounded an explanation is, which turns the
  explainability claim into a measurable quantity. A generative module that
  cannot be grounded is not worth having.
* The explanation layer cannot mention anything the detector did not compute,
  which is a real limitation: it cannot offer the kind of open-ended advice a
  general assistant would.
