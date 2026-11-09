// ─── Protocol logos: every protocol covered, bundled files only, documented ───
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROTOCOLS, protocolLabel } from '../../src/shared/protocols';
import { PROTOCOL_BITS } from '../../src/core/chain/idl';

const SRC = readFileSync('src/renderer/src/components/ProtocolMark.tsx', 'utf8');
const ASSET_DIR = 'src/renderer/src/assets/protocols';
const imports = [...SRC.matchAll(/from '\.\.\/assets\/protocols\/([^']+)'/g)].map((m) => m[1]);

describe('protocol marks', () => {
  it('cover every protocol the chain knows', () => {
    expect([...PROTOCOLS].sort()).toEqual(PROTOCOL_BITS.map(([, n]) => n).sort());
    for (const p of PROTOCOLS) expect(SRC).toMatch(new RegExp(`\\b${p}: `));
  });

  it('have display names', () => {
    expect(PROTOCOLS.map(protocolLabel)).toEqual(['WireGuard', 'AmneziaWG', 'OpenVPN', 'V2Ray', 'Xray', 'Hysteria2']);
    expect(protocolLabel('XRAY')).toBe('Xray');
    expect(protocolLabel('other')).toBe('other');
  });

  it('load only bundled files (CSP img-src self/data)', () => {
    expect(SRC).not.toMatch(/https?:\/\//);
    expect(imports.length).toBeGreaterThan(5);
    for (const f of imports) expect(existsSync(join(ASSET_DIR, f))).toBe(true);
  });

  it('svg files carry no script or remote reference', () => {
    for (const f of imports.filter((x) => x.endsWith('.svg'))) {
      const t = readFileSync(join(ASSET_DIR, f), 'utf8');
      expect(t).not.toMatch(/<script|javascript:|on\w+=|href="https?:|<image/i);
    }
  });

  it('WireGuard and OpenVPN show their official files (owner decision 2026-10-22) and every file is in ASSETS.md', () => {
    expect(imports).toContain('wireguard.png');
    expect(imports).toEqual(expect.arrayContaining(['openvpn-on-dark.svg', 'openvpn-on-light.svg']));
    const doc = readFileSync('docs/ASSETS.md', 'utf8');
    for (const f of imports) expect(doc).toContain(f);
  });

  it('every protocol id has a logo asset or a documented name badge', () => {
    const map = SRC.slice(SRC.indexOf('PROTOCOL_LOGOS'), SRC.indexOf('PROTOCOL_BADGES'));
    const badges = SRC.slice(SRC.indexOf('PROTOCOL_BADGES'));
    const doc = readFileSync('docs/ASSETS.md', 'utf8');
    for (const p of PROTOCOLS) {
      const entry = map.match(new RegExp(`\\b${p}: ([^\\n]+)`))?.[1] ?? '';
      expect(entry, p).not.toBe('');
      if (entry.startsWith('null')) {
        expect(badges, `${p} badge text`).toMatch(new RegExp(`\\b${p}: '[A-Z0-9]{2,4}'`));
        expect(doc, `${p} reason in ASSETS.md`).toContain(`### ${protocolLabel(p)}:`);
        continue;
      }
      const vars = [...entry.matchAll(/(?:dark|light): (\w+)/g)].map((m) => m[1]);
      expect(vars.length, p).toBe(2);
      for (const v of vars) {
        const file = SRC.match(new RegExp(`import ${v} from '\\.\\./assets/protocols/([^']+)'`))?.[1];
        expect(file, `${p} -> ${v}`).toBeTruthy();
        expect(existsSync(join(ASSET_DIR, file!))).toBe(true);
      }
    }
  });
});
