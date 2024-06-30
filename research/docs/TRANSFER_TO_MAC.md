# Moving the InvisiPhish work back to the MacBook

Everything from the VPS is now in GitHub, and the three large files are also on
the MacBook over Tailscale. This note is the script for the MacBook side.

## What is where

| What | Where | Size |
|---|---|---|
| Source, results, docs, paper tables | `github.com/mrpaaradox/invisiphish` (private) | ~2 MB |
| Trained checkpoints (4 x ONNX + safetensors) | same repo, via Git LFS | ~1.5 GB |
| `invisiphish-model.zip` (all 3 seeds) | GitHub release + Tailscale | 1.4 GB |
| `invisiphish-results.zip` | GitHub release + Tailscale | 6 KB |
| Run log | GitHub release + Tailscale | 141 KB |

Release: <https://github.com/mrpaaradox/invisiphish/releases/tag/v0.2.0-kaggle-run-2026-10-20>

> **The repository is private.** A private repository's release assets and LFS
> objects need authentication, so the `curl` commands below pass a token. If
> the release ever becomes public, drop the `-H` line.

## 1. Pull the code

The VPS had no `.git` (it was excluded when the project was synced out), so
this is a **fresh repository with a fresh history**. The MacBook's existing
`.git` is untouched.

```bash
cd ~/invisiphish           # the copy that came from here
git remote add vps git@github.com:mrpaaradox/invisiphish.git
git fetch vps
git log --oneline vps/main   # three commits
```

Then merge or replace, whichever suits:

```bash
# Option A - keep the MacBook's history, take the VPS's files
git merge --allow-unrelated-histories vps/main

# Option B - the VPS state wins outright
git checkout -B main vps/main
```

Option B is usually right here: the MacBook's copy was the source of the VPS
copy, and everything that changed since was done on the VPS.

## 2. Get the model weights

They are Git LFS objects, so a plain clone leaves pointer files instead of the
real weights.

```bash
brew install git-lfs        # if it is not installed already
git lfs install
git lfs pull
```

Check it worked:

```bash
ls -lh public/models/distilbert-phishing/onnx/model.onnx
# 268M, not 134 bytes
```

## 3. The big archives

They went over Tailscale as well, so they should already be in the MacBook's
Tailscale folder (`~/Library/Containers/com.tailscale.ipn.macos/Data/Documents`
or the folder Tailscale shows in the app). If they are not there, pull them
from the release:

```bash
cd ~/Downloads
TOKEN=$(gh auth token)     # or paste a PAT with `repo` scope
for f in invisiphish-model.zip invisiphish-results.zip invisiphish-training-and-evaluation.log; do
  curl -L -H "Authorization: token $TOKEN" \
    -O "https://github.com/mrpaaradox/invisiphish/releases/download/v0.2.0-kaggle-run-2026-10-20/$f"
done
```

`invisiphish-model.zip` holds the three seed checkpoints:

```bash
unzip invisiphish-model.zip -d /tmp/invisiphish-model
```

## 4. Install the checkpoints where the app expects them

The app loads `public/models/distilbert-phishing/`, and the evaluation harness
scores one directory per seed:

```bash
cd ~/invisiphish
for s in 13 42 77; do
  rm -rf "public/models/distilbert-phishing-seed$s"
  cp -r "/tmp/invisiphish-model/seed-$s" "public/models/distilbert-phishing-seed$s"
done
rm -rf public/models/distilbert-phishing
cp -r /tmp/invisiphish-model/seed-13 public/models/distilbert-phishing
```

## 5. Run it

```bash
pnpm install
pnpm verify     # typecheck + 49 tests + production build
```

Use Node 22 or newer. Node 18 is the default on the VPS and its `vitest`
fails with `node:util does not provide an export named 'styleText'`:

```bash
export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
```

## Notes on the numbers

The results in `research/results/` came from the Kaggle run of 2026-10-20, **before**
the evaluation-split fixes landed. `HANDOFF.md` section 4 explains what was
wrong and what has to be re-run before anything is published. The checkpoint's
own held-out metrics (98.86% +/- 0.22% accuracy, ROC-AUC 0.9991 +/- 0.0003)
are trustworthy; the hybrid's numbers in the JSON files are not yet.

## Keeping the two machines in step

The existing `scripts/deploy/sync.sh` pushes the MacBook to the VPS. To go the
other way, or to use GitHub as the meeting point instead, pull from the
repository on whichever machine you are editing and push from there.

Note that `sync.sh` uses `rsync --delete` and excludes `.git`, so running it
after fetching from GitHub will not clobber the repository, but it will
overwrite the working files with the VPS copy.
