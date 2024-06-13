/**
 * Semantic classification module (DistilBERT).
 *
 * The paper's semantic module encodes a message into contextual embeddings and
 * passes them through a classification head that outputs a phishing probability.
 *
 * The checkpoint is produced by `research/ml/train_distilbert.py` and exported to ONNX so
 * that the *same weights* run in the browser and in the Node evaluation
 * harness. That means the numbers in the paper are produced by exactly the
 * code that ships in the app.
 *
 * When the checkpoint is absent the module reports `skipped` rather than
 * inventing a score, and the aggregation engine redistributes its weight to
 * the modules that did run.
 */

import { env, pipeline } from '@xenova/transformers';
import type { Evidence, ModuleResult } from '@/lib/ml/types';

/** Folder name under `public/models/` that holds the exported checkpoint. */
export const SEMANTIC_MODEL_ID = 'distilbert-phishing';

const isNode = typeof window === 'undefined';

// In Node the models live under public/models; in the browser they are served
// from /models by the static file server.
if (isNode) {
  const nodeEnv = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env;
  env.localModelPath = nodeEnv?.MODEL_DIR || './public/models/';
}
env.allowLocalModels = true;

// Browsers cannot use threads unless the page sets cross-origin isolation
// headers, so the WASM backend stays single threaded there.
if (!isNode) {
  env.backends.onnx.wasm.numThreads = 1;
}

type LabelEntry = { label: string; score: number };

type Classifier = (
  input: string | string[],
  options?: Record<string, unknown>,
) => Promise<LabelEntry[] | LabelEntry[][]>;

let classifierPromise: Promise<Classifier | null> | null = null;

/**
 * The checkpoint currently cached, if any.
 *
 * The evaluation harness scores one checkpoint per training seed. It loads
 * them in turn through `loadSemanticModelFor`, which resets this cache, so
 * the model under test is always the one the harness asked for.
 */
let loadedModelId: string = SEMANTIC_MODEL_ID;

/**
 * Load a specific checkpoint, replacing whatever is cached.
 *
 * The default id is the shipped one under `public/models/`. The evaluation
 * harness passes a per-seed directory so that the seed-to-seed spread it
 * reports is a spread over *models* rather than a spread over data splits
 * scored against one model.
 */
export async function loadSemanticModelFor(modelId: string): Promise<Classifier | null> {
  if (loadedModelId !== modelId) {
    classifierPromise = null;
    loadedModelId = modelId;
  }
  return loadSemanticModel();
}

/**
 * Whether to use the int8 export instead of the float32 one.
 *
 * The browser and the evaluation harness must use the same weights, otherwise
 * the numbers in the paper are not the numbers a user sees. Both sides read
 * the same flag: `SEMANTIC_QUANTIZED` on the server, `VITE_SEMANTIC_QUANTIZED`
 * in the browser build.
 */
function quantizedRequested(): boolean {
  const nodeEnv = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env;

  if (nodeEnv?.SEMANTIC_QUANTIZED) return nodeEnv.SEMANTIC_QUANTIZED === '1';

  const buildEnv =
    typeof __INVISIPHISH_QUANTIZED__ === 'undefined' ? undefined : __INVISIPHISH_QUANTIZED__;

  return buildEnv === '1';
}

/** Load the classifier once and cache it. */
export async function loadSemanticModel(): Promise<Classifier | null> {
  if (!classifierPromise) {
    classifierPromise = (async () => {
      try {
        const model = (await pipeline('text-classification', loadedModelId, {
          quantized: quantizedRequested(),
        })) as unknown as Classifier;
        return model;
      } catch {
        return null;
      }
    })();
  }
  return classifierPromise;
}

/** Reset the cached model. Used by tests and by the "reload model" action. */
export function resetSemanticModel(): void {
  classifierPromise = null;
}

/**
 * True when the checkpoint can actually be loaded.
 * Cheap to call: it reuses the cached promise.
 */
export async function isSemanticModelAvailable(): Promise<boolean> {
  return (await loadSemanticModel()) !== null;
}

export async function runSemanticModule(text: string): Promise<ModuleResult> {
  const startedAt = performance.now();

  try {
    const classifier = await loadSemanticModel();

    if (!classifier) {
      return {
        module: 'semantic',
        status: 'skipped',
        score: 0,
        confidence: 0,
        evidence: [],
        latencyMs: performance.now() - startedAt,
        error: `Semantic checkpoint "${SEMANTIC_MODEL_ID}" not found. Run research/ml/train_distilbert.py to build it.`,
      };
    }

    const output = await classifier(text);
    const entries = (
      Array.isArray(output[0]) ? output[0] : output
    ) as LabelEntry[];
    const phishing = entries.find((entry) => /phish|spam|malicious|label_1/i.test(entry.label));
    const score = Number(phishing?.score ?? 0);

    const evidence: Evidence[] = [
      {
        id: 'ev_semantic_score',
        kind: 'semantic',
        module: 'semantic',
        label: 'Contextual semantic classification',
        detail: `The DistilBERT classifier assigned a phishing probability of ${(score * 100).toFixed(1)}% to this message.`,
        score,
        severity: 1,
        meta: { modelId: SEMANTIC_MODEL_ID, rawLabel: phishing?.label },
      },
    ];

    return {
      module: 'semantic',
      status: 'ok',
      score,
      confidence: 0.85,
      evidence,
      latencyMs: performance.now() - startedAt,
    };
  } catch (error) {
    return {
      module: 'semantic',
      status: 'error',
      score: 0,
      confidence: 0,
      evidence: [],
      latencyMs: performance.now() - startedAt,
      error: error instanceof Error ? error.message : 'Unknown error in semantic analysis',
    };
  }
}

/**
 * Run the semantic module over a batch of messages.
 *
 * The ONNX runtime batches far more efficiently than one message at a time,
 * which is what makes evaluating the full pipeline over a whole corpus
 * practical.
 */
export async function runSemanticModuleBatch(texts: string[]): Promise<ModuleResult[]> {
  const startedAt = performance.now();

  if (texts.length === 0) return [];

  try {
    const classifier = await loadSemanticModel();

    if (!classifier) {
      const error = `Semantic checkpoint "${SEMANTIC_MODEL_ID}" not found. Run research/ml/train_distilbert.py to build it.`;
      return texts.map(() => ({
        module: 'semantic' as const,
        status: 'skipped' as const,
        score: 0,
        confidence: 0,
        evidence: [],
        latencyMs: 0,
        error,
      }));
    }

    // The texts are classified in chunks. A single call with thousands of
    // messages builds one enormous attention tensor, which is both slow and
    // memory hungry; the attention cost of a batch grows quadratically with
    // the batch size.
    const CHUNK = 64;
    const perMessage: LabelEntry[][] = [];

    for (let start = 0; start < texts.length; start += CHUNK) {
      const chunk = texts.slice(start, start + CHUNK);
      const raw = await classifier(chunk);
      const entries: LabelEntry[][] = (Array.isArray(raw[0])
        ? raw
        : (raw as LabelEntry[]).map((entry) => [entry])) as LabelEntry[][];
      perMessage.push(...entries);
    }

    const perCall = (performance.now() - startedAt) / texts.length;

    return texts.map((_text, index) => {
      const entries: LabelEntry[] = perMessage[index] ?? [];
      const phishing = entries.find((entry) => /phish|spam|malicious|label_1/i.test(entry.label));
      const score = Number(phishing?.score ?? 0);

      return {
        module: 'semantic' as const,
        status: 'ok' as const,
        score,
        confidence: 0.85,
        evidence: [
          {
            id: 'ev_semantic_score',
            kind: 'semantic' as const,
            module: 'semantic' as const,
            label: 'Contextual semantic classification',
            detail: `The DistilBERT classifier assigned a phishing probability of ${(
              score * 100
            ).toFixed(1)}% to this message.`,
            score,
            severity: 1,
            meta: { modelId: SEMANTIC_MODEL_ID },
          },
        ],
        latencyMs: perCall,
      };
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error in semantic analysis';
    return texts.map(() => ({
      module: 'semantic' as const,
      status: 'error' as const,
      score: 0,
      confidence: 0,
      evidence: [],
      latencyMs: 0,
      error: message,
    }));
  }
}

/**
 * Legacy helper kept for the existing dashboard wiring.
 * Returns a neutral 0.5 when the checkpoint is unavailable so that a missing
 * model can never be mistaken for a clean message.
 */
export async function predictPhishing(text: string): Promise<number> {
  const result = await runSemanticModule(text);
  return result.status === 'ok' ? result.score : 0.5;
}
