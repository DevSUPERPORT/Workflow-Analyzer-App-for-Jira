/**
 * Vite build for the Custom UI. In mock mode it swaps @forge/bridge for the local mock and adds a dev-only
 * endpoint that saves generated exports to samples/ for inspection; the production build goes to dist/.
 *
 * @file        static/app/vite.config.js
 * @app         Workflow Analyzer for Jira
 * @author      George Papasotiriou
 * @company     SUPERPORT
 * @created     2026-10-24
 * @updated     2026-11-05
 */

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

// Dev-server only (mock mode): POST /__save?name=<file> writes the body to ../../samples.
// Lets automated UI tests persist generated exports for inspection. Never part of the build.
function saveSamplesPlugin() {
  const dir = fileURLToPath(new URL('../../samples', import.meta.url));
  return {
    name: 'wfa-save-samples',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__save', (req, res) => {
        const name = path.basename(new URL(req.url, 'http://x').searchParams.get('name') || 'export.bin');
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, name), Buffer.concat(chunks));
          res.end(JSON.stringify({ saved: path.join(dir, name) }));
        });
      });
    },
  };
}

// `--mode mock` swaps @forge/bridge for a local mock so the UI can be developed and
// tested in a normal browser with fixture data (see src/mock/bridge.js).
export default defineConfig(({ mode }) => ({
  base: './',
  plugins: [react(), ...(mode === 'mock' ? [saveSamplesPlugin()] : [])],
  resolve: {
    alias: mode === 'mock' ? { '@forge/bridge': fileURLToPath(new URL('./src/mock/bridge.js', import.meta.url)) } : {},
  },
  server: { fs: { allow: ['../..'] } },
  build: { outDir: mode === 'mock' ? 'dist-mock' : 'dist', chunkSizeWarningLimit: 2500, assetsInlineLimit: 0 },
}));
