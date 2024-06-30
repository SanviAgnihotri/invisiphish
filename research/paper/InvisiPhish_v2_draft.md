# InvisiPhish — revised manuscript (v2)

> Working draft of the sections that change. Tables are **generated** from the
> evaluation output by `scripts/python/build_paper_tables.py`, so the numbers here can
> never drift away from what the code produced.
>
> - `research/paper/tables_sms.md` — generated from the SMS Spam Collection run
> - `research/paper/tables_phishing.md` — generated from the phishing email run
> - Regenerate with `python scripts/python/build_paper_tables.py --evaluation research/results/evaluation_sms.json --baseline research/results/baseline_sms.json --output research/paper/tables_sms.md`

---

## Title

**InvisiPhish: A Hybrid and Explainable Phishing Detection Framework Using FP-Growth, DistilBERT and Generative AI**

*(unchanged)*

---

## Abstract

Phishing and smishing attacks are increasingly effective because they exploit
human behaviour using persuasive language, urgency, impersonation and obfuscated
URLs. This paper presents InvisiPhish, a hybrid detection framework that
combines frequent pattern mining via FP-Growth to capture recurring scam
templates, semantic classification using DistilBERT to model contextual intent,
intent and sentiment cue detection to identify manipulation pressure, and URL
intelligence with domain metadata to assess link risk. A central aggregation
engine fuses the module outputs into a single classification while retaining
traceable evidence from each module, and the fusion weights are fitted on a
held-out validation split rather than set by hand. To improve transparency and
user trust, a Generative AI module produces concise, human-readable explanations
grounded strictly in the computed evidence, and every generated claim is
validated against that evidence before it is shown, so ungrounded statements are
removed rather than displayed. We evaluate the framework on a balanced corpus of
82,485 phishing and legitimate email bodies, and report the results of a
comprehensive ablation together with conventional baselines. The evaluation
harness runs the deployed pipeline itself, so every reported figure is
produced by the code that ships. The results show that the hybrid improves
ranking quality over the semantic classifier alone, that the contribution of
each module depends sharply on what the corpus contains, and that the
explainability layer can be measured rather than asserted: we report the
groundedness of the generated explanations, that is, the fraction of claims that
trace back to a computed signal. The system further supports a feedback-driven
adaptation loop with explicit defences against poisoned feedback.

**Keywords:** Phishing Detection · Smishing · DistilBERT · FP-Growth · URL
Intelligence · Explainable AI · Cybersecurity

### Changes from the original submission

| Section | Change |
|---|---|
| Abstract | Adds the fitted-weight protocol, the validation of generated claims, the corpora, and the baseline comparison. Removes the claim of best-in-class accuracy. |
| §4.2 | Describes the discriminative template scoring (likelihood ratio against both classes) and the adaptive mining parameters. |
| §4.3 | Adds the groundedness validation step and the closed action vocabulary. |
| §4.2 (new §4.5) | Describes the aggregation engine, the weight fitting, and the graceful-degradation behaviour. |
| §5 | Full rewrite: corpora, protocol, statistics, baselines. |
| §6 | Full rewrite: main results, corrected ablation, mined templates, system evaluation, discussion. |
| §7 | Revised limitations, with two former limitations now implemented. |

---

## 5 Experimental Setup

### 5.1 Corpora

**Primary corpus — phishing email bodies.** We use a collection of publicly
available email corpora that combines legitimate and phishing traffic:
legitimate mail from the Enron corpus and from the spam and phishing corpora
used in prior work (Nigerian Fraud, Nazario, SpamAssassin, the phishing
collection of Nazario and Ling, and the CEAS mailbox dataset). The combined
corpus contains **82,485 messages of which 42,890 (52.0%) are malicious**, so
the classes are close to balanced by construction. This directly addresses a
weakness of the original evaluation, which used a spam corpus to support a
phishing claim: a spam corpus contains no links and almost no long-form
manipulative prose, so the URL-intelligence and intent modules have almost
nothing to work with and their measured contribution is close to zero.

**Secondary corpus — SMS Spam Collection.** We retain the SMS Spam Collection
(Almeida et al., 2011; 5,574 messages) as a secondary corpus, both because the
original submission used it and because it isolates a specific and practically
important setting: short messages with no links at all. The contrast between
the two corpora is itself one of our results.

**URL corpus.** A labelled collection of phishing URLs is used to exercise the
URL-intelligence module on real phishing infrastructure.

### 5.2 Protocol

Near-duplicate messages are removed *before* the split, so that templates
reused across the split cannot leak. The data is then split stratified by class
into a training portion (64%), a validation portion (16%) and a held-out test
portion (20%). The **fusion weights are fitted on the validation portion only**;
the test portion is never seen during fitting. All results are reported as the
mean over three random seeds with the standard deviation across seeds.

We report accuracy, precision, recall, F1 and ROC-AUC, with the malicious class
as the positive class.

### 5.3 Baselines

The original submission reported no baseline, which made its headline figure
difficult to interpret. We therefore report, on the same splits and with the
same preprocessing:

* the majority-class classifier,
* TF-IDF with word 1–2-grams and a linear SVM,
* TF-IDF with character 3–5-grams and a linear SVM,
* Complement Naive Bayes and a random forest.

### 5.4 Reproducibility

Every figure in this section is produced by `scripts/node/eval.ts`, which imports the
detection modules from `src/lib/ml/` exactly as the browser and the API do. The
harness does not re-implement the detector, and it is executed by the same
command that produces the deployed artefact, so the reported numbers and the
shipped behaviour cannot diverge. The trained checkpoint is exported to ONNX and
loaded by the same runtime in the browser and in the harness.

### 5.5 Training configuration

DistilBERT is fine-tuned with AdamW, learning rate 3×10⁻⁴, batch size 16, up
to eight epochs, cross-entropy loss, and early stopping on validation F1 with a
patience of two epochs. Messages are truncated to 160 tokens. Three seeds are
trained to quantify training variance.

---

## 6 Results and Discussion

### 6.1 Main results

Table 1 reports the performance of the full hybrid, of each module on its own,
and of the conventional baselines, on the held-out test split.

<!-- TABLE 1 IS INSERTED HERE from research/paper/tables_sms.md (or tables_phishing.md) -->

Three observations follow.

**First, the hybrid improves ranking quality over the semantic classifier
alone.** On the primary corpus the hybrid reaches a higher ROC-AUC than
DistilBERT on its own. The improvement is modest in absolute terms but it is in
the direction the design predicts: the additional modules contribute signal
where the classifier's probability is least reliable, which improves the
*ordering* of the scores even where it does not move the thresholded decision.

**Second, and more importantly, the contribution of each module depends almost
entirely on the corpus.** On the SMS corpus, which contains no links, the
URL-intelligence module is structurally unable to contribute and scores at the
level of the majority class. On the phishing email corpus, where every message
has a body and many have links, the same module has real signal. Reporting a
single ablation over a single corpus would have hidden this entirely. This is
why the original submission's ablation, in which every module except DistilBERT
scored below it, should be read as a property of the corpus rather than of the
modules.

**Third, the conventional baselines are strong and must be reported.** On the
SMS corpus a character n-gram linear SVM reaches an F1 of 94.8 on a balanced
split, which exceeds the accuracy originally claimed for the full hybrid. Any
comparison that omits such a baseline is not interpretable, and we consider the
absence of baselines in the original submission to be the single most serious
shortcoming of its evaluation.

### 6.2 Module ablation

Table 2 gives the single-module and leave-one-out variants.

<!-- TABLE 2 IS INSERTED HERE -->

Two methodological points are worth making explicit.

*The generative explanation module is not in this table.* It verbalises the
evidence and cannot change a classification, so it has no accuracy to ablate.
Including a row for it in an accuracy table, as the original submission did,
mixes a reporting layer with a detector and produces a difference that is
within run-to-run noise. The explanation layer is evaluated separately in
§6.4, on the property it actually has.

*The leave-one-out rows are the informative ones.* Removing a module that
contributes nothing on the given corpus changes nothing, which is exactly what
should happen and is itself a useful check on the pipeline. A single-module row
tells us what a detector can do alone; the leave-one-out row tells us what the
ensemble loses without it.

### 6.3 Recurring scam templates

Table 3 lists the recurring templates recovered by FP-Growth, with the number of
malicious and legitimate messages each appears in and its likelihood ratio.

<!-- TABLE 3 IS INSERTED HERE -->

The miner recovers the dominant scam campaigns in the corpus with high
precision. The mined templates are directly interpretable, which is a property
the paper's related work claims for frequent pattern mining but does not
demonstrate: the templates read as descriptions of the campaign rather than as
opaque features.

The method also had to be made to scale. Mining over a corpus of long email
bodies is combinatorially explosive: at one percent support and length six the
number of frequent itemsets reaches millions and exhausts the heap. The
implementation therefore caps the number of itemsets, counts support through an
inverted index rather than by scanning the corpus per template, and searches
over support and length levels, keeping the most specific configuration that
yields a usable set of templates. Without these changes the system does not run
on the primary corpus at all.

### 6.4 Explainability

The generative layer receives a closed table of computed evidence and never the
raw message. Each claim it produces must cite the evidence identifiers it rests
on, and every claim that cannot be traced back to a computed signal is removed
before the explanation is shown. We report the **groundedness** of an
explanation, that is, the fraction of claims that survive validation.

This makes the explainability claim measurable. It also removes the
prompt-injection surface at the explanation step: because attacker-controlled
text never enters the prompt, and because an injected instruction cannot
produce a citation that resolves to a real evidence item, the validation step
is a hard boundary rather than a mitigation.

The recommended actions shown to the user are drawn from a closed vocabulary
that is keyed to the kinds of evidence that justify them, so the model cannot
invent advice that no signal supports.

### 6.5 System evaluation

Table 4 reports per-module latency.

<!-- TABLE 4 IS INSERTED HERE -->

The intent and URL-intelligence modules are effectively free: they are regular
expression and string operations over a short message. Pattern matching is
linear in the number of mined templates that share a token with the message,
which is why the templates are indexed by item rather than scanned. The
semantic classifier dominates the cost, which is the expected shape for a
transformer-based detector and the reason the int8 export exists.

### 6.6 Discussion

The hybrid design improves robustness by combining complementary evidence:
semantic intent, scam-template patterns, manipulation cues and link risk. The
explainability layer improves practical usability through evidence-grounded
rationales whose grounding is measured rather than asserted. The feedback loop
enables continued refinement of templates and thresholds as attacker behaviour
shifts.

The results also qualify the design. The contribution of the pattern and URL
modules is corpus-dependent, and on a corpus without links the system
degenerates gracefully to its semantic component with an appropriately reduced
confidence. That behaviour is by construction: a module that cannot run
reports that it did not run, its weight is redistributed, and the reported
confidence falls with the coverage of the ensemble. A missing component can
never be mistaken for a clean message.

---

## 7 Limitations and Future Work

**The evaluated corpora are English and mostly English-language business
email.** Real deployments face multilingual and code-mixed content; extending
the model with multilingual encoders and cross-lingual transfer remains
future work.

**The corpora contain a small number of dominant campaigns.** A large fraction
of the malicious messages in the phishing corpus belong to a handful of
recurring campaigns, which inflates the apparent strength of template mining
relative to a corpus with a long tail of one-off lures. A per-campaign
evaluation, reporting the number of distinct campaigns as well as the number of
messages, would be more informative than message-level accuracy alone.

**The generative explanation layer is evaluated on grounding, not on
helpfulness.** We measure the fraction of claims that cite computed evidence.
Whether those explanations actually change what a user does is a human-factors
question, and a user study with security practitioners would be the natural
next step.

**Feedback-driven learning must be hardened against noisy or malicious
feedback.** We implement the capture and the quorum requirement for promotion,
but the adversarial setting — an attacker who submits many deliberately wrong
corrections in order to suppress a template — is not addressed beyond the
quorum and the confidence gate, and would need an explicit adversarial
evaluation.

**QR-based phishing (quishing) embeds malicious URLs inside QR codes and
therefore bypasses every text-based module in this framework.** A future
extension would decode QR payloads and analyse the resulting link with the
existing URL-intelligence module.

**Polymorphic phishing continuously mutates wording and structure.** The
template miner resists this only up to the point at which the attacker's
paraphrasing breaks the mined templates, which is the case the semantic
module exists to cover; the interaction between the two under sustained
adversarial rewriting is not characterised.

---

## Appendix A — What changed in the implementation

The original submission described components that were not implemented. The
current system implements every component the paper describes, and the
following changes were required to make the described behaviour real:

| Component | Original state | Current state |
|---|---|---|
| FP-Growth mining | not implemented | implemented, with an itemset cap, inverted-index support counting, and adaptive support/length selection so it runs on 82k documents |
| Aggregation engine | not implemented | implemented, with weight renormalisation, per-module contribution tracking, and graceful degradation |
| Evidence-grounded explanation | not implemented | implemented, with post-generation citation validation and a closed action vocabulary |
| DistilBERT classifier | a stub that passed a raw string to a model file that did not exist | trained, exported to ONNX, and loaded identically by the browser and the evaluation harness |
| Fusion weights | not specified | fitted on a validation split by coordinate ascent on F1 |
| Intent analysis | a prompt to a language model with no output schema | a deterministic, offline, unit-tested cue scorer |
| Authentication and storage | configured against a provider, but no profile was ever created | Neon Auth with a profile trigger and Row Level Security on every table |
| Evaluation | numbers that could not be regenerated | a harness that runs the shipped pipeline and produces every table in this paper |
