// ─── Node test run (F20): the Cosmos lessons I4 / I7 / UX12 / UX1 ───
// I4: progress keeps counting when a server fails. I7: Stop works while a server is being tested
// (it is disconnected, marked CANCELLED, later servers too). UX12: a server named twice runs once.
// UX1: the last run is read back from disk (what the page shows after a restart).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
  dir: '',
  session: null as null | { channel: string },
  connects: [] as string[],
  disconnects: 0,
  failNode: '',
  onConnect: (() => undefined) as () => void,
}));
vi.mock('../../src/main/store', () => ({ storePath: (n: string) => `${h.dir}/${n}` }));
vi.mock('../../src/main/logger', () => ({ log: { warn: () => undefined, info: () => undefined } }));
vi.mock('../../src/main/wallet/vault', () => ({ ownerAddress: () => 'Owner' }));
vi.mock('../../src/main/app-state', () => ({ snapshot: () => ({ session: h.session, dns: null }) }));
vi.mock('../../src/core/chain/accounts', () => ({ channelsByOwner: async () => [] }));
vi.mock('../../src/main/services/settlement', () => ({ readSettlements: async () => [], runSettlement: async () => ({ ok: true }), settlesOnEnd: (r: string) => !/switching servers/i.test(r) }));
vi.mock('../../src/core/nodes/discovery', () => ({
  discoverNode: async (a: string) => ({ address: a, country: 'US', protocolNames: ['wireguard'], uri: 'https://10.0.0.1:443', pricePerGb: '1000', pricePerHour: '0' }),
}));
vi.mock('../../src/core/quality/quality', () => ({
  publicIp: async () => ({ ip: '10.0.0.1' }),
  speedTest: async () => ({ mbps: 100, source: 'test' }),
}));
vi.mock('../../src/main/services/connection', () => ({
  connect: async (r: { node: string }) => {
    h.connects.push(r.node);
    if (r.node === h.failNode) return { ok: false, error: 'tunnel did not come up' };
    h.session = { channel: `ch-${r.node}` };
    h.onConnect();
    return { ok: true, data: { service: 'wireguard', channel: `ch-${r.node}`, proxyEndpoint: '' } };
  },
  disconnect: async () => { h.disconnects++; h.session = null; return { ok: true }; },
}));
vi.mock('node:dns', () => ({ default: { promises: { lookup: async () => ({ address: '1.1.1.1' }) } } }));
const svc = await import('../../src/main/services/node-test');

beforeEach(() => {
  h.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-host'));
  // The service waits 2 s per server and 20 s before settling: run those waits at once.
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => { queueMicrotask(fn); return 0; }) as unknown as typeof setTimeout);
  h.session = null; h.connects = []; h.disconnects = 0; h.failNode = ''; h.onConnect = () => undefined;
});
afterEach(() => { vi.restoreAllMocks(); });
const run = (nodes: string[]) => svc.runNodeTest({ nodes, maxSpend: '1000000000', confirmed: true }, () => undefined);

describe('runNodeTest', () => {
  it('a failing server still moves the progress on (I4)', async () => {
    h.failNode = 'B';
    const r = await run(['A', 'B', 'C']);
    expect(r.ok).toBe(true);
    expect(r.data!.done).toBe(3);
    expect(r.data!.results.map((x) => x.verdict)).toEqual(['FAST', 'FAIL', 'FAST']);
  });

  it('Stop during a server: disconnected, CANCELLED, later servers not touched (I7)', async () => {
    h.onConnect = () => { svc.stopNodeTest(); };
    const r = await run(['A', 'B']);
    expect(r.data!.results.map((x) => x.verdict)).toEqual(['CANCELLED', 'CANCELLED']);
    expect(r.data!.results[0].reason).toMatch(/during this server/);
    expect(r.data!.results[1].reason).toMatch(/before this server/);
    expect(h.connects).toEqual(['A']);
    expect(h.disconnects).toBe(1);
    expect(h.session).toBeNull();
    expect(r.data!.stopped).toBe(true);
  });

  it('a server named twice is tested once (UX12)', async () => {
    const r = await run(['A', 'A', 'B']);
    expect(r.data!.total).toBe(2);
    expect(h.connects).toEqual(['A', 'B']);
  });

  it('the last run is read back from disk (UX1: shown after a restart)', async () => {
    const r = await run(['A']);
    expect(svc.getRun()?.id).toBe(r.data!.id);
    expect(svc.listRuns()[0].fast).toBe(1);
  });
});
