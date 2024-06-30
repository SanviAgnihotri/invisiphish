# InvisiPhish - handoff

Everything a fresh session needs. This file is the source of truth for the
project's state; it is synced to the VPS and lives next to the code.

## 0. The state on 2026-10-21

The project moved back to the MacBook, the database was provisioned for real,
and the website was made runnable.

| What | State |
|---|---|
| Code | `github.com/mrpaaradox/invisiphish`, branch `feat/local-dev-and-browser-model` (PR #1). The MacBook checkout is at `~/Desktop/Work/Sanvi Agnihotri/project`; the VPS holds the same tree at `~/invisiphish`. |
| Trained checkpoints | All four are on the MacBook as Git LFS objects, plus the int8 export (`onnx/model_quantized.onnx`, 64MB) that the browser loads. |
| Database | **Provisioned.** Neon project `lively-bread-b8en50re` (us-east-1), 8 tables, 19 RLS policies, a restricted role `invisiphish_app` without `BYPASSRLS`, and the `authenticated` group role the policies are written for. Provisioning is repeatable with `python3 scripts/python/provision-neon-local.py`. |
| The website | **Runs on the MacBook.** `pnpm dev` serves the SPA *and* the API on the same origin, the classifier runs in the browser, and the whole path (sign up, analyse, history, explanation, feedback) is checked by `pnpm verify:e2e`. |
| Google sign-in | **Implemented.** The button on the login and register pages runs the OAuth flow through the Auth service, which has Google enabled with shared credentials - no configuration needed. The session the flow creates lives on the Auth service's domain, so it is bridged by the session token, a JWT the API verifies against the Auth service's published key. `pnpm verify:session` checks the bridge. |
| The deployment | **Running on the machine**, at `https://temp.adityavyas.com` (a Cloudflare tunnel, so it has a real certificate and the `__Secure-` session cookie works). `scripts/deploy/deploy.sh` builds it here, copies the built frontend and the bundled server, and restarts it under pm2. The one thing left to do by hand: the Auth service has to be told to trust the domain - see below. |
| Neon Auth | **Enabled.** Managed Better Auth is on the branch, and the Auth URL is in `.env.local` as `NEON_AUTH_BASE_URL`. Sign-up, sign-in, the session and sign-out all work against the real service. |
| The explanation layer | **Now an OpenCode Go model.** `api/_lib/explain.ts` calls the OpenAI-compatible endpoint at `https://opencode.ai/inference/go/openai/v1` with `OPENCODE_API_KEY`, and tries a chain of models: `glm-5.3-flash`, then `mimo-v2.6-flash`, `qwen3.8-flash`, `mimo-v2.5`, `hy3`, `longcat-2.0`. Gemini is kept as an alternative provider (`EXPLAIN_PROVIDER=gemini`). |
| The package manager | **pnpm**, not npm. `pnpm-workspace.yaml` carries the pnpm settings (`allowBuilds`) and `package.json` pins `packageManager`. The `package-lock.json` is gone. |
| The paper's numbers | The Kaggle kernel was re-pushed (version 12) with the evaluation fixes, so the run in flight measures the hybrid on a clean split. The tables are regenerated when it lands (`scripts/python/build_paper_tables.py`). |
| The thread | The T3 Code thread `7f067ac7-2ebf-48a2-8a07-d81287a4aa73` was imported into the MacBook's T3 Code from the VPS (`research/docs/IMPORT_THREAD.md`). Restart the app to see it. |

Two things about the OpenCode Go endpoint that are easy to get wrong and are
worth keeping:

* it **requires** an `x-opencode-session` header and a client-identifying
  user agent; without the header the service refuses the request with
  `MissingSessionID`;
* `response_format` is **not enforced by every model** it serves. `glm-5.3-flash`
  honours the JSON schema; `minimax-m3`, `glm-5.2` and `glm-5.3` answer in
  prose. The output contract is therefore also written into the system
  instruction, and the answer is parsed leniently, because a model that
  ignores the schema produces a fallback rather than an explanation.

The model chain was chosen by measuring every model the endpoint offers
against the real request, twice, because the behaviour is not deterministic:
`hy3` and `longcat-2.0` answered in the object on one run and in prose on
another. `deepseek-v4.1-flash` and `kimi-k2.7-code` refuse the request
outright - the latter rejects `temperature: 0`. The chain is what absorbs
that: the first model that answers is used, and the reader still gets an
explanation.

### The deployment on the machine

There is no Vercel project. The application runs on the machine at
`https://temp.adityavyas.com`, through a Cloudflare tunnel of its own - a
separate tunnel from the one serving `erp`, `blogs` and the rest, so the
existing hostnames are not touched.

| Piece | Where |
|---|---|
| The frontend | `dist/`, built here with `VITE_SEMANTIC_QUANTIZED=1` and trimmed to the int8 export: 86MB, and the machine runs it as well as the browser does |
| The API | `dist-server/server.mjs`, one bundled file; `server/index.ts` mounts the same handlers the Vercel functions use, because they were written against structural interfaces rather than against a runtime's request and response types |
| The process | pm2, as `invisiphish`; the tunnel is pm2's `invisiphish-tunnel` |
| The configuration | `~/invisiphish/.env.local`, mode 600, copied by the deploy script from the laptop's own file |
| The model | `~/invisiphish/dist/models/`, the int8 export only |
| Node | 22.20.0 under `~/.local/node22`, pnpm under `~/.local/pnpm`, neither installed with sudo |

`scripts/deploy/deploy.sh av@100.95.166.116` does the whole thing: build, trim,
copy, write the configuration, install the runtime dependencies, restart.

**One step is done by hand.** The Auth service only accepts requests from
origins it has been told to trust, and a deployment on a new domain has to be
added to that list before anybody can sign in:

```
Neon console -> project lively-bread-b8en50re -> the branch
              -> Settings -> Auth -> Trusted Domains
              -> add https://temp.adityavyas.com
```

Without it, every sign-in is refused with `Invalid origin` - and only the
localhost ports are pre-approved, which is why the laptop works and the
deployment does not.

### Why the Google sign-in works the way it does

This is the part that took the longest to work out, and the reasoning is not
obvious from the code. Five facts about the Auth service decide it, and each
was established by trying it rather than by reading about it:

* **its session cookie is host-only to its own domain.** A session it creates
  never reaches this application's origin, and a server cannot set a cookie
  for a domain it is not on. So the session cannot simply be forwarded.
* **the raw session token is not accepted in place of that cookie.** The
  cookie is `<token>.<signature>`, and only the Auth service can produce the
  signature. The raw token, as a cookie under any name, or as an
  `Authorization: Bearer` header, or as a query parameter, is all refused.
* **`POST /auth/sign-in/social` ignores the `idToken` field.** Its own
  OpenAPI document describes the field, and Better Auth's source supports it,
  but the managed service always answers with the redirect flow. So there is
  no way to hand it a Google ID token and have it mint the session here.
* **`GET /auth/token` issues a JWT for the session it holds**, and the key
  that verifies it is published at `{NEON_AUTH_BASE_URL}/.well-known/jwks.json`.
* **the OAuth callback redirects to the application with a
  `neon_auth_session_verifier` in the query string.** This is the part that
  is not documented anywhere: the Auth service's own OpenAPI does not
  mention it, and it is not in Better Auth's source. It is the handoff, and it
  exists because of the next fact.
* **the session cookie is set `Partitioned`.** The cookie the OAuth callback
  sets belongs to the partition of the navigation that reached the Auth
  service, which came from Google - not to this application's origin. So it
  is not sent when this application's page asks the Auth service for it, and
  `GET /auth/token` answers nothing. That is the whole reason the first
  attempt failed, and it is why the error was "the Auth service did not give
  one" rather than anything about permissions.

The verifier is redeemed with
`GET {NEON_AUTH_BASE_URL}/get-session?neon_auth_session_verifier=...`,
**in the browser**, because it is checked against the session challenge
cookie the Auth service set when the sign-in started - a cookie only the
browser holds, and one that is host-only to the Auth service's domain. The
redemption puts the session cookie in this origin's partition, where the
token endpoint can see it, and from there the session token comes back and
this application's API verifies it against the published key.

So the whole path is: the browser starts the sign-in and keeps the challenge
cookie; Google sends the browser back with the verifier; the browser
redeems the verifier; the browser asks for the session token; the API
verifies that token's signature and starts this application's own session.

**And the sign-in has to happen in a popup.** This is the last piece, and it
is the one that makes the difference between a sign-in that works and one
that fails with `VERIFICATION_NOT_FOUND`. The session challenge cookie is
set `Partitioned`, and the OAuth round trip crosses origins - this
application, then Google, then the Auth service - so the cookie is not sent
when the callback arrives, the callback cannot write the challenge into the
verification row, and the redemption finds an empty row. A popup keeps the
round trip in one place, so the cookie is there when it is needed. The Auth
service's own client does the same thing, and says why: *"Handles social
sign-in via popup... This is necessary because OAuth redirects don't work in
iframes due to X-Frame-Options/CSP restrictions from OAuth providers."*

**How the verifier was found.** The Auth service's OpenAPI document does not
mention it, and Better Auth's source does not have it. It was found by
reading the database: `neon_auth.verification` holds a row per attempt, and
the row whose identifier is the short string in the callback URL is the
verifier. Its `value` is written a few seconds later, by the OAuth callback,
and holds the encrypted challenge. The row's `updatedAt` is the proof of
whether the callback saw the challenge cookie, which is what told the
partitioning story apart from everything else.

Two consequences worth remembering:

* the session token lasts a quarter of an hour while the session behind it
  lasts longer, so `useSession` renews it - asking the Auth service for a
  fresh one - whenever the API says there is no session;
* signing out has to end two sessions: this application's, and the Auth
  service's. The latter can only be ended by the browser, because only the
  browser holds the cookie.

The Google credentials belong to the Auth service, not to this application:
Neon enables Google with shared credentials by default, so the button works
on a fresh checkout.

**How to debug it.** The callback page reports every step - the verifier, the
redemption, the session token - rather than failing with one sentence. When
a sign-in stops working, that panel is the first thing to look at: it says
which step stopped and what the Auth service answered.

What was added, and why it is in the repository:

* `scripts/node/dev-api.ts` - the API handlers mounted on the Vite dev server. The
  handlers were written against structural interfaces rather than the Vercel
  types, so the same code runs in both places.
* `api/analyses.ts` - the route `src/lib/api.ts` had always called and that
  did not exist.
* `src/lib/ml/clientSemantic.ts` - the classifier in the browser, on the same
  weights and the same precision as the server and the harness.
* `scripts/python/provision-neon-local.py` - the database, from a connection string.
* `scripts/node/verify-*.ts`, `scripts/node/verify-e2e.mjs` - the checks behind the
  claims above.

Two bugs in `scripts/python/provision-neon-local.py` were fixed on 2026-10-21, and
both were found by running it, not by reading it:
* the password rotation said `alter role ... nosuperuser`, which Neon refuses
  with *"Only roles with the SUPERUSER attribute may change the SUPERUSER
  attribute"*. `neondb_owner` is not a superuser, so the statement failed and
  the script fell through to dropping the role - which then failed as well,
  because the role still held privileges on the schema, the tables and the
  sequences. The rotation now leaves the SUPERUSER attribute alone (it cannot
  be true: the role is only ever created with `nosuperuser`, and a
  non-superuser may not create a superuser role) and asserts the attribute
  afterwards instead of setting it.
* `drop role` cannot be used as the fallback at all: `neondb_owner` is not a
  member of `invisiphish_app` in the way the check requires, so `reassign
  owned by` and `drop owned by` are both refused.

---

> **This conversation was transferred to the VPS.** The T3 Code thread
> `e77a5af6-c292-4805-a95a-0203c9744063` (titled *"InvisiPhish: hybrid,
> explainable phishing detection"*) and the opencode session behind it
> (`ses_eaa296669ffeRGjfWfrOW00IAJ`, 317 messages) were copied from the laptop
> to this box, with the project re-pointed at `/home/av/invisiphish`. The
> original thread on the laptop is still there; this is a copy, not a move.
> Backups of the VPS databases were taken before the import and are named
> `*.bak-<timestamp>`.

---

## 1. Where things run

| Component | Where | Why |
|---|---|---|
| Model training (DistilBERT) | **Kaggle**, T4 GPU | 20 GPU-hours free; a VPS has no GPU and fine-tuning would take days |
| Evaluation harness | **Kaggle** (inside the same kernel) | It must run the same exported weights, on the same CPU budget |
| Code, credentials, supervision | **VPS** `av@100.95.166.116` (`~/invisiphish`) | Runs 24/7, so the run stays watched without the laptop open |
| Database | **Neon** (serverless Postgres) | Needs a managed Postgres with Row Level Security, not a box on a home network |
| Web app + API | Vercel (frontend) + Vercel functions (API) | The browser never holds a database URL or an API key |

**Rule of thumb: the laptop is an editor. The VPS is the control plane. Kaggle
is the compute.**

### The GitHub repository

`github.com/mrpaaradox/invisiphish` (private) is now the shared copy of the
project. The VPS holds the working tree and pushes to it; the MacBook pulls
from it. It carries the source, the results, the docs and the paper tables,
and the trained checkpoints as Git LFS objects.

`research/docs/TRANSFER_TO_MAC.md` is the script for the MacBook side. Two things to
know:

- The repository is **private**, so `git clone` over HTTPS needs
  authentication, and the release assets and LFS objects need a token.
- The release `v0.2.0-kaggle-run-2026-10-20` carries the three large files
  that do not belong in the repository history: `invisiphish-model.zip`,
  `invisiphish-results.zip` and the run log.

### The VPS

```bash
ssh av@100.95.166.116
cd ~/invisiphish
```

* Ubuntu 24.04, 4 vCPU, 7 GB RAM, 15 GB free, Node 18 (22 available under
  `/opt/node` if needed), Python 3.12, **no GPU**.
* `~/invisiphish` - the project, synced with `scripts/deploy/sync.sh`.
* `~/.research/kaggle/access_token` - the Kaggle token, `600`.
* `~/.config/invisiphish/env` - `KAGGLE_API_TOKEN`, `KAGGLE_BIN`,
  `HEARTBEAT_TOPIC`, `600`.
* `~/invisiphish/.env.local` - the application's own secrets, `600`.
* `~/invisiphish-logs/watcher.out` - the watcher's output.
* `~/invisiphish/kaggle/watch.log` - the watcher's timestamped status log.

The watcher is supervised by a cron entry, so it restarts if it dies:

```bash
ssh av@100.95.166.116 'tail -20 ~/invisiphish/kaggle/watch.log'
```

> `scripts/deploy/run-watcher.sh` is **generated** by `install-watcher.sh`, not
> tracked in the repository, so a `sync.sh` run from the laptop can delete it
> (the sync is `rsync --delete`). The cron entry then fails silently every
> five minutes and nothing supervises the run. If the watch log stops
> updating, recreate it with `bash scripts/deploy/install-watcher.sh`.

### Sync local -> VPS

```bash
scripts/deploy/sync.sh av@100.95.166.116
```

`node_modules`, `dist`, `.git` and the Hugging Face weights are excluded.

---

## 2. What is running right now

**Kaggle kernel `cptadityavyas/invisiphish-training-and-evaluation`** - the
training run. It trains DistilBERT on the phishing email corpus, exports ONNX,
then runs the evaluation harness and the baselines, and packages the results.

Watch it:

```bash
ssh av@100.95.166.116 'tail -5 ~/invisiphish/kaggle/watch.log'
# live stage messages
curl -s "https://ntfy.sh/invisiphish-kaggle-v1/json?poll=1&since=1h" | \
  python3 -c "import sys,json;[print(json.loads(l).get('message')) for l in sys.stdin if l.strip()]"
```

When it completes, the results are in `~/invisiphish/kaggle/output/`:

| File | Contents |
|---|---|
| `invisiphish-model.zip` | the exported ONNX checkpoint, three seeds |
| `invisiphish-results.zip` | `evaluation_phishing_emails.json`, `evaluation_sms_spam.json`, `baseline_*.json` |
| `invisiphish-training-and-evaluation.log` | the full run log |

### The run that finished (kernel version 11, 2026-10-20)

The run completed end to end. The results are in `research/results/` and the seed-13
checkpoint is installed at `public/models/distilbert-phishing/`.

**Verify these numbers before they go in the paper.** The table below was
produced by the run as it stood; the four bugs in the next section were found
while collecting it and they change some of the numbers. See
*"What the numbers need before publication"*.

| Corpus | | Accuracy | Precision | Recall | F1 | ROC-AUC |
|---|---|---|---|---|---|---|
| Phishing emails (82,485) | Full hybrid | 99.17 | 99.36 | 99.27 | **99.32** | 0.990 |
| | DistilBERT only | 99.17 | 99.30 | 99.34 | 99.32 | 1.000 |
| | TF-IDF + LinearSVC (baseline) | 99.34 | 99.28 | 99.46 | **99.37** | 0.993 |
| SMS Spam Collection (5,572) | Full hybrid | 90.52 | 76.02 | 45.11 | **56.39** | 0.820 |
| | DistilBERT only | 38.72 | 16.23 | 85.33 | 27.26 | 0.770 |
| | TF-IDF + LinearSVC (baseline) | 94.84 | 94.49 | 95.24 | **94.86** | 0.948 |

Two things to take from this table, and they are the paper's story:

- **On the phishing corpus the hybrid does not beat a plain TF-IDF +
  LinearSVC.** 99.32 against 99.37 is a tie inside the noise, and the
  baseline does not need a GPU.
- **On the SMS corpus the hybrid is much worse than the baseline** (F1 56.39
  against 94.86), because the corpus has no links for the URL module and
  only 13% positives for the pattern module. This is a property of the
  corpus, not of the pipeline, and it must be stated rather than averaged
  away.

The SMS evaluation is only now in the results at all: the corpus was never
mounted before, because the `uciml` copy ships `spam.csv` rather than
`SMSSpamCollection` and the notebook matched on the file name only.

### Collecting the output without exhausting memory

The Kaggle CLI downloads kernel output with `out.write(download_response.content)`,
which reads the whole file into RAM before writing it. This kernel's output
contains three 511 MB `optimizer.pt` checkpoints, so the CLI peaked above
1.5 GB resident and the 7 GB box stalled at 90% memory.

`scripts/kaggle/kaggle-fetch-output.py` replaces it. It lists the output through the
API, keeps only the files matched by `--include` (the two archives and the log),
streams each to disk in 1 MB chunks, resumes a partial file with a Range
request, and retries a broken transfer instead of starting over. Resident
memory stays flat regardless of file size.

```bash
python3 scripts/kaggle/kaggle-fetch-output.py --dest research/kaggle/output
```

The watcher now calls this script instead of the CLI, so a completed run no
longer pulls two and a half gigabytes of training checkpoints onto the box.

---

## 3. Bugs found and fixed

Every one of these was found by running the real pipeline against the real
corpus, not by the unit tests, and each would have broken the Kaggle run after
hours of GPU time.

| Bug | Symptom | Fix |
|---|---|---|
| FP-tree header chain linked backwards | Support counts truncated: `account` read 2 instead of 3 | The header points at the newest node; each node links back to the previous one |
| Pattern mining exploded on large corpora | **Out of memory** at 66k email bodies | Hard cap on itemsets, inverted-index support counting, adaptive support/length search |
| `stratifiedSplit` returned positives-then-negatives | Any slice-based cap silently produced a **single-class** evaluation set | Shuffle the combined split |
| `itemSupport` built from class-filtered postings | Every template looked equally rare, so one campaign monopolised the report | Build it from the combined corpus |
| Tokens unbounded in length | A reused phishing URL became one giant token that dominated every template | Cap token length at 24 characters |
| MPS ONNX export | `Placeholder storage has not been allocated on MPS device` | Move the model to CPU before exporting |
| `csv.Sniffer` guessing the delimiter | Different answer on a different Python version, so a different corpus was selected on Kaggle than locally | Derive the delimiter from the header line; pin the corpus file by name |
| `onnxscript` not installed | torch 2.8's ONNX exporter failed after training completed | Install `onnxscript`, and request the legacy exporter with `dynamo=False` |
| Learning rate 3×10⁻⁴ | The model collapsed: it predicted the majority class, F1 stayed 0, AUC drifted below 0.5 | Use 3×10⁻⁵, the standard range for a DistilBERT classification head |
| Un-chunked inference | 300 messages in one call built one enormous attention tensor: 17.7 msg/s | Chunk the batch: **262 msg/s**, a 15x speed-up |
| `baseline_svm.py --out` did not exist | The kernel failed in its last cell | The flag was added |
| A notebook patch inserted a call mid-line | `SyntaxError: invalid syntax` in cell 2 | The notebook is now **generated** by `research/kaggle/build_notebook.py`, which validates every cell parses |
| The corpus fallback picked the URL dataset | Trained on 549k URL rows instead of 82k email bodies | Name the phishing email corpus explicitly |
| The typecheck built projects the package does not contain | `TS18003: No inputs were found` for `vite.config.ts` and `api/`, so the kernel died **after** training, discarding the checkpoint | The notebook now builds only the projects whose input files are present in the training package |
| The SMS corpus was never mounted | The `uciml` copy of the SMS Spam Collection ships `spam.csv`, not `SMSSpamCollection`, so the name-based match missed it and the SMS evaluation was skipped | Identify the SMS corpus by its dataset directory name as well as by the classic file names |
| A failure in the last cell discarded the whole run | A single non-zero exit in the evaluation step threw away 95 minutes of GPU training | Each evaluation and baseline step reports its own failure instead of aborting the run |
| The watcher never noticed the run had finished | It tested the status for `*Complete*`, but the CLI reports `KernelWorkerStatus.COMPLETE`, so the watcher polled a finished kernel for four hours and never downloaded anything | Match the status case-insensitively |
| The Kaggle CLI exhausted memory on download | It reads each output file fully into RAM (`download_response.content`); with three 511 MB checkpoints resident memory passed 90% and the box stalled | `scripts/kaggle/kaggle-fetch-output.py` streams the files it needs in 1 MB chunks and skips the checkpoints |
| The evaluation's shuffle was biased | The swap index came from the **low** bits of a power-of-two LCG, whose low bits have a short period. The head of the shuffled array came out 60.9% positive against a corpus that is 52.2% positive, which silently skewed every capped evaluation set and made the label-only modules look far worse than they are | Take the swap index from the high bits: the capped head is now 51.7% positive |
| ROC-AUC was rounded to two decimals | A mean of 0.9961 was published as a perfect `1.0000` with a standard deviation of `0`, which reads as a bug in the table | ROC-AUC is reported to four decimals |
| The evaluation's test split overlapped the model's training rows | The model was trained on 20,000 rows drawn from the same corpus the harness then evaluated on, and the two used **different** splits, so roughly a quarter of the evaluated messages had been seen during training | The training script now writes `split_manifest.json` and the harness reuses that split |
| Repeated messages were split across both sides of the split | The SMS collection has 5,574 rows and 5,160 distinct messages; the phishing corpus 82,485 and 82,075. A duplicate could land in the training set and the test set at once | All three programs deduplicate on the raw message text before splitting |
| The baseline reported the wrong corpus | It hardcoded `"dataset": "SMS Spam Collection (UCI id 228)"`, so the phishing-email baseline labelled itself as the SMS corpus in the paper's tables | The name follows the file that was actually read |
| The baseline scored a different corpus from the harness | It deduplicated on normalised text (5,130 messages) while the harness used raw text (5,160), so the two columns of the paper's table were measured on different data | Both now deduplicate on the raw message text |
| The Auth service refused every sign-in | The request arrived without an `Origin` header, and the service answers `MISSING_ORIGIN` because it builds the callback URL from the origin | The API forwards the browser's own `Origin` header, unchanged |
| The Auth answer was read with the wrong shape | The service answers a sign-in with `{token, user}`, not `{session, user}`, so `result.data.session.id` threw *"Cannot read properties of undefined"* and nobody could sign in | The parser reads the shape the service actually sends. The session id is not what the database keys on: the RLS policies read `request.jwt.claims ->> 'sub'`, and the API sets that to the *user* id |
| The dev server kept a stale empty variable | Vite restarts the server in the same process when an env file changes, and the empty value loaded on the first start stayed in `process.env` and wedged out the value written later | An empty value no longer counts as set, so a later value can fill it |
| Signing out did nothing | The Auth service refuses a sign-out that carries `Content-Type: application/json` with no body (`FST_ERR_CTP_EMPTY_JSON_BODY`), and refuses one without the content type (`UNSUPPORTED_MEDIA_TYPE`), so the request never reached it and the session cookie was never cleared | A request with no body is sent as an empty JSON object |
| The dev server ran stale API handlers | The plugin cached the *handler function* per route, so an edit to a route - or to the library it imports - did not take effect until the dev server was restarted. This is how a fixed sign-out kept behaving as if it were unfixed | The module namespace is cached and the handler is read from it on every request, so Vite's invalidation reaches it |
| The audit log could not be written | `app.write_audit` was an ordinary function, so the insert ran as the restricted role, and `audit_log` has no insert policy by design | The helper is `SECURITY DEFINER` with a pinned search path. The user id still comes from the session variable, so a row can only be written for the signed-in user who caused it |

---

## 4. The findings that shape the paper

### The published accuracy does not beat a conventional baseline

| Model | Acc | Prec | Rec | F1 | ROC-AUC |
|---|---|---|---|---|---|
| TF-IDF char 3-5-gram + LinearSVC | 96.43 | 97.56 | 95.24 | **96.39** | 0.964 |
| The original paper's "full hybrid" | 94.20 | 93.10 | 95.60 | **94.33** | 0.972 |

The original submission reported no baseline, which made its headline figure
uninterpretable. ROC-AUC is the only metric where the hybrid leads, and only by
0.008.

### Hand-set fusion weights were the most damaging choice

With weights of 0.40 / 0.25 / 0.20 / 0.15 the hybrid scored F1 64.9 on the SMS
corpus, because the two modules with nothing to work with dragged the average
below the threshold. With weights **fitted on a validation split** the same
pipeline scored **93.7**. See `research/docs/adr/0003-fitted-fusion-weights.md`.

### A module's contribution is a property of the corpus

The SMS Spam Collection has no links, so the URL-intelligence module is
structurally unable to contribute and scores at the level of the majority class.
On phishing *email* bodies it has real signal. Any single-corpus ablation
hides this, which is why the original paper's ablation - in which every module
except DistilBERT scored below it - should be read as a property of the corpus.

### The generative explanation layer has no accuracy to ablate

Including it in an accuracy table, as the original submission did, mixes a
reporting layer with a detector and produces a difference that is inside
run-to-run noise. It is evaluated separately, on **groundedness**: the fraction
of claims that cite evidence the pipeline actually computed.

### What the numbers need before publication

The 99.17% on the phishing corpus is **not** yet a publishable number, for
three separate reasons. Each is fixable and each is cheap.

**1. The evaluation set overlaps the model's training rows.** The corpus is
82,485 messages. The model was trained on a 25,000-message cap of it, of which
80% (20,000 rows) went to the optimiser. The evaluation harness then split the
*whole* corpus again, with its own shuffle, and drew its test set from that.
The two splits are independent, so a test message had a **24.2%** chance of
having been trained on:

```
20000 / 82485 = 24.2%  of every evaluated message was seen in training
```

The fix is in place: `research/ml/train_distilbert.py` now writes a
`split_manifest.json` next to each checkpoint, listing the train and test
rows by SHA-256 of their text, and `scripts/node/eval.ts` rebuilds that split
instead of inventing one. Verified locally: 4,127 train + 1,033 test = 5,160
distinct messages, with **zero** overlapping hashes.

**2. Repeated messages were split across the train and test sides.** The
corpora contain exact duplicates - the SMS collection has 5,574 rows and only
5,160 distinct messages, the phishing corpus 82,485 and 82,075. A duplicated
message could land in the training set and the test set at the same time, and
a model that had memorised it was then scored on it. All three programs now
remove duplicates before splitting, using the same key (the raw message text):
the training script, the evaluation harness and the baseline.

**3. The harness evaluated one checkpoint three times.** `scripts/node/eval.ts`
loaded the model through `src/lib/ml/semanticModel.ts`, which caches a single
checkpoint under `public/models/distilbert-phishing/` - the seed-13 copy. The
three "seeds" in the table were three *data* splits evaluated against one
*model*, so the seed-to-seed spread is not model variance and cannot be
reported as a standard deviation over training runs. The semantic module now
exposes `loadSemanticModelFor`, and the harness loads `seed-13`, `seed-42` and
`seed-77` in turn. The per-seed checkpoints have to be unpacked beside the
primary one for this to take effect:

```
public/models/distilbert-phishing-seed13/
public/models/distilbert-phishing-seed42/
public/models/distilbert-phishing-seed77/
```

**4. The baseline and the hybrid were scored on different splits.**
`research/ml/baseline_svm.py` used scikit-learn's `train_test_split` with seed 42 over
the deduplicated corpus; the harness used its own split over the raw corpus.
The two numbers in the table were therefore not a like-for-like comparison,
which is exactly the comparison the paper's headline claim rests on. The
deduplication now matches, but the two programs still choose their split
separately; they should be given one shared split.

None of this changes the qualitative story - the hybrid still does not beat
TF-IDF + LinearSVC on either corpus - but the numbers should not be
published until they are measured on a clean split.

**The model's own held-out metrics are trustworthy.** The training script
evaluates each seed on the rows it held back, and those numbers come from the
log of the completed run:

| Seed | Accuracy | F1 | ROC-AUC |
|---|---|---|---|
| 13 | 98.82 | 98.82 | 0.9989 |
| 42 | 98.66 | 98.66 | 0.9990 |
| 77 | 99.10 | 99.10 | 0.9994 |
| **mean** | **98.86 ± 0.22** | **98.86 ± 0.22** | **0.9991 ± 0.0003** |

These are the DistilBERT-only figures on a clean split, and they are the
numbers to quote for the classifier. The hybrid's numbers still need the
harness re-run.

### The task was being evaluated on the wrong data

The original submission used a spam corpus to support a phishing claim. The
primary corpus is now a phishing email collection - 82,485 messages, 52.0%
malicious - with the SMS corpus retained as a secondary, deliberately
contrasting corpus.

---

## 5. The architecture, in one diagram

```
  browser  ──(session cookie)──▶  Vercel functions  ──(server-side secret)──▶  Neon Postgres
              no DB URL,                /api/analyze                          RLS + audit log
              no API key               /api/explain  ──▶ Gemini (evidence only)
                                       /api/feedback
```

Modules, all implementing one contract (`src/lib/ml/types.ts`):

| Module | File | What it does |
|---|---|---|
| FP-Growth patterns | `fpGrowth.ts`, `patternModule.ts` | Mines recurring scam templates and scores them by their likelihood ratio against both classes |
| DistilBERT | `semanticModel.ts` | Contextual classification, ONNX, batched inference |
| Intent | `intentAnalysis.ts` | Urgency, scarcity, authority, fear, reward cues, offline and deterministic |
| URL intelligence | `urlIntel.ts` | 12 structural signals: IP host, punycode, brand in subdomain, homoglyph, shortener, userinfo, tld, path, port |
| Aggregation | `aggregation.ts` | Weighted fusion with weight renormalisation and graceful degradation |
| Groundedness | `validation/groundedness.ts` | Validates every generated claim against the evidence table |

---

## 6. Next steps, in order

1. ~~**Collect the Kaggle output.**~~ **Done.** The run completed on
   2026-10-20; `research/results/` holds the four result files and the seed-13
   checkpoint is installed at `public/models/distilbert-phishing/`. The numbers
   are in the table in section 2. The story they tell is that the hybrid ties
   a plain TF-IDF baseline on the phishing corpus and loses to it on the SMS
   corpus.
2. **Re-run the kernel with the fixed evaluation.** The fixes are in the
   working tree: the training script writes a split manifest and deduplicates,
   the harness reuses that manifest and loads each seed's checkpoint, the
   baseline dedupes the same way and names the corpus it read. The fixes are
   only on this machine, so the **training package dataset**
   (`cptadityavyas/invisiphish-training-package`) has to be re-uploaded before
   the kernel is pushed again:
   ```bash
   kaggle datasets version -p . -d cptadityavyas/invisiphish-training-package
   kaggle kernels push -p research/kaggle/kernel
   ```
   The per-seed checkpoints also have to be unpacked beside the primary one,
   under `public/models/distilbert-phishing-seed{13,42,77}/`, so that the
   harness can score each of them. **Do this before step 3** - every table in
   the manuscript depends on it.
3. **Regenerate the tables.** The paper's tables are generated, never typed:
   ```bash
   python scripts/python/build_paper_tables.py \
       --evaluation research/results/evaluation_phishing_emails.json \
       --baseline research/results/baseline_phishing_emails.json \
       --output research/paper/tables_phishing.md
   ```
   The same command with `--evaluation research/results/evaluation_sms_spam.json
   --baseline research/results/baseline_sms_spam.json --output research/paper/tables_sms.md`
   produces the secondary table.
4. **Finish the manuscript.** `research/paper/InvisiPhish_v2_draft.md` is the working
   draft of every section that changes; the tables slot into the marked
   placeholders. `PAPER_REVISION.md` is the change list.
5. **Neon.** `python scripts/python/neon-provision.py --name invisiphish
   --region aws-us-east-1` creates the project, the restricted application
   role (no `BYPASSRLS`), enables Neon Auth and applies the migrations. It
   needs `NEON_API_KEY` and prints the `.env.local` block.
6. **Deploy.** Vercel for the frontend and the API functions; the Neon
   connection strings and `GEMINI_API_KEY` as server-side secrets.
7. **The application package.** A public GitHub repository, a demo video, a
   contribution memo stating what this author built specifically, and the
   statement-of-purpose paragraph. With seven authors on the paper, the memo is
   the cheapest high-leverage item on the list.

---

## 7. Known gaps

* Feedback is captured but not yet promoted into the pattern repository. The
  quorum and confidence gate are described in
  `db/migrations/0002_feedback_and_patterns.sql`; the promotion job is not
  written.
* Domain intelligence (RDAP) is not implemented.
* `api/analyses.ts` is referenced by the browser client but does not exist.
* CSV export does not neutralise spreadsheet formulas (see
  `research/docs/THREAT_MODEL.md`, T7).
* `DATABASE_URL` must use a role **without** `BYPASSRLS`, or the policies are
  decorative. `scripts/python/neon-provision.py` verifies this after applying the
  migrations.

---

## 8. The local environment

Only needed if something has to be debugged on the laptop.

```bash
# node
pnpm install
pnpm verify          # typecheck + 49 tests + production build

# python (system python 3.9, user site-packages)
python3 research/ml/fetch_datasets.py
python3 research/ml/train_distilbert.py --data research/ml/datasets/sms_spam.csv \
    --output-dir public/models/distilbert-phishing \
    --copy-primary-to public/models/distilbert-phishing/primary
python3 research/ml/export_onnx.py --model-dir public/models/distilbert-phishing
```

Kaggle CLI: `~/.venvs/kaggle/bin/kaggle` (Python 3.12 virtualenv). The system
Python 3.9 CLI cannot authenticate with a `KGAT_` token.

> The training script uses `onnxscript` for the ONNX export. It is installed
> on Kaggle and is worth adding to the local environment too.
