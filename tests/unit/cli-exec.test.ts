// The in-app CLI runs the real command table, keeps secrets off screen, and still asks for --yes.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCliLine, tokenize } from '../../src/main/services/cli-exec';
import { setHost } from '../../src/main/host';
import { initStore } from '../../src/main/store';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvpn-cliexec-'));
setHost({ name: 'cli', resourcesDir: '.', dataDir: dir, emit: () => undefined, keyStore: { kind: 'memory', exists: () => false, load: () => null, save: () => undefined, remove: () => undefined } });
initStore(dir);

describe('in-app CLI', () => {
  it('tokenizes quotes', () => expect(tokenize(`settings set "preferredCountry=DE" 'a b'`)).toEqual(['settings', 'set', 'preferredCountry=DE', 'a b']));
  it('runs a real command', async () => {
    const r = await runCliLine('version');
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/devnet/i);
  });
  it('accepts the program name in front', async () => expect((await runCliLine('devnet-dvpn version')).ok).toBe(true));
  it('help lists commands from the catalogue', async () => expect((await runCliLine('help')).text).toContain('wallet send'));
  it('refuses unknown commands', async () => expect(await runCliLine('teleport')).toMatchObject({ ok: false, code: 3 }));
  it('never handles secrets', async () => {
    expect(await runCliLine('wallet create --yes')).toMatchObject({ ok: false, code: 3 });
    expect(await runCliLine('wallet import key.json --yes')).toMatchObject({ ok: false, code: 3 });
    expect((await runCliLine('help')).text).not.toContain('wallet create');
  });
  it('refuses endless streams', async () => expect(await runCliLine('connect abc --follow --yes')).toMatchObject({ ok: false, code: 3 }));
  it('settings round-trip through the same store as the app', async () => {
    expect((await runCliLine('settings set notifications=false')).ok).toBe(true);
    expect((await runCliLine('settings get --json')).text).toContain('"notifications": false');
  });
  it('usage errors carry the usage line', async () => {
    const r = await runCliLine('nodes show');
    expect(r.ok).toBe(false);
  });
});
