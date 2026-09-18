import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');

export default defineConfig(({ mode }) => {
  // Empty prefix so plain BTS_* vars (not just VITE_*) load from the repo-root .env, matching src/config.ts.
  const env = loadEnv(mode, repoRoot, '');
  const uiPort = Number(env.BTS_UI_PORT || 5173);
  const apiPort = Number(env.BTS_API_PORT || 4300);

  return {
    root: here,
    plugins: [react()],
    server: {
      // Bind IPv4 loopback explicitly so the page origin matches the API's Origin allowlist (127.0.0.1 and localhost).
      host: '127.0.0.1',
      port: uiPort,
      strictPort: true,
      proxy: {
        // Anchored regex: a plain '/api' prefix also captured the UI module served at /api.ts.
        '^/api/': {
          target: `http://127.0.0.1:${apiPort}`,
          changeOrigin: true,
        },
      },
    },
    build: {
      outDir: resolve(repoRoot, 'dist/ui'),
      emptyOutDir: true,
    },
  };
});
