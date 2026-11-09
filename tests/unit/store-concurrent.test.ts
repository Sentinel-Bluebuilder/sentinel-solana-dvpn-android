import { describe, expect, it } from 'vitest';
import { buildSync } from 'esbuild';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// ─── Store writes from two processes ───
// The app and the CLI write the same JSON files (history.json) in one folder. With one shared
// "<file>.tmp", one process renamed the other's tmp away and that rename threw ENOENT.

describe('writeJson from two processes at once', () => {
  it('never throws ENOENT and leaves no tmp files behind', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddv-store-'));
    // The real store.ts, bundled to plain JS so each child is an ordinary Node process.
    const bundle = path.join(dir, 'store.mjs');
    buildSync({ entryPoints: ['src/main/store.ts'], bundle: true, platform: 'node', format: 'esm', outfile: bundle, logLevel: 'silent' });
    const url = pathToFileURL(bundle).href;
    const script = `
      const { initStore, writeJson } = await import(${JSON.stringify(url)});
      initStore(${JSON.stringify(dir)});
      for (let i = 0; i < 400; i++) writeJson('history.json', { i, pid: process.pid, pad: 'x'.repeat(2000) });
    `;
    const run = () => new Promise<{ code: number | null; err: string }>((resolve) => {
      const p = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      p.stderr.on('data', (d) => { err += d; });
      p.on('close', (code) => resolve({ code, err }));
    });
    const results = await Promise.all([run(), run(), run()]);
    for (const r of results) expect(r.err).not.toMatch(/ENOENT/);
    for (const r of results) expect(r.err + String(r.code)).toBe('0');
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect(fs.readdirSync(dir).sort()).toEqual(['history.json', 'store.mjs']);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'history.json'), 'utf8')).i).toBe(399);
    fs.rmSync(dir, { recursive: true, force: true });
  }, 60_000);
});
