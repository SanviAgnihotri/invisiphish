/**
 * The constants Vite writes into the client bundle, for the builds that run
 * outside Vite.
 *
 * The prerender renders the same pages the browser will hydrate, so it needs
 * the same values. They are read here, and this module is imported first, so
 * that the globals are in place before the pages read them.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const globals = globalThis as {
  __VIGIL_AUTH_BASE_URL__?: string;
  __INVISIPHISH_QUANTIZED__?: string;
};

function readEnvFile(): string {
  try {
    return readFileSync(resolve(process.cwd(), '.env.local'), 'utf8');
  } catch {
    // No configuration file: the pages fall back to asking the API.
    return '';
  }
}

const contents = readEnvFile();

const value = (key: string): string | undefined => {
  const match = new RegExp(`^${key}=(.*)$`, 'm').exec(contents);
  return match ? match[1].trim() : undefined;
};

globals.__VIGIL_AUTH_BASE_URL__ = (
  value('NEON_AUTH_BASE_URL') ??
  process.env.NEON_AUTH_BASE_URL ??
  ''
).replace(/\/+$/, '');

globals.__INVISIPHISH_QUANTIZED__ =
  value('VITE_SEMANTIC_QUANTIZED') ??
  process.env.VITE_SEMANTIC_QUANTIZED ??
  '0';
