// ─── Bundle the Android main process: out/android/main.cjs (self-contained) ───
// Same code as the Electron main process, run by plain Node 22 inside the APK (D-A3).
// `electron` is aliased to src/android/electron-shim.ts.
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

const banner = [
  'process.noDeprecation = true;',
  'const __warn = console.warn;',
  "console.warn = (...a) => { if (!/^bigint: Failed to load bindings/.test(String(a[0]))) __warn(...a); };",
].join('\n');

await build({
  entryPoints: ['src/android/main.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  alias: { electron: path.resolve('src/android/electron-shim.ts') },
  external: ['bufferutil', 'utf-8-validate'],
  outfile: 'out/android/main.cjs',
  banner: { js: banner },
  define: { 'process.env.DVPN_APP_VERSION': JSON.stringify(pkg.version) },
  logLevel: 'warning',
});
console.log('built out/android/main.cjs');

// WebView preload (window.api), injected by the Kotlin shell at document start.
await build({
  entryPoints: ['src/android/web-preload.ts'],
  bundle: true,
  platform: 'browser',
  target: 'chrome100',
  format: 'iife',
  outfile: 'out/android/web-preload.js',
  logLevel: 'warning',
});
console.log('built out/android/web-preload.js');
