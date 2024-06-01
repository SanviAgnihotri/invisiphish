import { defineConfig } from 'vitest/config';
import { loadEnv } from 'vite';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { apiDevServer } from './scripts/node/dev-api';

export default defineConfig(({ mode }) => {
  // The env files are read here, because the config is evaluated before Vite
  // loads them: `VITE_SEMANTIC_QUANTIZED` decides whether the browser loads
  // the int8 export or the float32 one.
  const env = loadEnv(mode, process.cwd(), '');

  return {
    plugins: [react(), tailwindcss(), apiDevServer()],
    resolve: {
      // `@` is the source root, so a module is addressed by what it is
      // rather than by how deep it happens to sit.
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    define: {
      // The browser must use the same model precision as the evaluation
      // harness, otherwise the reported numbers are not what a user sees.
      __INVISIPHISH_QUANTIZED__: JSON.stringify(
        env.VITE_SEMANTIC_QUANTIZED ?? process.env.VITE_SEMANTIC_QUANTIZED ?? '0',
      ),
      // The Auth service's address is a constant, and the sign-in page needs
      // it in its first paint to draw the Google button. Asking the API for
      // it would make the button appear a moment after the page, which reads
      // as a broken page.
      __VIGIL_AUTH_BASE_URL__: JSON.stringify(
        (env.NEON_AUTH_BASE_URL ?? process.env.NEON_AUTH_BASE_URL ?? '').replace(/\/+$/, ''),
      ),
    },
    server: {
      port: 5173,
    },
    build: {
      outDir: 'dist',
      sourcemap: true,
    },
    test: {
      environment: 'node',
      include: ['tests/**/*.test.ts'],
    },
  };
});
