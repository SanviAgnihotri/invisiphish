# Training on Kaggle

Kaggle gives ~30 GPU-hours a week (T4 x2). That is enough to train the semantic
classifier properly on a **phishing-specific** corpus, across several seeds, and
to produce stronger upper bounds for the paper's comparison table.

The script that runs is the same one in the repository (`research/ml/train_distilbert.py`),
so the training is reproducible and the configuration matches the paper.

---

## 1. Pick a dataset

Add one of these as an input to your Kaggle notebook. All of them are widely
available; search for the names in the Kaggle dataset browser.

| Dataset | Size | Why |
|---|---|---|
| **Phishing Emails Dataset** (E. N. Ngai et al.) | ~11k phishing + ~11k legitimate | Balanced, well-labelled, the most commonly cited phishing email corpus. Ships as two folders (`phishing_emails/`, `legitimate_emails/`) - the loader reads that layout automatically. |
| **PhishStorm** | ~96k phishing + ~96k legitimate | Much larger, so a bigger model has room to show its value. |
| **Phishing vs Legitimate Emails** | varies | Often already CSV with `text` + `label` columns. |
| **SMS Spam Collection** | 5,574 messages | The corpus the current paper uses. Keep it as the *baseline corpus* even after adding a phishing dataset. |

> The loader auto-detects the label column (`label`, `class`, `category`,
> `type`, `spam`, ...) and the text column (`message`, `text`, `body`,
> `content`, ...), and normalises the label values. If the dataset is a folder
> of `.txt` files, the label is taken from the parent folder name.

**Aim for a phishing corpus as the main evaluation set.** Using a spam corpus
for a *phishing* claim is the weakest point in the current paper, and fixing it
is worth more than any model change.

## 2. Make the repository reachable from the notebook

Either:

- **Push the repo to a public GitHub repository** and set `REPO_URL` in cell 4; or
- **Upload the repository as a Kaggle dataset** (zip the folder, add it as an input) and point `REPO_DIR` at it, then skip the clone cell.

## 3. Run the notebook

1. Create a new notebook with **GPU** enabled.
2. Paste the contents of `train_phishing_classifier.ipynb` (or upload it directly - Kaggle accepts `.ipynb` uploads).
3. Set `DATASET_PATH` to your dataset folder and `REPO_URL` to your repository.
4. Run all cells. Cell 3 prints the dataset it discovered - check the counts and class balance before the training starts.
5. Cell 4 trains. Cell 5 prints the per-seed metrics.

### What to vary

| Goal | Change |
|---|---|
| Training variance across seeds | `SEEDS = '13,42,77'` |
| Stronger upper bound for the paper | `MODEL = 'bert-base-uncased'` or `'microsoft/deberta-v3-base'` |
| More capacity | `EPOCHS = 10`, `BATCH_SIZE = 32` (DistilBERT), `BATCH_SIZE = 16` (DeBERTa) |
| Longer messages (email bodies rather than SMS) | `--max-length 256` in the script call |

Rough cost on a T4: DistilBERT on 20k messages, 8 epochs, batch 16 is about
20-30 minutes. Three seeds is under two hours, which leaves plenty of budget.

## 4. Bring the model home

Cell 6 writes `invisiphish-model.zip` to the notebook output. Download it and
unpack it into the repository:

```bash
unzip invisiphish-model.zip -d public/models/
```

You should end up with:

```
public/models/
  distilbert-phishing/
    config.json
    tokenizer.json
    tokenizer_config.json
    special_tokens_map.json
    vocab.txt
    onnx/
      model.onnx
      model_quantized.onnx
    training_report.json
```

## 5. Reproduce the paper's tables locally

The evaluation harness runs the **shipped TypeScript pipeline** over the
dataset using the exported weights, so the numbers in the paper come from the
code that actually ships:

```bash
pnpm install
pnpm eval -- --seeds 13,42,77
```

This produces:

- `research/results/evaluation.json` - main results, corrected ablation, mined FP-Growth
  templates and per-module latency
- the baseline comparison: `pnpm baseline`

## 6. Run the same training locally

For quick iteration without spending Kaggle hours:

```bash
python research/ml/fetch_datasets.py
python research/ml/train_distilbert.py --data research/ml/datasets/sms_spam.csv \
  --output-dir public/models/distilbert-phishing \
  --copy-primary-to public/models/distilbert-phishing/primary
```

On Apple Silicon the script uses MPS automatically and takes roughly an hour
per seed on the SMS Spam Collection.
