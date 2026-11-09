// DC1: Disconnect while ANOTHER process is still connecting must stop that connect.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { cancelRequested, clearConnecting, markConnecting, otherConnect, requestCancel, waitConnectEnded, MARKER_STALE_MS } from '../../src/main/services/connect-marker';

let dir = '';
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddv-dc1-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('cross-process connect marker (DC1)', () => {
  it('another live process connecting is seen; our own marker is not', () => {
    markConnecting(dir, 'nodeA', 4242, 1000);
    expect(otherConnect(dir, 4242, 2000, () => true)).toBeNull();
    expect(otherConnect(dir, 7, 2000, () => true)).toMatchObject({ pid: 4242, node: 'nodeA' });
  });

  it('a dead or stale marker is dropped, not reported', () => {
    markConnecting(dir, 'nodeA', 4242, 1000);
    expect(otherConnect(dir, 7, 2000, () => false)).toBeNull();
    expect(fs.existsSync(path.join(dir, 'connect-in-progress.json'))).toBe(false);
    markConnecting(dir, 'nodeA', 4242, 1000);
    expect(otherConnect(dir, 7, 1000 + MARKER_STALE_MS + 1, () => true)).toBeNull();
  });

  it('a stop request reaches only the process it names; a new connect clears an old request', () => {
    markConnecting(dir, 'nodeA', 4242);
    requestCancel(dir, { pid: 4242, startedAt: 0, node: 'nodeA' });
    expect(cancelRequested(dir, 4242)).toBe(true);
    expect(cancelRequested(dir, 99)).toBe(false);
    markConnecting(dir, 'nodeB', 4242);
    expect(cancelRequested(dir, 4242)).toBe(false);
  });

  it('clearConnecting removes only our own marker', () => {
    markConnecting(dir, 'nodeA', 4242);
    clearConnecting(dir, 99);
    expect(fs.existsSync(path.join(dir, 'connect-in-progress.json'))).toBe(true);
    clearConnecting(dir, 4242);
    expect(fs.existsSync(path.join(dir, 'connect-in-progress.json'))).toBe(false);
  });

  it('a real second process: it sees the stop request, ends, and the wait returns true', async () => {
    // The child plays the connecting CLI: marker on, poll for a stop request, clear and exit.
    const child = spawn(process.execPath, ['-e', `
      const fs = require('fs'), p = require('path'); const d = ${JSON.stringify(dir)};
      fs.writeFileSync(p.join(d, 'connect-in-progress.json'), JSON.stringify({ pid: process.pid, startedAt: Date.now(), node: 'n' }));
      const t = setInterval(() => {
        try { if (JSON.parse(fs.readFileSync(p.join(d, 'connect-cancel.json'), 'utf8')).pid === process.pid) { fs.rmSync(p.join(d, 'connect-in-progress.json')); clearInterval(t); process.exit(0); } }
        catch (e) { if (e.code !== 'ENOENT') throw e; }
      }, 100);
      setTimeout(() => process.exit(3), 15000);
    `]);
    const exited = new Promise<number | null>((r) => child.on('exit', r));
    let other = null;
    for (let i = 0; i < 50 && !other; i++) { await new Promise((r) => setTimeout(r, 100)); other = otherConnect(dir); }
    expect(other?.pid).toBe(child.pid);
    requestCancel(dir, other!);
    expect(await waitConnectEnded(dir, other!, 10_000, 100)).toBe(true);
    expect(await exited).toBe(0);
  }, 20_000);

  it('the wait gives up (false) while the other connect keeps running', async () => {
    markConnecting(dir, 'nodeA', 4242);
    expect(await waitConnectEnded(dir, { pid: 4242, startedAt: 0, node: 'nodeA' }, 300, 50, () => true)).toBe(false);
  });
});
