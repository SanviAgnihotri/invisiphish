# InvisiPhish

**Hybrid and explainable phishing detection.** InvisiPhish combines frequent pattern mining (FP-Growth), contextual semantic classification (DistilBERT), social-engineering intent analysis, and URL intelligence into a single score — and explains that score using only evidence the pipeline actually computed.

This repository is the implementation of the paper *"InvisiPhish: A Hybrid and Explainable Phishing Detection Framework Using FP-Growth, DistilBERT and Generative AI"*.

---

## Why this design

The paper's central argument is that no single signal is enough:

| Signal | Fails when |
|---|---|
| Keyword / blacklist rules | The message is paraphrased or uses an unseen template |
| FP-Growth template mining | The attacker rewrites the template |
| DistilBERT semantic classification | The malicious payload lives in the URL, not the prose |
| URL analysis only | The message contains no link at all |

So the modules are combined to cover each other's blind spots, and every module reports the *evidence* behind its score rather than just a number.

The second design decision is that **evidence is the only currency in the system**. A module cannot talk to the explanation layer directly. It publishes `Evidence` records; the aggregation engine scores from module results; and the generative layer receives a *closed table of computed evidence* and must cite it. Anything that cannot be traced back to computed evidence is dropped before a user ever sees it.

That constraint is what makes the paper's explainability claim checkable rather than aspirational — it is implemented in `src/lib/validation/groundedness.ts` and covered by tests.

---

## Architecture

```
                    ┌───────────────────────────────────────────┐
  SMS / email ─────▶│  preprocessing (tokenise, extract URLs)   │
                    └────────────────────┬──────────────────────┘
                                         │
                ┌────────────┬───────────┼───────────┬────────────────┐
                ▼            ▼           ▼           ▼                ▼
          ┌──────────┐ ┌───────────┐ ┌─────────┐ ┌────────────┐  ┌────────────┐
          │ FP-Growth│ │ DistilBERT│ │ intent  │ │ URL intel  │  │ domain     │
          │ patterns │ │ (semantic)│ │ (urgency│ │ (structure,│  │ intel      │
          │          │ │           │ │  scarcity│ │  brand,    │  │ (RDAP age, │
          │          │ │           │ │  authority│ │  tld,     │  │  registrar)│
          │          │ │           │ │  fear,   │ │  shortener)│  │            │
          │          │ │           │ │  reward) │ │            │  │            │
          └────┬─────┘ └─────┬─────┘ └────┬────┘ └─────┬──────┘  └─────┬──────┘
               │             │            │            │               │
               └─────────────┴──────┬─────┴────────────┴───────────────┘
                                    ▼
                      ┌───────────────────────────────┐
   browser ─────────▶│  /api/analyze  (Vercel)      │
                      │  aggregation engine           │
                      │  weights fitted on a val split│
                      └───────────────┬───────────────┘
                                      ▼
                      ┌───────────────────────────────┐
                      │  /api/explain                 │
                      │  GenAI, constrained           │
                      │  → groundedness validation    │
                      └───────────────┬───────────────┘
                                      ▼
                             verdict + rationale
                                      │
                      ┌───────────────┴───────────────┐
                      ▼                               ▼
              Neon (Postgres) + RLS           /api/feedback
              analysis_results, audit log      confirmed / corrected
```

**The browser never holds a database credential or an API key.** It talks only to the API routes, which verify the Neon Auth session and let Row Level Security decide what the caller may read or write.

---

## Paper ↔ implementation status

| Paper component | Status | Where |
|---|---|---|
| Preprocessing & feature engineering | ✅ | `src/lib/ml/preprocessing.ts`, `src/lib/ml/tokenize.ts` |
| FP-Growth pattern mining | ✅ | `src/lib/ml/fpGrowth.ts` |
| Discriminative template scoring (lift) | ✅ | `src/lib/ml/patternModule.ts` |
| Intent / manipulation signals | ✅ | `src/lib/ml/intentAnalysis.ts` |
| URL intelligence (12 structural signals) | ✅ | `src/lib/ml/urlIntel.ts` |
| Aggregation engine (central fusion) | ✅ | `src/lib/ml/aggregation.ts` |
| **Fitted fusion weights** (validation split) | ✅ | `scripts/node/eval.ts` |
| Evidence-grounded explanation validation | ✅ | `src/lib/validation/groundedness.ts` |
| DistilBERT semantic classification | ✅ | `src/lib/ml/semanticModel.ts` (ONNX, via `@xenova/transformers`) |
| Authentication (Neon Auth) | ✅ | `api/_lib/auth.ts`, `src/lib/auth/session.ts` |
| Google sign-in | ✅ | `api/_lib/jwt.ts`, `src/pages/auth/GoogleButton.tsx` |
| Row Level Security | ✅ | `db/migrations/0001_schema.sql` |
| Audit trail | ✅ | `db/migrations/0002_feedback_and_patterns.sql` |
| Client interface | ✅ | `src/pages/`, `src/components/` |
| Analysis persistence | ✅ | `api/analyze.ts` |
| Evidence-grounded GenAI explanation | ✅ | `api/_lib/explain.ts` (server-side, constrained) |
| Feedback loop | ✅ (capture) | `api/feedback.ts` |
| Feedback → pattern promotion | 🚧 | poisoning defences described, promotion pending |
| Domain intelligence (RDAP) | 🚧 | planned |
| Evaluation harness | ✅ | `scripts/node/eval.ts` |
| Baseline comparison | ✅ | `research/ml/baseline_svm.py` |
| Multi-seed training | ✅ | `research/ml/train_distilbert.py`, `research/kaggle/` |

A module that cannot run reports `skipped` rather than inventing a score, and the aggregation engine redistributes its weight to the modules that did run. **A missing model can never be mistaken for a clean message.**

---

## Quick start

```bash
pnpm install
cp .env.example .env.local     # Neon connection strings, Neon Auth URL, OpenCode key
python3 scripts/python/provision-neon-local.py   # the role, the schema and .env.local
pnpm dev
```

The project is built with **pnpm** (`pnpm-workspace.yaml` carries the pnpm
settings, and `packageManager` in `package.json` pins the version). `pnpm
install` is the only install step.

```bash
pnpm verify                 # typecheck + tests + production build
pnpm test                       # vitest
pnpm typecheck
pnpm verify:explain              # the explanation layer against the real model
pnpm verify:session              # the session bridge a Google sign-in uses
pnpm verify:e2e                  # the whole path against the real database
```

### Environment variables

Everything is read on the **server**. There is deliberately no `VITE_*` variable.

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Restricted Neon role. Must **not** have `BYPASSRLS`. |
| `DATABASE_ADMIN_URL` | Owner role. Migrations and background jobs only. |
| `NEON_AUTH_BASE_URL` | Managed Better Auth service URL. |
| `OPENCODE_API_KEY` | Server-side only. Generates the explanation with an OpenCode Go model. Without it the explanation layer falls back to a deterministic, still-grounded summary. || `OPENCODE_MODELS` | The models tried in order; the first that answers is used. Defaults to `glm-5.3-flash,mimo-v2.6-flash,qwen3.8-flash,mimo-v2.5,hy3,longcat-2.0`. |
| `OPENCODE_MODEL` | The model to start with. Defaults to `glm-5.3-flash`. |
| `OPENCODE_BASE_URL` | Defaults to `https://opencode.ai/inference/go/openai/v1`. |
| `EXPLAIN_PROVIDER` | `opencode` (default) or `gemini`. |
| `GEMINI_API_KEY` | The original provider, kept as an alternative. Unused while `EXPLAIN_PROVIDER` is `opencode`. |
| `GEMINI_MODEL` | Defaults to `gemini-3.8-flash`. |
| `MODEL_DIR` | Where the exported ONNX checkpoint lives. |

---

## Reproducing the paper's tables

```bash
python research/ml/fetch_datasets.py                      # SMS Spam Collection (UCI)
pnpm baseline                                 # TF-IDF + LinearSVC baseline
pnpm eval -- --seeds 13,42,77                 # the shipped pipeline
```

`scripts/node/eval.ts` imports `src/lib/ml/*` exactly as the browser and the API do, so **the numbers in the paper are produced by the code that ships**. It writes `research/results/evaluation.json` containing:

- **Table 1** — main results, with the fusion weights fitted on a validation split, reported alongside the hand-set defaults
- **Table 2** — a corrected ablation: single-module and leave-one-out
- **Table 3** — mined FP-Growth templates with their measured lift
- **Table 4** — system evaluation: per-module latency

### Training

Locally (Apple Silicon uses MPS):

```bash
python research/ml/train_distilbert.py --data research/ml/datasets/sms_spam.csv \
  --output-dir public/models/distilbert-phishing \
  --copy-primary-to public/models/distilbert-phishing/primary
```

On Kaggle (GPU, unattended) — see [`research/kaggle/README.md`](research/kaggle/README.md):

```bash
scripts/kaggle/kaggle-run.sh <kaggle-username>   # push the kernel, wait, download the model
scripts/kaggle/kaggle-watch.sh                   # poll a running kernel and fetch the output
```

---

## The module contract

Every detection module implements the same shape (`src/lib/ml/types.ts`):

```ts
interface ModuleResult {
  module: ModuleId;
  status: 'ok' | 'skipped' | 'error';
  score: number;        // 0..1 phishing probability
  confidence: number;   // 0..1 confidence in that score
  evidence: Evidence[]; // the reasons, with stable ids
  latencyMs: number;
  error?: string;
}
```

Adding a new detector means producing a `ModuleResult`. Nothing else has to change.

---

## Project layout

```
api/                   Vercel functions (the only surface the browser touches)
  _lib/                db access, Neon Auth client, explanation layer, http helpers
  analyze.ts           run the pipeline, persist the trace
  explain.ts           grounded explanation
  feedback.ts          user corrections
  auth.ts session.ts   sign in / up / out
db/migrations/         Neon schema, RLS policies, pattern repository, audit log
server/                the Node server entry (bundled to dist-server/)
src/
  pages/               one folder per route: landing, auth, dashboard
  components/          shared UI: the brand, the route guards
  lib/
    ml/                the detection pipeline
    validation/        groundedness validation
    auth/              session state
    api.ts             typed browser client for the API
scripts/
  node/                evaluation harness, verifiers, the dev API, the prerender
  python/              dataset, table and provisioning helpers
  kaggle/              kernel helpers
  deploy/              VPS provisioning, sync and transfer
research/
  ml/                  training, export, baselines, dataset preparation
  kaggle/              notebook, kernel metadata, run instructions
  paper/               the manuscript and its tables
  results/             evaluation output
  samples/             messages to try the application on
  docs/                threat model, ADRs, handoff notes
tests/                 vitest suites
```

---

## Signing in

There are two ways in, and they reach the database by different roads.

**Email and password.** The Auth service issues its own signed cookie, the API
forwards it to the browser and back again, and the service is asked who the
caller is. The cookie is http-only and never reaches client-side JavaScript.

**Google.** The OAuth flow has to happen in the browser, because the Auth
service's state for it is held in cookies on the Auth service's own domain,
and a cookie cannot be set for a domain by a server that is not on it. The
session the flow creates therefore lives on the Auth service's domain too,
where this application cannot see it — and the raw session token is not
accepted in place of the cookie, so it cannot be carried over by hand.

What the browser *can* bring back is the session token: a JWT the Auth
service signs, and publishes the key for at
`{NEON_AUTH_BASE_URL}/.well-known/jwks.json`. The API checks that signature
itself, against the service's own public key, rather than taking the
browser's word for who the user is. The session token lasts a quarter of an
hour while the session behind it lasts longer, so the browser asks for a
fresh one when it needs it.

The Google credentials belong to the Auth service, not to this application.
Neon enables Google with shared credentials by default, so it works on a
fresh checkout; add your own in the Neon console when you want users to see
your name on Google's consent screen rather than Neon's.

`pnpm verify:session` checks the whole bridge, including that a forged
token is refused.

---

## Sample messages

`research/samples/` holds messages to try the application on, so that there is
something to paste into the text box and something to upload without having
to invent a phishing message yourself.

| File | What it is |
|---|---|
| `phishing-account-suspension.txt` | Account suspension, an IP address in the link, urgency, fear |
| `phishing-customs-fee.txt` | A small customs fee, a URL shortener, a deadline |
| `legitimate-meeting-notes.txt` | Ordinary working correspondence |
| `legitimate-invoice.txt` | An invoice with an amount and a due date |
| `short-phishing.txt` | The same phishing message as one line, for pasting |
| `short-legitimate.txt` | The same legitimate message as one line, for pasting |
| `messages.csv` | Twenty labelled messages, `label,message`, in the format the evaluation harness reads |

`pnpm verify:samples` runs the pipeline over them and prints what to
expect:

```
legitimate-invoice.txt           legitimate    0.0%   1 evidence
phishing-account-suspension.txt  phishing     72.4%   7 evidence
phishing-customs-fee.txt         suspicious   55.2%   3 evidence
...
20 of 20 right (100.0%)
```

Two things to know about the dashboard. The verdict has **three** values, not
two: `legitimate` below 40%, `suspicious` from 40% to 70%, and `phishing` at
70% and above. And the file upload treats the whole file as **one message** -
it is read as text and analysed as a single message - so upload one of the
`.txt` files above rather than the CSV. The CSV is for the evaluation
harness, not for the upload box.

---

## Tests

```bash
pnpm test
```

- `fpGrowth.test.ts` — support counts, threshold behaviour, association rules, matching
- `urlIntel.test.ts` — every structural signal, registrable-domain extraction, score combination
- `aggregation.test.ts` — weight renormalisation, verdict thresholds, confidence damping, degradation
- `groundedness.test.ts` — rejection of ungrounded claims, closed action vocabulary
- `intentAnalysis.test.ts` — every manipulation dimension, bounds, neutral messages

---

## Security notes

- The Neon **application role** must not have `BYPASSRLS`; the owner role is reserved for migrations.
- No third-party API key is ever compiled into the client bundle.
- The generative explanation layer receives **computed evidence only**, never the raw attacker-controlled message, which removes the prompt-injection surface at that step. Its output is validated against the evidence table before display.
- Feedback is captured but not applied to the pattern repository immediately: promotion requires several distinct users to agree, which is the poisoning defence described in the paper's limitations.

---

## License

MIT
