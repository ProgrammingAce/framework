import * as esbuild from 'esbuild';
import { execSync } from 'child_process';

// Server bundle (Node.js)
await esbuild.build({
  entryPoints: ['src/server/main.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  outfile: 'dist/server.js',
  format: 'cjs',
  external: ['ws'],
});

// Client bundle (browser) — written directly to public/ so the dev server can serve it
await esbuild.build({
  entryPoints: ['src/client/main.ts'],
  bundle: true,
  platform: 'browser',
  target: 'es2022',
  outfile: 'public/client.js',
  format: 'iife',
});

// Cloudflare Worker bundle
await esbuild.build({
  entryPoints: ['src/worker/worker.ts'],
  bundle: true,
  platform: 'browser',
  target: 'es2022',
  outfile: 'dist/worker/worker.js',
  format: 'esm',
  conditions: ['worker', 'browser'],
});

console.log('Build complete.');
