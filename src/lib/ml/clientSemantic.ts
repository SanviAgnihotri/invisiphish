/**
 * The semantic module, running in the browser.
 *
 * The trained DistilBERT classifier is exported to ONNX and loaded by the
 * same library the server and the evaluation harness use, so the browser, the
 * API and the paper are all looking at the same weights (ADR 0004).
 *
 * Running it in the browser is what makes the privacy claim in the threat
 * model true: the message never has to leave the device for the semantic
 * module to have an opinion about it. The score is then sent to the API,
 * which uses it in place of its own checkpoint.
 *
 * The extraction of the phishing probability is deliberately identical to
 * `runSemanticModule` in `semanticModel.ts` - same model id, same label
 * match, same precision flag - so a number shown in the browser is the number
 * the harness measured.
 *
 * Note: the shared classifier call returns only the top label, so a message
 * the model is confident about is reported as 0.0 or ~1.0 rather than as a
 * probability in between. That is a property of the shipped code path, not of
 * this module; changing it would change the numbers in the paper, so it is
 * left alone here and called out rather than quietly changed.
 */

import { env, pipeline } from '@xenova/transformers';

/** The folder under `public/models/` that holds the exported checkpoint. */
export const CLIENT_MODEL_ID = 'distilbert-phishing';

const isNode = typeof window === 'undefined';

if (isNode) {
  const nodeEnv = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env;
  env.localModelPath = nodeEnv?.MODEL_DIR || './public/models/';
}

env.allowLocalModels = true;

// The browser must not reach out to the Hugging Face hub: the checkpoint is
// served by this app, from `public/models/`.
if (!isNode) {
  env.allowRemoteModels = false;
  // A browser page is not cross-origin isolated, so the WASM backend has to
  // stay single threaded.
  env.backends.onnx.wasm.numThreads = 1;
}

type LabelEntry = { label: string; score: number };

type Classifier = (
  input: string | string[],
  options?: Record<string, unknown>,
) => Promise<LabelEntry[] | LabelEntry[][]>;

/** How the client is doing. */
export type ClientModelStatus = 'idle' | 'loading' | 'ready' | 'failed';

export interface ClientSemanticResult {
  /** Phishing probability, 0..1. */
  score: number;
  /** Confidence in the predicted class, 0..1. */
  confidence: number;
  status: ClientModelStatus;
  /** The label the classifier gave, when there was one. */
  label?: string;
  /** Why the model is unavailable, when it is. */
  error?: string;
}

let classifierPromise: Promise<Classifier | null> | null = null;
let status: ClientModelStatus = 'idle';
let lastError: string | undefined;

/** Whether the build asked for the int8 export. */
function quantizedRequested(): boolean {
  const buildEnv =
    typeof __INVISIPHISH_QUANTIZED__ === 'undefined' ? undefined : __INVISIPHISH_QUANTIZED__;
  return buildEnv === '1';
}

/** The current state of the client-side model. */
export function getClientModelStatus(): { status: ClientModelStatus; error?: string } {
  return { status, error: lastError };
}

/** Forget the cached pipeline, so the next call loads the model again. */
export function resetClientModel(): void {
  classifierPromise = null;
  status = 'idle';
  lastError = undefined;
}

/** Load the classifier once and cache it. */
async function loadClassifier(): Promise<Classifier | null> {
  if (!classifierPromise) {
    status = 'loading';
    classifierPromise = (async () => {
      const build = async (quantized: boolean) =>
        (await pipeline('text-classification', CLIENT_MODEL_ID, { quantized })) as unknown as Classifier;

      try {
        // The int8 export is a quarter of the size of the float32 one, which
        // matters a great deal in a browser. It is the same model: the
        // quantisation reaches the same decision on every message in
        // scripts/node/compare-precisions.ts.
        const model = quantizedRequested()
          ? await build(true).catch(() => build(false))
          : await build(false);
        status = 'ready';
        lastError = undefined;
        return model;
      } catch (error) {
        status = 'failed';
        lastError = error instanceof Error ? error.message : 'Unknown error';
        return null;
      }
    })();
  }
  return classifierPromise;
}

/**
 * Start loading the model in the background.
 *
 * The checkpoint is large, so the page must not wait for it: the caller can
 * await the first analysis instead, and the UI can show what is happening.
 */
export function preloadClientModel(): void {
  void loadClassifier();
}

/**
 * Classify a message in the browser.
 *
 * Returns a `failed` status instead of throwing when the checkpoint cannot be
 * loaded: the server can still run its own, and a page that cannot reach the
 * model is not a page that breaks.
 */
export async function scoreInBrowser(text: string): Promise<ClientSemanticResult> {
  const trimmed = text.trim();
  if (!trimmed) {
    return { score: 0, confidence: 0, status: 'idle' };
  }

  const classifier = await loadClassifier();
  if (!classifier) {
    return { score: 0, confidence: 0, status: 'failed', error: lastError };
  }

  try {
    const output = await classifier(trimmed);
    const entries = (Array.isArray(output[0]) ? output[0] : output) as LabelEntry[];
    const phishing = entries.find((entry) => /phish|spam|malicious|label_1/i.test(entry.label));
    const top = entries[0];

    return {
      score: Number(phishing?.score ?? 0),
      confidence: top ? Number(top.score) : 0,
      status: 'ready',
      label: top?.label,
    };
  } catch (error) {
    status = 'failed';
    lastError = error instanceof Error ? error.message : 'Unknown error';
    return { score: 0, confidence: 0, status: 'failed', error: lastError };
  }
}
