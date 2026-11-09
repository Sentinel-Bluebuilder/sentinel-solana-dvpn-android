// Usage: node scripts/check-release-version.mjs [--allow-same-version]   (npm run check:release-version)
// Fails when this checkout's version is not higher than every version already shipped (L3).
import path from 'node:path';
import { checkRelease } from './lib/release-version.mjs';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^[/]([A-Za-z]:)/, '$1')), '..');
try {
  const r = checkRelease(root, { allowSame: process.argv.includes('--allow-same-version') });
  console.log(`ok   release version is ${r.overridden ? 'NOT higher than' : 'higher than'} the highest shipped (${r.highestShipped ?? 'none'})`);
} catch (err) {
  console.error(`FAIL ${err.message}`);
  process.exit(1);
}
