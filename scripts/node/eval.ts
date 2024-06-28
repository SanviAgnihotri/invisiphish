/**
 * Evaluation harness for InvisiPhish.
 *
 * This script runs the *shipped* detection pipeline over a labelled dataset
 * and produces the tables that the paper reports. Nothing here re-implements
 * the detector: it imports `src/lib/ml/*` exactly as the browser and the API
 * do, so the numbers in the paper are produced by the code that ships.
 *
 * It produces:
 *   - Table 1  main results, with the fusion weights fitted on a validation
 *               split and reported alongside the hand-set defaults
 *   - Table 2  a corrected ablation (single-module and leave-one-out)
 *   - Table 3  mined FP-Growth templates with their measured lift
 *   - Table 4  system evaluation: per-module latency
 *
 * Usage:
 *   npm run eval
 *   npm run eval -- --seeds 13,42,77 --dataset research/ml/datasets/phishing.csv
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { aggregate, type ModuleWeight } from '../../src/lib/ml/aggregation';
import { runIntentModule } from '../../src/lib/ml/intentAnalysis';
import {
  describeTopPatterns,
  mineDiscriminativePatterns,
  runPatternModule,
} from '../../src/lib/ml/patternModule';
import { loadSemanticModelFor, runSemanticModuleBatch } from '../../src/lib/ml/semanticModel';
import { buildTransactions } from '../../src/lib/ml/tokenize';
import { runUrlModule } from '../../src/lib/ml/urlIntel';
import type { ModuleId, ModuleResult } from '../../src/lib/ml/types';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const ALL_MODULES: ModuleId[] = ['semantic', 'url-intel', 'pattern', 'intent'];

/** Minimum number of messages the evaluation needs before it is meaningful. */
const MIN_TEST_SIZE = 200;

// --------------------------------------------------------------------------
// Data
// --------------------------------------------------------------------------

/** Minimal RFC 4180 CSV reader. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') inQuotes = true;
    else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') field += char;
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((entry) => entry.length > 1);
}

interface Sample {
  label: number;
  text: string;
}

function loadSamples(path: string): Sample[] {
  const rows = parseCsv(readFileSync(path, 'utf-8'));
  const header = rows[0].map((entry) => entry.trim().toLowerCase());
  const labelIndex = header.indexOf('label');
  const textIndex = header.indexOf('message') >= 0 ? header.indexOf('message') : header.length - 1;

  const samples = rows.slice(1).map((row) => ({
    label: row[labelIndex].trim().toLowerCase() === 'spam' ? 1 : 0,
    text: row[textIndex],
  }));

  // Repeated messages are dropped, so that the same text cannot appear on
  // both sides of a split and so that the harness and the baseline score the
  // same corpus. The SMS Spam Collection has 5,574 rows and 5,160 distinct
  // messages; the phishing corpus has 82,485 rows and 82,075 distinct ones.
  const seen = new Set<string>();
  const unique: Sample[] = [];

  for (const sample of samples) {
    if (seen.has(sample.text)) continue;
    seen.add(sample.text);
    unique.push(sample);
  }

  return unique;
}

/** Deterministic shuffle. */
function shuffle(items: Sample[], seed: number): Sample[] {
  const copy = [...items];
  let state = seed >>> 0;
  for (let index = copy.length - 1; index > 0; index -= 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    // The swap index must come from the HIGH bits of the generator. The low
    // bits of a power-of-two LCG have a short period, so using them here
    // leaves the permutation biased: the head of the shuffled array came out
    // 60.9% positive against a corpus that is 52.2% positive, which silently
    // skewed every capped evaluation set and made the label-only modules look
    // far worse than they are.
    const swap = (state >>> 16) % (index + 1);
    [copy[index], copy[swap]] = [copy[swap], copy[index]];
  }
  return copy;
}

/** Stratified split so both classes keep their proportion. */
function stratifiedSplit(samples: Sample[], testSize: number, seed: number) {
  const positives = samples.filter((sample) => sample.label === 1);
  const negatives = samples.filter((sample) => sample.label === 0);

  const shuffledPositives = shuffle(positives, seed);
  const shuffledNegatives = shuffle(negatives, seed + 1);

  const cutPositive = Math.floor(shuffledPositives.length * (1 - testSize));
  const cutNegative = Math.floor(shuffledNegatives.length * (1 - testSize));

  // The combined arrays are shuffled as well. Concatenating the two classes
  // would leave every positive first, and slicing the head of such an array
  // would silently produce a single-class evaluation set.
  return {
    train: shuffle(
      [
        ...shuffledPositives.slice(0, cutPositive),
        ...shuffledNegatives.slice(0, cutNegative),
      ],
      seed + 2,
    ),
    test: shuffle(
      [
        ...shuffledPositives.slice(cutPositive),
        ...shuffledNegatives.slice(cutNegative),
      ],
      seed + 3,
    ),
  };
}

// --------------------------------------------------------------------------
// Reusing the model's own split
// --------------------------------------------------------------------------

/** A split recorded by the training script. */
type SplitManifest = {
  seed: number;
  train_size: number;
  test_size: number;
  train: Array<{ label: number; sha256: string }>;
  test: Array<{ label: number; sha256: string }>;
};

/**
 * The directory holding a seed's checkpoint.
 *
 * The shipped model lives under `public/models/`. A multi-seed run keeps the
 * per-seed checkpoints beside it, so that the harness can score each one.
 */
function modelDirFor(seed: number): string {
  const primary = `public/models/distilbert-phishing`;
  const perSeed = `public/models/distilbert-phishing-seed${seed}`;
  return existsSync(resolve(ROOT, perSeed)) ? perSeed : primary;
}

/**
 * The model id the ONNX pipeline resolves against `MODEL_DIR`.
 *
 * `MODEL_DIR` points at `public/models/`, so the id is the directory name
 * relative to it.
 */
function modelIdFor(modelRoot: string): string {
  const marker = 'public/models/';
  const index = modelRoot.indexOf(marker);
  return index >= 0 ? modelRoot.slice(index + marker.length) : modelRoot;
}

/** Read a seed's split manifest, if the training script wrote one. */
function loadSplitManifest(modelRoot: string): SplitManifest | null {
  const path = resolve(ROOT, modelRoot, 'split_manifest.json');
  if (!existsSync(path)) return null;

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as SplitManifest;
    if (!Array.isArray(parsed.test) || parsed.test.length === 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** SHA-256 of a message, matching what the training script recorded. */
function messageDigest(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

/**
 * Rebuild the model's own train/test split from the manifest.
 *
 * The manifest lists the messages by digest, so the rows are matched against
 * the corpus by content rather than by position: the corpus order changes
 * whenever the file is re-read or re-capped.
 */
function splitByManifest(
  samples: Sample[],
  manifest: SplitManifest,
): { train: Sample[]; test: Sample[] } {
  const testHashes = new Set(manifest.test.map((entry) => entry.sha256));
  const trainHashes = new Set(manifest.train.map((entry) => entry.sha256));

  const train: Sample[] = [];
  const test: Sample[] = [];
  const seen = new Set<string>();

  for (const sample of samples) {
    const digest = messageDigest(sample.text);
    if (seen.has(digest)) continue;
    seen.add(digest);

    if (testHashes.has(digest)) test.push(sample);
    else if (trainHashes.has(digest)) train.push(sample);
  }

  return { train, test };
}

// --------------------------------------------------------------------------
// Metrics
// --------------------------------------------------------------------------

interface Metrics {
  accuracy: number;
  precision: number;
  recall: number;
  f1: number;
  roc_auc: number;
  support: number;
}

function computeMetrics(scores: number[], labels: number[]): Metrics {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;

  for (let index = 0; index < labels.length; index += 1) {
    const predicted = scores[index] >= 0.5 ? 1 : 0;
    const actual = labels[index];
    if (predicted === 1 && actual === 1) tp += 1;
    else if (predicted === 1 && actual === 0) fp += 1;
    else if (predicted === 0 && actual === 1) fn += 1;
    else tn += 1;
  }

  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  const accuracy = (tp + tn) / Math.max(1, labels.length);

  // Rank-based AUC via the Mann-Whitney U statistic.
  const pairs = scores
    .map((score, index) => ({ score, label: labels[index] }))
    .sort((a, b) => a.score - b.score);

  let rank = 1;
  let rankSumPositive = 0;
  let positiveCount = 0;

  for (let index = 0; index < pairs.length; index += 1) {
    if (index > 0 && pairs[index].score === pairs[index - 1].score) continue;
    let end = index;
    while (end + 1 < pairs.length && pairs[end + 1].score === pairs[index].score) end += 1;
    const averageRank = (rank + (rank + (end - index))) / 2;
    for (let cursor = index; cursor <= end; cursor += 1) {
      if (pairs[cursor].label === 1) {
        rankSumPositive += averageRank;
        positiveCount += 1;
      }
    }
    rank += end - index + 1;
    index = end;
  }

  const negativeCount = pairs.length - positiveCount;
  const auc =
    positiveCount === 0 || negativeCount === 0
      ? 0.5
      : (rankSumPositive - (positiveCount * (positiveCount + 1)) / 2) /
        (positiveCount * negativeCount);

  return {
    accuracy: Number((accuracy * 100).toFixed(2)),
    precision: Number((precision * 100).toFixed(2)),
    recall: Number((recall * 100).toFixed(2)),
    f1: Number((f1 * 100).toFixed(2)),
    roc_auc: Number(auc.toFixed(4)),
    support: labels.length,
  };
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function stdev(values: number[]): number {
  if (values.length < 2) return 0;
  const average = mean(values);
  const variance =
    values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

// --------------------------------------------------------------------------
// Weight fitting
// --------------------------------------------------------------------------

const WEIGHT_GRID = [0, 0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1];

/** Build the weight vector the aggregation engine expects. */
function weightsFrom(values: number[]): ModuleWeight[] {
  return ALL_MODULES.map((module, index) => ({
    module,
    weight: values[index],
    // A zero weight disables the module, exactly as in the ablation table.
    enabled: values[index] > 0,
  }));
}

function scoresFor(
  collected: Array<{ modules: ModuleResult[] }>,
  weights: ModuleWeight[],
): number[] {
  return collected.map((entry) => aggregate(entry.modules, { weights }).finalScore);
}

/**
 * Fit the fusion weights on a validation split.
 *
 * The weights decide how much each detector counts towards the final score,
 * so they must be learned rather than guessed. Coordinate ascent over a grid
 * maximises validation F1.
 */
function fitWeights(
  collected: Array<{ modules: ModuleResult[]; label: number }>,
): ModuleWeight[] {
  const labels = collected.map((entry) => entry.label);

  let current = ALL_MODULES.map(() => 1 / ALL_MODULES.length);
  let best = current;
  let bestF1 = -1;

  for (let round = 0; round < 3; round += 1) {
    for (let index = 0; index < ALL_MODULES.length; index += 1) {
      for (const value of WEIGHT_GRID) {
        const candidate = [...current];
        candidate[index] = value;

        const scores = scoresFor(collected, weightsFrom(candidate));
        const f1 = computeMetrics(scores, labels).f1;

        if (f1 > bestF1) {
          bestF1 = f1;
          best = candidate;
        }
      }
    }
    current = [...best];
  }

  return weightsFrom(best);
}

// --------------------------------------------------------------------------
// Variants
// --------------------------------------------------------------------------

interface Variant {
  name: string;
  enabled: ModuleId[];
}

const VARIANTS: Variant[] = [
  { name: 'Full hybrid', enabled: ALL_MODULES },
  { name: 'DistilBERT only', enabled: ['semantic'] },
  { name: 'FP-Growth only', enabled: ['pattern'] },
  { name: 'URL intelligence only', enabled: ['url-intel'] },
  { name: 'Intent only', enabled: ['intent'] },
  { name: 'Hybrid without DistilBERT', enabled: ['url-intel', 'pattern', 'intent'] },
  { name: 'Hybrid without FP-Growth', enabled: ['semantic', 'url-intel', 'intent'] },
  { name: 'Hybrid without URL intelligence', enabled: ['semantic', 'pattern', 'intent'] },
  { name: 'Hybrid without intent analysis', enabled: ['semantic', 'url-intel', 'pattern'] },
];

function weightsForVariant(variant: Variant, fitted: ModuleWeight[]): ModuleWeight[] {
  const fittedMap = new Map(fitted.map((entry) => [entry.module, entry.weight]));
  return ALL_MODULES.map((module) => ({
    module,
    weight: variant.enabled.includes(module) ? (fittedMap.get(module) ?? 1) : 0,
    enabled: variant.enabled.includes(module),
  }));
}

// --------------------------------------------------------------------------
// Main
// --------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const readArg = (name: string, fallback: string) => {
    const index = args.indexOf(`--${name}`);
    return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
  };

  const datasetPath = resolve(ROOT, readArg('dataset', 'research/ml/datasets/sms_spam.csv'));
  const seeds = readArg('seeds', '13,42,77')
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value));
  const testSize = Number(readArg('test-size', '0.2'));
  const validationSize = Number(readArg('validation-size', '0.2'));
  const maxTest = Number(readArg('max-test', '0'));
  const maxEval = Number(readArg('max-eval', '0'));
  const outputPath = resolve(ROOT, readArg('out', 'research/results/evaluation.json'));

  if (!existsSync(datasetPath)) {
    console.error(`Dataset not found: ${datasetPath}`);
    console.error('Run: python research/ml/fetch_datasets.py');
    process.exit(1);
  }

  const allSamples = loadSamples(datasetPath);
  console.log(`Loaded ${allSamples.length} samples from ${datasetPath}`);

  // The training script records the split it used. When a manifest is
  // available the harness scores the model on exactly the rows the model never
  // saw; otherwise it falls back to inventing its own split, which puts a
  // fifth of the evaluated messages into the model's training set.
  const modelRoots = seeds.map((seed) => resolve(ROOT, modelDirFor(seed)));
  const manifests = seeds.map((_seed, index) => loadSplitManifest(modelRoots[index]));

  const perSeed: Array<{
    seed: number;
    metrics: Record<string, Metrics>;
    metrics_default_weights: Record<string, Metrics>;
    fitted_weights: ModuleWeight[];
    latency: Record<string, { mean: number; p95: number }>;
  }> = [];

  const topPatterns: ReturnType<typeof describeTopPatterns> = [];

  for (const [seedIndex, seed] of seeds.entries()) {
    const manifest = manifests[seedIndex];

    let train: Sample[];
    let test: Sample[];

    if (manifest) {
      ({ train, test } = splitByManifest(allSamples, manifest));
      console.log(
        `\n=== seed ${seed}: model split reused from ${modelRoots[seedIndex]} ` +
          `(train=${train.length} test=${test.length}) ===`,
      );
    } else {
      ({ train, test } = stratifiedSplit(allSamples, testSize, seed));
      console.log(
        `\n=== seed ${seed}: no split manifest for ${modelRoots[seedIndex]}, ` +
          'using an independent split (WARNING: the evaluated rows may have ' +
          'been in the model\'s training set) ===',
      );
    }

    // The validation split is used to fit the fusion weights. It is carved out
    // of the training data so the test set is never touched during fitting.
    const { train: fitSplit, test: validation } = stratifiedSplit(train, validationSize, seed + 101);

    const cap = (items: Sample[]) => {
      const limit = maxEval > 0 ? maxEval : maxTest;
      return limit > 0 && items.length > limit ? items.slice(0, limit) : items;
    };

    const evaluationTest = cap(test);
    const evaluationValidation = cap(validation);

    if (evaluationTest.length < MIN_TEST_SIZE) {
      console.warn(
        `  warning: only ${evaluationTest.length} test messages, results will be noisy`,
      );
    }

    console.log(
      `\n=== seed ${seed}: fit=${fitSplit.length} validation=${evaluationValidation.length}/${validation.length} test=${evaluationTest.length}/${test.length} ===`,
    );

    const spamTransactions = buildTransactions(
      fitSplit.filter((sample) => sample.label === 1).map((sample) => sample.text),
    );
    const hamTransactions = buildTransactions(
      fitSplit.filter((sample) => sample.label === 0).map((sample) => sample.text),
    );

    const patterns = mineDiscriminativePatterns(spamTransactions, hamTransactions, {
      minSupport: 0.01,
      minLength: 2,
    });

    if (seed === seeds[0]) {
      console.log(`Mined ${patterns.length} discriminative templates from the training split`);
      topPatterns.push(...describeTopPatterns(patterns, 15));
    }

    // Score this seed against its own checkpoint. Loading one checkpoint and
    // scoring it against three data splits reports the spread of the splits
    // as if it were the spread of the training runs.
    const modelRoot = modelRoots[seedIndex];
    const modelId = modelIdFor(modelRoot);
    const loaded = await loadSemanticModelFor(modelId);
    console.log(
      `  semantic checkpoint: ${modelId}` +
        (loaded ? '' : ' (NOT LOADED - the semantic module will be skipped)'),
    );

    const runPipeline = async (samples: Sample[]) => {
      const semanticResults = await runSemanticModuleBatch(samples.map((sample) => sample.text));
      const collected: Array<{ modules: ModuleResult[]; label: number }> = [];

      for (let index = 0; index < samples.length; index += 1) {
        const sample = samples[index];
        collected.push({
          modules: [
            semanticResults[index],
            runIntentModule(sample.text),
            runUrlModule(sample.text),
            await runPatternModule(sample.text, patterns),
          ],
          label: sample.label,
        });
      }

      return collected;
    };

    const validationCollected = await runPipeline(evaluationValidation);
    const testCollected = await runPipeline(evaluationTest);

    const fitted = fitWeights(validationCollected);
    console.log(
      '  fitted weights: ' +
        fitted.map((entry) => `${entry.module}=${entry.weight.toFixed(2)}`).join('  '),
    );

    const testLabels = testCollected.map((entry) => entry.label);

    const metrics: Record<string, Metrics> = {};
    const metricsDefault: Record<string, Metrics> = {};

    for (const variant of VARIANTS) {
      const fittedWeights = weightsForVariant(variant, fitted);
      const defaultWeights = weightsForVariant(variant, [
        { module: 'semantic', weight: 0.4, enabled: true },
        { module: 'url-intel', weight: 0.25, enabled: true },
        { module: 'pattern', weight: 0.2, enabled: true },
        { module: 'intent', weight: 0.15, enabled: true },
      ]);

      metrics[variant.name] = computeMetrics(scoresFor(testCollected, fittedWeights), testLabels);
      metricsDefault[variant.name] = computeMetrics(
        scoresFor(testCollected, defaultWeights),
        testLabels,
      );
    }

    const latencySamples: Record<string, number[]> = {
      semantic: [],
      'url-intel': [],
      pattern: [],
      intent: [],
    };
    for (const entry of testCollected) {
      for (const module of entry.modules) {
        latencySamples[module.module]?.push(module.latencyMs);
      }
    }

    const latency: Record<string, { mean: number; p95: number }> = {};
    for (const [module, values] of Object.entries(latencySamples)) {
      const sorted = [...values].sort((a, b) => a - b);
      latency[module] = {
        mean: Number(mean(values).toFixed(2)),
        p95: Number((sorted[Math.floor(sorted.length * 0.95)] ?? 0).toFixed(2)),
      };
    }

    for (const variant of VARIANTS) {
      const m = metrics[variant.name];
      console.log(
        `  ${variant.name.padEnd(34)} acc=${String(m.accuracy).padStart(6)}  ` +
          `prec=${String(m.precision).padStart(6)}  rec=${String(m.recall).padStart(6)}  ` +
          `F1=${String(m.f1).padStart(6)}  AUC=${m.roc_auc}`,
      );
    }

    perSeed.push({
      seed,
      metrics,
      metrics_default_weights: metricsDefault,
      fitted_weights: fitted,
      latency,
    });
  }

  const aggregateAcross = (pick: (entry: (typeof perSeed)[number]) => Record<string, Metrics>) => {
    const aggregated: Record<string, Record<string, { mean: number; std: number }>> = {};
    for (const variant of VARIANTS) {
      aggregated[variant.name] = {
        accuracy: { mean: 0, std: 0 },
        precision: { mean: 0, std: 0 },
        recall: { mean: 0, std: 0 },
        f1: { mean: 0, std: 0 },
        roc_auc: { mean: 0, std: 0 },
      };
      for (const key of ['accuracy', 'precision', 'recall', 'f1', 'roc_auc'] as const) {
        const values = perSeed.map((entry) => pick(entry)[variant.name][key]);
        // ROC-AUC needs four decimals. Rounding it to two like the percentages
        // reported a 0.9961 mean as a perfect "1.0000" with a standard
        // deviation of zero, which reads as a bug in the table.
        const digits = key === 'roc_auc' ? 4 : 2;
        aggregated[variant.name][key] = {
          mean: Number(mean(values).toFixed(digits)),
          std: Number(stdev(values).toFixed(digits)),
        };
      }
    }
    return aggregated;
  };

  const report = {
    dataset: datasetPath.replace(`${ROOT}/`, ''),
    seeds,
    test_size: testSize,
    validation_size: validationSize,
    samples_evaluated: allSamples.length,
    generated_at: new Date().toISOString(),
    main_results: aggregateAcross((entry) => entry.metrics),
    main_results_default_weights: aggregateAcross((entry) => entry.metrics_default_weights),
    fitted_weights: perSeed.map((entry) => ({
      seed: entry.seed,
      weights: entry.fitted_weights,
    })),
    per_seed: perSeed,
    mined_templates: topPatterns,
    latency: perSeed[0]?.latency ?? {},
    note: 'Produced by scripts/node/eval.ts using the shipped pipeline in src/lib/ml.',
  };

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`\nWrote ${outputPath.replace(`${ROOT}/`, '')}`);

  console.log('\n=== Table: main results, fitted weights (mean +/- std over seeds) ===');
  for (const variant of VARIANTS) {
    const row = report.main_results[variant.name];
    console.log(
      `  ${variant.name.padEnd(34)} acc=${row.accuracy.mean}+/-${row.accuracy.std}  ` +
        `F1=${row.f1.mean}+/-${row.f1.std}  AUC=${row.roc_auc.mean}+/-${row.roc_auc.std}`,
    );
  }

  console.log('\n=== Table: main results, hand-set default weights ===');
  for (const variant of VARIANTS) {
    const row = report.main_results_default_weights[variant.name];
    console.log(
      `  ${variant.name.padEnd(34)} acc=${row.accuracy.mean}  F1=${row.f1.mean}  AUC=${row.roc_auc.mean}`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
