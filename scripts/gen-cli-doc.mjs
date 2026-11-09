// Regenerates the command tables in docs/CLI.md from src/cli/catalogue.ts.
import { build } from 'esbuild';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const tmp = 'out/catalogue.cjs';
await build({ entryPoints: ['src/cli/catalogue.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: tmp, logLevel: 'error' });
const { catalogueMarkdown, CATALOGUE } = createRequire(import.meta.url)(`../${tmp}`);
const START = '<!-- cli-catalogue:start -->';
const END = '<!-- cli-catalogue:end -->';
const file = 'docs/CLI.md';
const body = `${START}\n${catalogueMarkdown()}${END}`;
const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
const a = cur.indexOf(START);
const b = cur.indexOf(END);
const next = a >= 0 && b > a ? cur.slice(0, a) + body + cur.slice(b + END.length) : `${cur}\n${body}\n`;
fs.writeFileSync(file, next);
fs.rmSync(tmp);
console.log(`docs/CLI.md: ${CATALOGUE.length} commands`);
