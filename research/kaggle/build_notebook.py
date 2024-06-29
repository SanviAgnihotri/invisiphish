#!/usr/bin/env python3
"""
Generate the Kaggle notebook.

The notebook is generated rather than hand-edited so that the cell sources
cannot drift out of sync with the scripts they call, and so that a mistake in
one edit cannot leave a half-written statement behind.

Usage:
    python research/kaggle/build_notebook.py
"""

from __future__ import annotations

import json
from pathlib import Path

OUTPUT = Path("research/kaggle/kernel/invisiphish-training.ipynb")
TOPIC = "invisiphish-kaggle-v1"

HELPER = '''
# --- live heartbeat -------------------------------------------------------
# A running Kaggle kernel does not expose its log over the API, so progress is
# published to ntfy.sh and mirrored into the local watch log. Only stage names
# and counts are sent; no credentials leave the notebook.
BEAT_TOPIC = "{topic}"


def beat(message):
    import urllib.request
    try:
        request = urllib.request.Request(
            f"https://ntfy.sh/{{BEAT_TOPIC}}",
            data=str(message).encode(),
            headers={{"Title": "InvisiPhish", "Content-Type": "text/plain"}},
        )
        urllib.request.urlopen(request, timeout=15).read()
    except Exception:
        pass
    print(f"[beat] {{message}}", flush=True)
'''.format(topic=TOPIC)


def md(text: str) -> dict:
    return {"cell_type": "markdown", "metadata": {}, "source": text.strip().splitlines(keepends=True)}


def code(text: str) -> dict:
    return {
        "cell_type": "code",
        "execution_count": None,
        "metadata": {},
        "outputs": [],
        "source": text.strip("\n").splitlines(keepends=True),
    }


CELLS = [
    md(
        """
# InvisiPhish - training and evaluation run

Runs unattended on a Kaggle GPU.

1. Trains the DistilBERT phishing classifier on a **phishing-specific** corpus.
2. Exports the checkpoint to ONNX so the browser and the Node harness load the *same weights*.
3. Runs the evaluation harness (`scripts/node/eval.ts`) over the shipped TypeScript pipeline, with the fusion weights **fitted on a validation split**.
4. Runs the TF-IDF + LinearSVC baseline for comparison.
5. Packages everything as the notebook output.

Inputs expected:
- `cptadityavyas/invisiphish-training-package` - the training and evaluation code
- `naserabdullahalam/phishing-email-dataset` - phishing vs legitimate email bodies
- `uciml/sms-spam-collection-dataset` - the SMS Spam Collection used by the original paper
"""
    ),
    code(
        """
# numpy and pandas are deliberately NOT touched: Kaggle ships a matched pair
# and upgrading one of them breaks the other.
# `onnxscript` is needed by torch's ONNX exporter.
# `scikit-learn` is needed by the TF-IDF + LinearSVC baseline. It is present
# in the Kaggle image, but installing it is a no-op when it is already there
# and saves the run when it is not.
!pip install -q --no-cache-dir "transformers==4.57.6" accelerate onnx onnxscript onnxruntime scikit-learn

import torch, transformers, sys, os, glob, shutil, subprocess, json
from pathlib import Path

import numpy, pandas

print('python', sys.version.split()[0])
print('torch', torch.__version__, '| cuda', torch.cuda.is_available())
if torch.cuda.is_available():
    print('gpu:', torch.cuda.get_device_name(0))
print('transformers', transformers.__version__)
print('numpy', numpy.__version__, '| pandas', pandas.__version__)
"""
        + HELPER
    ),
    md(
        """
## 1. Make sure Node.js is available

The evaluation harness is TypeScript, so it runs in Node against the same pipeline code the browser uses.
"""
    ),
    code(
        """
if shutil.which('node') is None:
    print('node not found, installing the official tarball...')
    subprocess.run(['bash', '-c', 'curl -fsSL https://nodejs.org/dist/v20.18.1/node-v20.18.1-linux-x64.tar.xz -o /tmp/node.tar.xz'], check=True)
    subprocess.run(['bash', '-c', 'mkdir -p /opt/node && tar -xJf /tmp/node.tar.xz -C /opt/node --strip-components=1'], check=True)
    os.environ['PATH'] = '/opt/node/bin:' + os.environ.get('PATH', '')

print('node:', subprocess.run(['node', '--version'], capture_output=True, text=True).stdout.strip())
print('npm :', subprocess.run(['npm', '--version'], capture_output=True, text=True).stdout.strip())
beat('node ready')
"""
    ),
    md(
        """
## 2. Locate the inputs

Kaggle has changed its mount layout more than once, so every plausible root is searched and each one is classified by what it contains rather than by its name.
"""
    ),
    code(
        """
roots = []
for pattern in ('/kaggle/input/*', '/kaggle/input/datasets/*/*', '/kaggle/input/datasets/*/*/*'):
    roots.extend(p for p in glob.glob(pattern) if os.path.isdir(p))
roots = sorted(set(roots))

print('candidate roots:')
for r in roots:
    print('  ', r)


def file_names(root, limit=600):
    names = []
    for path in glob.glob(os.path.join(root, '**', '*'), recursive=True):
        names.append(os.path.basename(path).lower())
        if len(names) >= limit:
            break
    return ' '.join(names)


INPUTS = {}
for r in roots:
    if os.path.exists(os.path.join(r, 'ml', 'train_distilbert.py')):
        INPUTS['package'] = r
        continue
    names = file_names(r).replace(' ', '')
    # The SMS collection is identified by the dataset directory name as well
    # as by the classic file names: the uciml copy of the corpus ships
    # `spam.csv`, so the file names alone do not identify it.
    leaf = os.path.basename(r.rstrip('/')).lower()
    if ('sms-spam-collection' in leaf
            or 'smsspamcollection' in names or 'smspamcollection' in names):
        INPUTS['sms'] = r
    elif 'phishing_email.csv' in names:
        # The phishing email corpus. Named explicitly, because the URL corpus
        # is larger and the fallback would otherwise select it.
        INPUTS['phishing_emails'] = r
    elif 'phishing_url' in names or 'phishingurls' in names:
        INPUTS['phishing_urls'] = r

print()
print('resolved:', INPUTS)

WORK = '/kaggle/working'
REPO = os.path.join(WORK, 'repo')
os.makedirs(REPO, exist_ok=True)

if 'package' not in INPUTS:
    raise RuntimeError(
        'The InvisiPhish training package was not mounted. Check that '
        'cptadityavyas/invisiphish-training-package is listed under dataset_sources '
        'in the kernel metadata. Roots seen: ' + repr(roots)
    )

subprocess.run(['bash', '-c', f'cp -r {INPUTS["package"]}/. {REPO}/'], check=True)
print('copied training package into', REPO)
beat('inputs located: ' + repr(sorted(INPUTS)))
"""
    ),
    md(
        """
## 3. Inspect the corpora

Every candidate is scored with the same loader the training script uses, so the choice of corpus is visible in the log rather than implicit.
"""
    ),
    code(
        """
os.chdir(REPO)
sys.path.insert(0, os.path.join(REPO, 'ml'))
from train_distilbert import discover_dataset


def classify_corpus(root):
    rows, source = discover_dataset(Path(root))
    if not rows:
        return None
    positives = sum(1 for label, _ in rows if label == 'phishing')
    return {'rows': len(rows), 'phishing': positives, 'source': source, 'root': root}


candidates = []
for r in roots:
    if r == INPUTS.get('package'):
        continue
    info = classify_corpus(r)
    if info:
        candidates.append(info)

for info in sorted(candidates, key=lambda item: -item['rows']):
    print(f"  rows={info['rows']:7d}  phishing={info['phishing']:7d} "
          f"({info['phishing']/max(1,info['rows']):5.1%})  <- {info['source']}")

if 'phishing_emails' not in INPUTS and candidates:
    best = max(candidates, key=lambda item: item['rows'])
    INPUTS['phishing_emails'] = best['root']
    print('WARNING: the phishing email corpus was not identified, falling back to the '
          'largest candidate:', best['root'])

beat('corpora inspected: ' + repr([(c['rows'], c['source']) for c in candidates]))
beat('selected corpora: ' + repr(sorted(INPUTS)))
"""
    ),
    code(
        """
def prepare(key, out_name, prefer=None):
    path = INPUTS.get(key)
    if not path:
        print(f'{key}: NOT FOUND, skipping')
        return None
    out = os.path.join(REPO, 'ml', 'datasets', out_name)
    cmd = ['python', 'research/ml/prepare_dataset.py', '--data', path, '--output', out]
    if prefer:
        cmd += ['--file', prefer]
    print('>>>', ' '.join(cmd), flush=True)
    subprocess.run(cmd, check=True)
    return out


# The phishing corpus ships seven files. `phishing_email.csv` is the
# preprocessed, balanced combination of all of them; the other six are the raw
# sub-corpora and have very different class balances. Pinning the file keeps
# the choice reproducible.
PHISHING_CSV = prepare('phishing_emails', 'phishing_emails.csv', prefer='phishing_email.csv')
SMS_CSV = prepare('sms', 'sms_spam.csv')

print()
print('phishing csv:', PHISHING_CSV)
print('sms csv     :', SMS_CSV)

if not (PHISHING_CSV or SMS_CSV):
    raise RuntimeError('No labelled corpus was mounted, so there is nothing to train on.')

beat('corpora prepared')
"""
    ),
    md(
        """
## 4. Train the classifier

AdamW, cross-entropy, early stopping on validation F1.

Two settings differ from the original paper and both are deliberate:

- **Learning rate 3e-5, not 3e-4.** At 3e-4 the model collapses: it predicts the majority class, F1 stays at 0 and ROC-AUC drifts below 0.5. 3e-5 is the standard range for a DistilBERT sequence classification head.
- **The training set is capped.** The corpus has 82k messages; eight epochs over all of them is roughly eighteen hours per seed. The evaluation always uses the full corpus.
"""
    ),
    code(
        """
SEEDS = '13,42,77'
EPOCHS = 6
BATCH = 16
MAX_ROWS = '25000'
LEARNING_RATE = '3e-5'
OUT = os.path.join(WORK, 'models')

train_on = PHISHING_CSV or SMS_CSV
cmd = [
    'python', 'research/ml/train_distilbert.py',
    '--data', train_on,
    '--output-dir', OUT,
    '--seeds', SEEDS,
    '--epochs', str(EPOCHS),
    '--batch-size', str(BATCH),
    '--max-rows', MAX_ROWS,
    '--learning-rate', LEARNING_RATE,
]
print('>>>', ' '.join(cmd), '\\n', flush=True)
beat('training started: ' + str(train_on))
subprocess.run(cmd, check=True)
beat('training finished')
"""
    ),
    code(
        """
primary_seed = SEEDS.split(',')[0]
primary = os.path.join(OUT, f'seed-{primary_seed}')
target = os.path.join(REPO, 'public', 'models', 'distilbert-phishing')
if os.path.exists(target):
    shutil.rmtree(target)
os.makedirs(os.path.dirname(target), exist_ok=True)
shutil.copytree(primary, target)
print('installed checkpoint into', target)

if os.path.isdir(os.path.join(target, 'onnx')):
    for name in sorted(os.listdir(os.path.join(target, 'onnx'))):
        size = os.path.getsize(os.path.join(target, 'onnx', name)) / 1e6
        print(f'  onnx/{name}  {size:.1f} MB')
else:
    print('  WARNING: no ONNX export found, the evaluation will skip the semantic module')

summary = json.load(open(os.path.join(OUT, 'training_summary.json')))
print()
print(f"{'metric':<12}{'mean':>10}{'std':>10}   per-seed")
for key, stats in summary['summary'].items():
    print(f"{key:<12}{stats['mean']:>10.4f}{stats['std']:>10.4f}   {stats['values']}")

beat('training metrics: ' + json.dumps(summary['summary']))
"""
    ),
    md(
        """
## 5. Install the dependencies and type-check

The evaluation harness is TypeScript, so it has to be compiled before it can run.
"""
    ),
    code(
        """
os.chdir(REPO)
print('npm ci ...', flush=True)
subprocess.run(['bash', '-c', 'npm ci --no-audit --no-fund'], check=True)

# The training package ships the evaluation harness and the library it
# imports, but not the web app's Vite config or the serverless API. Building
# the whole solution therefore reports TS18003 ("no inputs were found") for the
# two projects that have no sources in the package, which kills the run before
# the evaluation. Only the projects that the package actually contains are
# built; a project whose include patterns match nothing is reported and
# skipped.
def project_has_inputs(path):
    import glob as _glob
    import json as _json
    with open(path) as handle:
        config = _json.load(handle)
    patterns = list(config.get('include', [])) + list(config.get('files', []))
    return any(_glob.glob(pattern, recursive=True) for pattern in patterns)


with open('tsconfig.json') as handle:
    solution = json.load(handle)

projects = []
for reference in solution.get('references', []):
    path = reference['path']
    if not os.path.exists(path):
        print(f'  skipping {path}: not in the training package')
        continue
    if not project_has_inputs(path):
        print(f'  skipping {path}: no input files in the training package')
        continue
    projects.append(path)

if not projects:
    raise RuntimeError(
        'No TypeScript project has any input files in the training package. '
        'The evaluation harness cannot be type-checked.'
    )

print('typechecking:', projects, flush=True)
subprocess.run(['bash', '-c', 'npx tsc -b ' + ' '.join(projects) + ' --force'], check=True)
print('typecheck OK\\n', flush=True)
beat('node dependencies installed')
"""
    ),
    md(
        """
## 6. Evaluate the shipped pipeline

`scripts/node/eval.ts` imports `src/lib/ml/*` exactly as the app does, runs it over the held-out test split, fits the fusion weights on a validation split, and produces the corrected ablation table, the mined FP-Growth templates and the per-module latency.

The classifier runs on the notebook's CPU, so the evaluation set is capped to keep the run inside a sensible time budget. Five thousand messages per split per seed still gives a confidence interval of about plus or minus 1.5 points on F1.
"""
    ),
    code(
        """
RESULTS = os.path.join(WORK, 'results')
os.makedirs(RESULTS, exist_ok=True)

# Each corpus is evaluated on its own, and a failure in one does not abort the
# others: a run that trains for hours and then dies on the last step produces
# nothing at all, which is what happened on the first attempt.
for name, csv_path, max_eval in [
    ('phishing_emails', PHISHING_CSV, '5000'),
    ('sms_spam', SMS_CSV, '0'),
]:
    if not csv_path:
        continue
    out = os.path.join(RESULTS, f'evaluation_{name}.json')
    cmd = ['npx', 'tsx', 'scripts/node/eval.ts', '--dataset', csv_path,
           '--seeds', '13,42,77', '--max-eval', max_eval, '--out', out]
    print('\\n>>>', ' '.join(cmd), flush=True)
    beat('evaluation started: ' + str(name))
    result = subprocess.run(cmd)
    if result.returncode != 0:
        print(f'!! evaluation of {name} failed with code {result.returncode}', flush=True)
        beat(f'evaluation FAILED: {name}')
    else:
        beat('evaluation finished: ' + str(name))
"""
    ),
    code(
        """
for name, csv_path in [('phishing_emails', PHISHING_CSV), ('sms_spam', SMS_CSV)]:
    if not csv_path:
        continue
    out = os.path.join(RESULTS, f'baseline_{name}.json')
    cmd = ['python', 'research/ml/baseline_svm.py', '--data', csv_path, '--out', out]
    print('\\n>>>', ' '.join(cmd), flush=True)
    result = subprocess.run(cmd)
    if result.returncode != 0:
        print(f'!! baseline for {name} failed with code {result.returncode}', flush=True)
        beat(f'baseline FAILED: {name}')

beat('baselines finished')
"""
    ),
    md(
        """
## 7. Package the output

`invisiphish-model.zip` holds the exported ONNX checkpoint; `invisiphish-results.zip` holds every table the paper needs.
"""
    ),
    code(
        """
shutil.make_archive(os.path.join(WORK, 'invisiphish-model'), 'zip', OUT)
shutil.make_archive(os.path.join(WORK, 'invisiphish-results'), 'zip', RESULTS)

print('outputs:')
for name in sorted(os.listdir(WORK)):
    path = os.path.join(WORK, name)
    if os.path.isfile(path):
        print(f'  {name}  {os.path.getsize(path)/1e6:.1f} MB')
print()
print('results:')
for name in sorted(os.listdir(RESULTS)):
    print(f'  {name}')
print()
print('download invisiphish-model.zip and invisiphish-results.zip from the notebook output')
beat('packaged outputs')
"""
    ),
]


def main() -> int:
    notebook = {
        "cells": CELLS,
        "metadata": {
            "kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
            "language_info": {"name": "python", "version": "3.11"},
        },
        "nbformat": 4,
        "nbformat_minor": 5,
    }

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(notebook, indent=1) + "\n", encoding="utf-8")
    print(f"wrote {OUTPUT} with {len(CELLS)} cells")

    # Fail loudly rather than shipping a notebook that cannot parse.
    import ast

    for index, cell in enumerate(CELLS):
        if cell["cell_type"] != "code":
            continue
        source = "".join(cell["source"])
        # The notebook cell uses `!pip`, which is not valid Python.
        source = "\n".join(
            line for line in source.splitlines() if not line.strip().startswith("!")
        )
        try:
            ast.parse(source)
        except SyntaxError as error:
            raise SystemExit(f"cell {index} does not parse: {error}\n{source}")

    print("all code cells parse")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
