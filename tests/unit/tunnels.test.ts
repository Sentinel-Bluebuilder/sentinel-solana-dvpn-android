// ─── Leftover tunnel services (gap #29) and the kill-switch connect error ───
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/main/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../../src/main/system/elevate', () => ({ runElevated: vi.fn() }));
vi.mock('../../src/main/daemon/manager', () => ({ scriptPath: (n: string) => n }));

import { parseTunnelServices, parseOrphanProcesses, parseRivalRoutes } from '../../src/main/system/tunnels';
import { connectErrorCopy } from '../../src/core/session/state';

const block = (name: string, state: string): string => [
  `SERVICE_NAME: ${name}`,
  `DISPLAY_NAME: ${name}`,
  '        TYPE               : 10  WIN32_OWN_PROCESS',
  `        STATE              : ${state}`,
  '        WIN32_EXIT_CODE    : 0  (0x0)',
].join('\r\n');

describe('parseTunnelServices', () => {
  it('finds our running WireGuard and AmneziaWG tunnels only', () => {
    const out = [
      block('Dnscache', '4  RUNNING'),
      block('WireGuardTunnel$dvpn-wg-client', '4  RUNNING'),
      block('AmneziaWGTunnel$dvpn-awg-client', '2  START_PENDING'),
      block('WireGuardTunnel$home-office', '4  RUNNING'), // a user's own tunnel: never ours
      block('WireGuardTunnel$dvpn-old', '1  STOPPED'),
    ].join('\r\n\r\n');
    expect(parseTunnelServices(out)).toEqual(['WireGuardTunnel$dvpn-wg-client', 'AmneziaWGTunnel$dvpn-awg-client']);
  });

  it('returns nothing for empty or unrelated output', () => {
    expect(parseTunnelServices('')).toEqual([]);
    expect(parseTunnelServices(block('Spooler', '4  RUNNING'))).toEqual([]);
  });
});

describe('connectErrorCopy: kill switch apply failure', () => {
  it('names the kill switch instead of "Something went wrong"', () => {
    const c = connectErrorCopy('rpc error: code = FailedPrecondition desc = failed precondition: applying firewall: applying kill switch: finding interface dvpn-wg-client: route ip+net: no such network interface');
    expect(c.code).toBe('kill-switch-failed');
    expect(c.message).toMatch(/kill switch/);
  });
});

describe('killSwitchBlocksProtocol (Windows, gap #29)', () => {
  it('refuses kill switch on/persist with WireGuard, AmneziaWG, OpenVPN on Windows', async () => {
    const { killSwitchBlocksProtocol } = await import('../../src/core/session/state');
    for (const p of ['wireguard', 'amneziawg', 'openvpn']) {
      expect(killSwitchBlocksProtocol('win32', 'on', p)).toMatch(/Nothing was paid/);
      expect(killSwitchBlocksProtocol('win32', 'persist', p)).not.toBeNull();
    }
  });
  it('allows the protocols that work, kill switch off, and other platforms', async () => {
    const { killSwitchBlocksProtocol } = await import('../../src/core/session/state');
    for (const p of ['hysteria2', 'v2ray', 'xray']) expect(killSwitchBlocksProtocol('win32', 'on', p)).toBeNull();
    expect(killSwitchBlocksProtocol('win32', 'off', 'wireguard')).toBeNull();
    expect(killSwitchBlocksProtocol('linux', 'on', 'wireguard')).toBeNull();
    expect(killSwitchBlocksProtocol('win32', 'on', null)).toBeNull();
  });
});

describe('parseOrphanProcesses (gap the Linux app)', () => {
  it('finds hysteria2 / v2ray / xray by name, nothing else', () => {
    const csv = [
      '"System Idle Process","0","Services","0","8 K"',
      '"hysteria2.exe","2424","Services","0","30,000 K"',
      '"xray.exe","77","Services","0","9 K"',
      '"openvpn.exe","88","Services","0","9 K"', // may be the user's own: the elevated step decides
      '"v2rayN.exe","99","Console","1","9 K"', // a different program
    ].join('\r\n');
    expect(parseOrphanProcesses(csv)).toEqual(['hysteria2.exe:2424', 'xray.exe:77']);
  });
  it('empty output = none', () => expect(parseOrphanProcesses('')).toEqual([]));
});

describe('node identity failure (owner laptop 2026-10-21, node 5CBc2eb3)', () => {
  it('names it and says nothing was paid', () => {
    const c = connectErrorCopy('StartSession: failed precondition: verifying node metadata: verifying metadata signature: invalid signature');
    expect(c.code).toBe('node-identity');
    expect(c.message).toMatch(/Nothing was paid/);
    expect(c.retry).toBe(false);
  });
});

describe('kill switch refusal lifts on dvpnd rc+ (gap #29 fixed in dvpnd)', () => {
  it('refuses on rc, allows on rc', async () => {
    const { killSwitchBlocksProtocol, daemonFixesKillSwitch } = await import('../../src/core/session/state');
    expect(daemonFixesKillSwitch('cf4c372-rc')).toBe(false);
    expect(daemonFixesKillSwitch('cf4c372-rc')).toBe(true);
    expect(daemonFixesKillSwitch('cf4c372-rc')).toBe(true);
    expect(daemonFixesKillSwitch(null)).toBe(false);
    expect(killSwitchBlocksProtocol('win32', 'on', 'wireguard', 'cf4c372-rc')).not.toBeNull();
    for (const p of ['wireguard', 'amneziawg', 'openvpn']) expect(killSwitchBlocksProtocol('win32', 'persist', p, 'cf4c372-rc')).toBeNull();
  });
});

// ─── A 429 on a new-deposit start never pays twice (VM dns6 2026-10-22: connect failed on a 429 burst) ───
import { newDepositAfter429 } from '../../src/core/session/state';
describe('newDepositAfter429', () => {
  const N = 'Node111111111111111111111111111111111111111';
  it('adopts a deposit to this node that appeared during the attempt', () => {
    expect(newDepositAfter429(N, new Set(['A']), [{ address: 'A', node: N, status: 'open' }, { address: 'B', node: N, status: 'open' }])).toEqual({ action: 'adopt', channel: 'B' });
  });
  it('retries when nothing new was opened (nothing paid)', () => {
    expect(newDepositAfter429(N, new Set(['A']), [{ address: 'A', node: N, status: 'open' }, { address: 'C', node: 'other', status: 'open' }])).toEqual({ action: 'retry' });
  });
  it('ignores closed rows and stops when the list is unreadable', () => {
    expect(newDepositAfter429(N, new Set([]), [{ address: 'D', node: N, status: 'closed' }])).toEqual({ action: 'retry' });
    expect(newDepositAfter429(N, null, [])).toEqual({ action: 'unknown' });
    expect(newDepositAfter429(N, new Set([]), null)).toEqual({ action: 'unknown' });
  });
});

describe('parseRivalRoutes (Cosmos lesson D6: another VPN is on)', () => {
  it('flags the 0/1 + 128/1 pair of a foreign tunnel once', () => {
    expect(parseRivalRoutes('home-office|0.0.0.0/1|0|WireGuard Tunnel\nhome-office|128.0.0.0/1|0|WireGuard Tunnel\nEthernet|0.0.0.0/0|1|Intel(R) Ethernet')).toEqual(['home-office']);
  });
  it('flags a default route on a virtual VPN adapter', () => {
    expect(parseRivalRoutes('NordLynx|0.0.0.0/0|0|NordLynx Tunnel')).toEqual(['NordLynx']);
  });
  it('ignores our own adapters and the physical default route', () => {
    const t = ['dvpn-wg-client|0.0.0.0/1|0|WireGuard Tunnel', 'dvpn-wg-client|128.0.0.0/1|0|WireGuard Tunnel', 'OpenVPN Wintun|0.0.0.0/1|0|Wintun Userspace Tunnel', 'hy2-client|0.0.0.0/0|0|sing-tun', 'Wi-Fi|0.0.0.0/0|1|Intel Wi-Fi 6'].join('\r\n');
    expect(parseRivalRoutes(t)).toEqual([]);
  });
  it('ignores a non-VPN virtual default route (e.g. a Hyper-V switch)', () => {
    expect(parseRivalRoutes('vEthernet (External)|0.0.0.0/0|0|Hyper-V Virtual Ethernet Adapter')).toEqual([]);
  });
});
