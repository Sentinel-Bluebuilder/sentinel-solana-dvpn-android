// ─── Bundle the CLI: out/cli/devnet-dvpn.cjs (self-contained) ───
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

// bigint-buffer warns on every start when its optional native addon is absent;
// the pure-JS path is what @solana/web3.js uses anyway. Filter only that line.
const banner = [
  '#!/usr/bin/env node',
  // A bundled dependency still requires node's punycode; users can't act on that notice.
  'process.noDeprecation = true;',
  'const __warn = console.warn;',
  "console.warn = (...a) => { if (!/^bigint: Failed to load bindings/.test(String(a[0]))) __warn(...a); };",
].join('\n');

await build({
  entryPoints: ['src/cli/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  // Self-contained (same reason as the main bundle, electron.vite.config.ts): the packaged
  // CLI runs from app.asar, whose node_modules layout electron-builder may re-nest.
  external: ['electron', 'bufferutil', 'utf-8-validate'],
  outfile: 'out/cli/devnet-dvpn.cjs',
  banner: { js: banner },
  define: { 'process.env.DVPN_APP_VERSION': JSON.stringify(pkg.version) },
  logLevel: 'warning',
});
console.log('built out/cli/devnet-dvpn.cjs');
