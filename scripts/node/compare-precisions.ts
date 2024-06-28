/**
 * Compare the float32 and the int8 exports of the shipped checkpoint.
 *
 * The browser is supposed to load the int8 export: the float32 file is 256MB
 * and the ADR (research/docs/adr/0004-onnx-classifier-runtime.md) says the browser and
 * the server must use the same precision. This script checks that the two
 * agree, through the application's own tokenisation and the same label
 * extraction the app uses.
 */
import { env, pipeline } from '@xenova/transformers';
import fs from 'node:fs';

const MODEL_ID = 'distilbert-phishing';
const SAMPLES = [
  ['phishing', 'URGENT: Your account has been suspended. Verify your identity immediately at http://192.168.0.1/verify to avoid permanent closure.'],
  ['phishing', 'Your parcel could not be delivered. Pay the 1.99 EUR customs fee within 24 hours to release your package: http://bit.ly/track99'],
  ['phishing', 'Dear customer, unusual login from a new device. Confirm your password within 2 hours or your account will be locked.'],
  ['phishing', 'You have won a 5000 USD gift card! Claim your prize now and provide your bank details to cover the shipping.'],
  ['phishing', 'Security alert: unusual sign-in attempt on your corporate account. Confirm your identity now to prevent a breach.'],
  ['phishing', 'The shared document "Q3 Budget.xlsx" is ready for your approval. Please review and sign it before Friday.'],
  ['legitimate', 'Hi Sarah, the meeting notes from Tuesday are attached. Let me know if you want me to walk through the Q3 numbers.'],
  ['legitimate', 'Reminder: the dentist appointment is on Thursday at 10:30. Reply CANCEL to opt out.'],
  ['legitimate', 'The build finished successfully. All 214 tests passed and the artefact is in the usual place.'],
  ['legitimate', 'Thanks for the review. I have pushed the fix to the feature branch, could you take another look?'],
  ['legitimate', 'Lunch at 1pm? The place near the office does good wraps.'],
  ['legitimate', 'Invoice 88421 is attached for the consultancy work in June. Payment terms are 30 days as usual.'],
];

env.allowLocalModels = true;
env.allowRemoteModels = false;
env.localModelPath = './public/models/';

const config = JSON.parse(fs.readFileSync(`public/models/${MODEL_ID}/config.json`, 'utf8'));
console.log('id2label:', JSON.stringify(config.id2label));

const float32 = (await pipeline('text-classification', MODEL_ID, { quantized: false })) as never;
const int8 = (await pipeline('text-classification', MODEL_ID, { quantized: true })) as never;

type Entry = { label: string; score: number };

async function score(classifier: never, text: string) {
  const output = (await (classifier as unknown as (t: string) => Promise<Entry[]>)(text)) as Entry[];
  const phishing = output.find((entry) => /phish|spam|malicious|label_1/i.test(entry.label));
  return { score: Number(phishing?.score ?? 0), label: output[0]?.label ?? '?' };
}

console.log('\n| expected | float32 | int8 | difference | same label |');
console.log('|---|---|---|---|---|');

let worst = 0;
let sum = 0;
let disagreements = 0;
for (const [expected, text] of SAMPLES) {
  const a = await score(float32, text);
  const b = await score(int8, text);
  const difference = Math.abs(a.score - b.score);
  const same = a.label === b.label;
  if (!same) disagreements += 1;
  worst = Math.max(worst, difference);
  sum += difference;
  console.log(
    `| ${expected} | ${a.score.toFixed(4)} (${a.label}) | ${b.score.toFixed(4)} (${b.label}) | ${difference.toFixed(6)} | ${same ? 'yes' : 'NO'} |`,
  );
}

console.log(`\nmean absolute difference: ${(sum / SAMPLES.length).toFixed(6)}`);
console.log(`max absolute difference:  ${worst.toFixed(6)}`);
console.log(`label disagreements:      ${disagreements} of ${SAMPLES.length}`);
console.log(
  disagreements === 0
    ? 'The int8 export reaches the same decision as the float32 one on every sample, so it can replace it in the browser.'
    : 'The int8 export reaches a different decision somewhere; it cannot replace the float32 one as it stands.',
);
