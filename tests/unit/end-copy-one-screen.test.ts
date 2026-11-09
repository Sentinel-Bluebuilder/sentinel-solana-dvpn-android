// ─── Q0366 end copy: one screen, not two (TAN lab-q0366k) ───
// An unexpected end with the kill switch on showed 'Not connected / The connection to this server
// stopped working. Pick another server.' and ~3 s later the blocked screen. The spec (and the desktop
// strings) is one screen: why it ended, the kill switch is still blocking, Restore network.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('../../src/main/platform/android-bridge', () => ({ isAndroid: () => true, androidHeldBlock: async () => true }));
vi.mock('../../src/main/app-state', () => ({ snapshot: () => ({ session: null, conn: { phase: 'idle' } }), patch: vi.fn(), setSplitInEffect: vi.fn(), setRedialFollow: vi.fn(), toast: vi.fn() }));
vi.mock('../../src/main/daemon/manager', () => ({ daemon: () => ({}), daemonInfo: () => ({ reachable: true }), startServiceIfStopped: async () => 'ok' }));
vi.mock('../../src/main/logger', () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../src/main/system/tunnels', () => ({ leftoverTunnels: async () => [], rivalVpns: async () => [], removeTunnelServices: async () => undefined }));
vi.mock('../../src/main/system/proxy', () => ({ setSystemProxy: vi.fn(), clearSystemProxy: async () => undefined }));
vi.mock('../../src/core/chain/rpc', () => ({ getRpcUrls: () => [], resetRpcTransport: vi.fn(), onRpcRetry: () => () => undefined }));
vi.mock('../../src/main/daemon/settings', () => ({ getDaemonSettings: () => ({ settings: { killSwitch: 'on', dnsServers: [] } }), serviceUsesTun: () => false, splitForSession: vi.fn() }));

const { endedHeldView, blockedAfterEnd } = await import('../../src/main/services/connection');
const { closeReasonCopy } = await import('../../src/core/session/state');

const stopped = closeReasonCopy('the connection to this server stopped working');

describe('the end screen after a dead path with the kill switch on (Q0366)', () => {
  it('Android, kill switch on, unexpected end: one blocked screen that says why, with Restore network', () => {
    const v = endedHeldView(true, true, true, stopped);
    expect(v?.phase).toBe('error');
    expect(v?.restoreNetwork).toBe(true);
    expect(v?.detail ?? v?.title).toBeDefined();
    const text = `${v?.title ?? ''} ${v?.detail ?? ''}`;
    expect(text).toContain('The connection to this server stopped working. The kill switch is still blocking the internet to protect you: pick another server, or press Restore network to get it back.');
    // the same string the desktop apps show
    expect(blockedAfterEnd(stopped)).toBe('The connection to this server stopped working. The kill switch is still blocking the internet to protect you: pick another server, or press Restore network to get it back.');
  });

  it('negative controls: kill switch off, a user stop, or desktop keep the usual idle step', () => {
    expect(endedHeldView(true, false, true, stopped)).toBeNull();
    expect(endedHeldView(true, true, false, stopped)).toBeNull();
    expect(endedHeldView(false, true, true, stopped)).toBeNull();
  });

  it('that screen carries ONE message: the header alert is dropped and Restore network sits in the panel (TAN q0366m)', async () => {
    const { restoreInPanel } = await import('../../src/core/session/state');
    const v = endedHeldView(true, true, true, stopped)!;
    expect(restoreInPanel(v)).toBe(true);
    // negative controls: the generic blocked screen (no reason in the panel) keeps the header alert
    expect(restoreInPanel({ phase: 'error', restoreNetwork: true, detail: 'A VPN connection from before is still running without this app.' })).toBe(false);
    expect(restoreInPanel({ phase: 'idle', restoreNetwork: false, detail: 'The kill switch is on' })).toBe(false);
    const home = readFileSync(join(__dirname, '../../src/renderer/src/screens/Home.tsx'), 'utf8');
    expect(home).toMatch(/const explainsBlock = restoreInPanel\(conn\);/);
    expect(home).toMatch(/\{conn\.restoreNetwork && !explainsBlock && \(/);
    expect(home).toMatch(/\{explainsBlock && <button data-restore-network/);
  });

  it('ended() shows that view in its first update, with no "Not connected" step and no 3 s wait', () => {
    const src = readFileSync(join(__dirname, '../../src/main/services/connection.ts'), 'utf8');
    const body = src.slice(src.indexOf('function ended('), src.indexOf('export function endedHeldView'));
    expect(body).toMatch(/patch\(\{ session: null, conn: heldView \?\? viewFor\(/);
    expect(body).toMatch(/if \(heldView\) void confirmHeldAfterEnd\(\);/);
    expect(body).toMatch(/if \(unexpected && !heldView\) \{/); // the 3 s idle-then-check path is only for the other cases
  });
});
