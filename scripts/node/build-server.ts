/**
 * Build the production server.
 *
 * The API handlers and the frontend share their modules, so the server is
 * bundled rather than compiled file by file: one file, no path resolution to
 * get wrong at runtime. The dependencies stay outside the bundle, because the
 * ONNX runtime and the image library load native assets from `node_modules`
 * and must not be inlined.
 *
 * Usage:
 *     pnpm build:server
 */
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const OUT_DIR = path.join(ROOT, 'dist-server');
const OUT_FILE = path.join(OUT_DIR, 'server.mjs');

fs.rmSync(OUT_DIR, { recursive: true, force: true });
fs.mkdirSync(OUT_DIR, { recursive: true });

const result = await build({
  entryPoints: [path.join(ROOT, 'server', 'index.ts')],
  outfile: OUT_FILE,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  packages: 'external',
  sourcemap: true,
  minify: false,
  logLevel: 'info',
  metafile: true,
});

const bytes = fs.statSync(OUT_FILE).size;
console.log(`\nserver bundle: ${(bytes / 1024).toFixed(0)} KB -> ${path.relative(ROOT, OUT_FILE)}`);

const inputs = Object.keys(result.metafile.inputs).length;
console.log(`modules bundled: ${inputs}`);

// The build is what the machine runs; nothing else is needed but the
// dependencies, which stay outside the bundle on purpose.
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
  dependencies: Record<string, string>;
};
console.log(`runtime dependencies kept external: ${Object.keys(pkg.dependencies).join(', ')}`);
