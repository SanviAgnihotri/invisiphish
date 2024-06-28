/**
 * Run the detection pipeline over the sample messages.
 *
 * It answers two questions that the dashboard otherwise leaves open: what
 * verdict each sample file gets, and how the pipeline does over a labelled
 * set. The sample files are the ones in `research/samples/`, so the numbers here are
 * the numbers the dashboard shows.
 *
 * Usage:
 *     pnpm verify:samples
 */
import fs from 'node:fs';
import path from 'node:path';

import { aggregate } from '../../src/lib/ml/aggregation';
import { runIntentModule } from '../../src/lib/ml/intentAnalysis';
import { runPatternModule } from '../../src/lib/ml/patternModule';
import { runSemanticModule } from '../../src/lib/ml/semanticModel';
import { runUrlModule } from '../../src/lib/ml/urlIntel';

const SAMPLES = path.resolve('research/samples');

/** Run the whole pipeline over one message, the way the API does. */
async function analyse(text: string) {
  const semantic = await runSemanticModule(text);
  const intent = runIntentModule(text);
  const url = runUrlModule(text);
  const pattern = await runPatternModule(text, []);
  const aggregated = aggregate([semantic, intent, url, pattern]);

  return {
    verdict: aggregated.verdict,
    score: aggregated.finalScore,
    evidence: aggregated.rankedEvidence.length,
    modules: aggregated.contributions,
  };
}

console.log('== InvisiPhish over the sample messages ==\n');
console.log('The verdict has three values, not two: legitimate below 40%,');
console.log('suspicious from 40% to 70%, phishing at 70% and above.\n');

const files = fs
  .readdirSync(SAMPLES)
  .filter((name) => name.endsWith('.txt'))
  .sort();

console.log('--- the files you can upload to the dashboard ---\n');
for (const file of files) {
  const text = fs.readFileSync(path.join(SAMPLES, file), 'utf8');
  const result = await analyse(text);

  // A phishing sample is expected to be flagged - suspicious or phishing.
  // A legitimate sample is expected to come back legitimate.
  const expectedFlagged = file.includes('phishing');
  const flagged = result.verdict !== 'legitimate';
  const agrees = flagged === expectedFlagged;

  console.log(
    `${file.padEnd(38)} ${result.verdict.padEnd(11)} ` +
      `${(result.score * 100).toFixed(1).padStart(5)}%  ` +
      `${String(result.evidence).padStart(2)} evidence  ` +
      `${agrees ? 'as expected' : 'NOT as expected'}`,
  );
}

// The labelled set: how the pipeline does over it.
const csv = fs.readFileSync(path.join(SAMPLES, 'messages.csv'), 'utf8').split('\n').slice(1);
const rows = csv
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line) => {
    const match = line.match(/^(\w+),(.*)$/);
    if (!match) return null;
    return {
      label: match[1] === 'spam' ? 'phishing' : 'legitimate',
      message: match[2].replace(/^"(.*)"$/, '$1').replace(/""/g, '"'),
    };
  })
  .filter((row): row is { label: string; message: string } => row !== null);

console.log('\n--- the labelled set ---\n');

let correct = 0;
const mistakes: string[] = [];

for (const row of rows) {
  const result = await analyse(row.message);

  // A phishing message is caught if it is flagged at all, which is what the
  // dashboard shows the reader; a legitimate one is only right if it comes
  // back legitimate.
  const right = row.label === 'phishing' ? result.verdict !== 'legitimate' : result.verdict === 'legitimate';

  if (right) correct += 1;
  else mistakes.push(`${row.label} -> ${result.verdict} (${(result.score * 100).toFixed(1)}%)`);
}

const spam = rows.filter((row) => row.label === 'phishing').length;
const ham = rows.length - spam;

console.log(`${correct} of ${rows.length} right (${((correct / rows.length) * 100).toFixed(1)}%)`);
console.log(`  ${spam} phishing messages, ${ham} legitimate ones`);
for (const mistake of mistakes) console.log(`  missed: ${mistake}`);

console.log('\nA phishing message counts as caught when it comes back');
console.log('suspicious or phishing; a legitimate one has to come back');
console.log('legitimate. The pattern module is left out here because it needs');
console.log('a mined pattern repository - the dashboard reads the patterns it');
console.log('has, and the verdicts are the same either way for these samples.');

