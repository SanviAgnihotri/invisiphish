/**
 * Probe the shipped checkpoint through the application's own code path.
 *
 * It loads the same module the API and the evaluation harness use, prints the
 * raw classifier output for a few messages, and reports the label mapping, so
 * the browser implementation can be checked against the server's.
 */
import { loadSemanticModel } from '../../src/lib/ml/semanticModel';
import { runSemanticModule } from '../../src/lib/ml/semanticModel';
import fs from 'node:fs';

const SAMPLES = [
  'URGENT: Your account has been suspended. Verify your identity immediately at http://192.168.0.1/verify to avoid permanent closure.',
  'Hi Sarah, the meeting notes from Tuesday are attached. Let me know if you want me to walk through the Q3 numbers.',
  'Your parcel could not be delivered. Pay the 1.99 EUR customs fee within 24 hours to release your package: http://bit.ly/track99',
  'Reminder: the dentist appointment is on Thursday at 10:30. Reply CANCEL to opt out.',
];

const config = JSON.parse(
  fs.readFileSync('public/models/distilbert-phishing/config.json', 'utf8'),
);
console.log('id2label:', JSON.stringify(config.id2label));
console.log('max_position_embeddings:', config.max_position_embeddings);

const started = Date.now();
const classifier = await loadSemanticModel();
console.log(`model loaded in ${Date.now() - started} ms`);

if (!classifier) {
  console.log('MODEL DID NOT LOAD');
  process.exit(1);
}

for (const text of SAMPLES) {
  const raw = await classifier(text);
  const module = await runSemanticModule(text);
  console.log('\n---', text.slice(0, 60));
  console.log('  raw output:', JSON.stringify(raw));
  console.log('  module:', module.status, 'score', module.score.toFixed(4));
}

// What the pipeline returns with every label instead of only the top one.
console.log('\n=== with topk: null ===');
for (const text of SAMPLES) {
  const raw = await classifier(text, { topk: null });
  console.log(' ', JSON.stringify(raw));
}
