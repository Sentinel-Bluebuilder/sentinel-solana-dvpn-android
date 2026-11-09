import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { browserArgs, browserCandidates, findBrowser } from '../../src/main/system/browser';

describe('browser through the VPN (F16.2)', () => {
  it('sends everything to the SOCKS endpoint and keeps DNS off this computer', () => {
    const a = browserArgs('127.0.0.1:1080', 'C:\\p', 'https://api.ipify.org');
    expect(a).toContain('--proxy-server=socks5://127.0.0.1:1080');
    expect(a).toContain('--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1');
    expect(a).toContain('--user-data-dir=C:\\p');
    expect(a).toContain('--disable-quic');
    expect(a[a.length - 1]).toBe('https://api.ipify.org');
  });
  it('refuses anything but a local SOCKS endpoint', () => {
    expect(() => browserArgs('10.0.0.1:1080', 'p', 'u')).toThrow(/not a local SOCKS endpoint/);
    expect(() => browserArgs('127.0.0.1:1080 --evil', 'p', 'u')).toThrow();
  });
  it('looks in machine-wide then per-user folders', () => {
    const c = browserCandidates('chrome', { ProgramFiles: 'PF', 'ProgramFiles(x86)': 'PF86', LOCALAPPDATA: 'L' });
    const rel = path.join('Google', 'Chrome', 'Application', 'chrome.exe');
    expect(c).toEqual([path.join('PF86', rel), path.join('PF', rel), path.join('L', rel)]);
    expect(findBrowser('edge', () => false)).toBeNull();
  });
});
