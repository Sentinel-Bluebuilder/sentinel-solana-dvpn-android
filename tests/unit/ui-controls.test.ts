// ─── Button audit guard (U3): every control is documented, and every app function it reaches has a CLI ───
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { IPC, TIERS } from '../../src/shared/ipc';
import { CLI_FOR_IPC } from '../../src/cli/ipc-map';

// The scripts are plain ES modules; run them the way a developer would.
const scanJson = JSON.parse(execFileSync(process.execPath, ['scripts/ui-controls-inventory.mjs'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })) as Array<{ file: string; line: number; label: string; ipc: string[] }>;
const handlers = fs.readFileSync('src/main/ipc.ts', 'utf8');

describe('UI controls', () => {
  it('the scan finds the controls (positive control)', () => {
    expect(scanJson.length).toBeGreaterThan(100);
    expect(scanJson.some((r) => r.file === 'components/ConnectSheet.tsx' && r.ipc.includes('CONNECT'))).toBe(true);
  });

  it('every IPC channel a control reaches is a real channel with a main handler', () => {
    const used = [...new Set(scanJson.flatMap((r) => r.ipc))];
    const unknown = used.filter((k) => !(k in IPC));
    const noHandler = used.filter((k) => k in IPC && !handlers.includes(`[IPC.${k}]:`));
    expect([...unknown, ...noHandler]).toEqual([]);
  });

  it('every channel a control reaches has a CLI command or a stated reason', () => {
    const used = [...new Set(scanJson.flatMap((r) => r.ipc))] as Array<keyof typeof IPC>;
    const missing = used.filter((k) => !CLI_FOR_IPC[IPC[k]]);
    expect(missing).toEqual([]);
  });

  it('every channel has exactly one handler (no dead channel)', () => {
    const dead = (Object.keys(TIERS) as string[]).filter((chan) => {
      const key = Object.entries(IPC).find(([, v]) => v === chan)?.[0];
      return !key || handlers.split(`[IPC.${key}]:`).length !== 2;
    });
    expect(dead).toEqual([]);
  });

  it('docs/UI-CONTROLS.md is up to date (node scripts/ui-controls-doc.mjs)', () => {
    let msg = '';
    try { execFileSync(process.execPath, ['scripts/ui-controls-doc.mjs', '--check'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch (err) { msg = String((err as { stderr?: string }).stderr ?? err); }
    expect(msg).toBe('');
  });
});
