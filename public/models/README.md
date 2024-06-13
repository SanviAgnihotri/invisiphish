# Model weights

This directory holds the trained classifier checkpoint used by
`src/lib/ml/semanticModel.ts`.

The weights are **not committed** — they are large and fully reproducible from
the training script.

## Producing the checkpoint

```bash
pip install -r research/ml/requirements.txt
python research/ml/train_distilbert.py \
  --dataset research/ml/datasets/sms_phishing.csv \
  --output-dir public/models
```

The script fine-tunes `distilbert-base-uncased` with a sequence classification
head and exports the result to TensorFlow.js so it can run in the browser.

## Expected layout

```
public/models/
  phishing_detector.json      # model.json
  phishing_detector.bin       # weights
```

`src/lib/ml/semanticModel.ts` loads `VITE_SEMANTIC_MODEL_PATH`
(default `/models/phishing_detector.json`).

## Behaviour when the checkpoint is missing

The semantic module reports `status: 'skipped'` and contributes no score. The
aggregation engine redistributes its weight across the modules that did run and
reduces the reported confidence accordingly, because only a fraction of the
ensemble was available.

A missing checkpoint therefore shows up as *lower confidence*, never as a
confident "this message is fine".
