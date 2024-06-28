/**
 * Probe the browser-side classifier through the same module the page uses.
 *
 * The browser cannot be driven from a terminal, so the client module is run
 * in Node instead: it is the same file, the same model id and the same
 * extraction, with the model path pointing at the same checkpoint the browser
 * downloads from `/models/`.
 */
import { scoreInBrowser, getClientModelStatus, preloadClientModel } from '../../src/lib/ml/clientSemantic';

const SAMPLES = [
  'URGENT: Your account has been suspended. Verify your identity immediately at http://192.168.0.1/verify to avoid permanent closure.',
  'Hi Sarah, the meeting notes from Tuesday are attached. Let me know if you want me to walk through the Q3 numbers.',
  'Your parcel could not be delivered. Pay the 1.99 EUR customs fee within 24 hours to release your package: http://bit.ly/track99',
  'Reminder: the dentist appointment is on Thursday at 10:30. Reply CANCEL to opt out.',
];

preloadClientModel();

for (const text of SAMPLES) {
  const result = await scoreInBrowser(text);
  console.log(
    `${result.status.padEnd(7)} score=${result.score.toFixed(4)} confidence=${result.confidence.toFixed(4)} label=${result.label ?? '-'} | ${text.slice(0, 55)}`,
  );
}

console.log('final state:', getClientModelStatus());
