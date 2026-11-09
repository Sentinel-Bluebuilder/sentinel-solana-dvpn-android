// ─── APK third-party notices ───
// Writes src/renderer/public/THIRD-PARTY-NOTICES.txt (shipped in the APK, shown from Settings → About)
// from android/android-deps.lock.json (protocol programs), the parts built from source below, and the
// licence texts in android/licenses/. tests/unit/android-notices.test.ts fails when the file is stale.
// Usage: node scripts/android-notices.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const NOTICES_FILE = 'src/renderer/public/THIRD-PARTY-NOTICES.txt';

// ─── Parts built from source (not in the lock) ───
const OVPN = '2.6.23';
const OSSL = '3.5.9';
const NODE = '22.23.4';
const BUILT = [
  {
    name: 'Sentinel dVPN daemon (dvpnd), with Android platform changes',
    files: 'lib/<abi>/libdvpnd.so',
    license: 'Sentinel dVPN License',
    texts: ['sentinel-dvpn.LICENSE', 'dvpnd.CREDITS.md'],
    note: 'Built on Sentinel. https://sentinel.co. The Go modules it is built from (among them wireguard-go and amneziawg-go) are listed with their licences in the credits below.',
  },
  {
    name: 'github.com/ncruces/go-sqlite3-wasm/v6 v6.4.35401 (compiled into dvpnd)',
    files: 'lib/<abi>/libdvpnd.so',
    license: 'MIT No Attribution (MIT-0); SQLite: public domain',
    texts: ['go-sqlite3-wasm.LICENSE'],
    note: 'Copyright (c) 2026 Nuno Cruces. Source: https://github.com/ncruces/go-sqlite3-wasm/tree/v6.4.35401. Contains a machine translation (wasm2go) of SQLite 3.54.1 and the SQLite ext/misc extensions decimal, ieee754, regexp, series and uint, which are in the public domain (https://sqlite.org/copyright.html).',
  },
  {
    name: 'Sentinel protocol files: the dvpnd API (daemon.proto) and the devnet program interface (dvpn.devnet.json)',
    files: 'inside the app bundle',
    license: 'Sentinel dVPN License',
    texts: ['sentinel-dvpn.LICENSE'],
  },
  {
    name: `OpenVPN ${OVPN}`,
    files: 'lib/<abi>/libovpnexec.so',
    license: 'GPL-2.0 (with the OpenSSL linking exception)',
    texts: ['openvpn.COPYING', 'openvpn.COPYRIGHT.GPL'],
    source: [
      `https://swupdate.openvpn.net/community/releases/openvpn-${OVPN}.tar.gz (signature checked at build)`,
      `https://github.com/openssl/openssl/releases/download/openssl-${OSSL}/openssl-${OSSL}.tar.gz (SHA-256 checked at build)`,
    ],
    note: 'Unmodified upstream source. The build script (scripts/build-openvpn-android.sh) configures it as Linux and then switches the generated config.h to the Android target. Both tarballs and the build script are published as gpl-source/ next to every APK release (scripts/release-android.sh refuses a release without them). Written offer: for at least three years after each release, whoever distributed this APK to you will give you the same complete corresponding source, as a download or on a physical medium, for no more than the cost of providing it.',
  },
  {
    name: `OpenSSL ${OSSL} (linked into OpenVPN)`,
    files: 'lib/<abi>/libovpnexec.so',
    license: 'Apache-2.0',
    texts: ['openssl.LICENSE'],
    source: [`https://github.com/openssl/openssl/tree/openssl-${OSSL}`],
  },
  {
    name: `Node.js ${NODE} (runs the app's services; includes V8, libuv, OpenSSL, zlib and the other parts its licence lists)`,
    files: 'lib/<abi>/libnode-bin.so',
    license: 'MIT and the licences of its bundled parts',
    texts: ['node.LICENSE'],
    source: [`https://github.com/nodejs/node/tree/v${NODE}`],
    note: 'Cross-built with two small build fixes (V8 trap handler, zlib CPU features) made by scripts/build-node-android.sh.',
  },
  {
    name: 'LLVM libc++ (from the Android NDK)',
    files: 'lib/<abi>/libc++_shared.so',
    license: 'Apache-2.0 WITH LLVM-exception',
    texts: ['libcxx.LICENSE'],
    source: ['https://github.com/llvm/llvm-project/tree/main/libcxx'],
  },
  {
    name: 'Fonts: JetBrains Mono, Outfit, Tomorrow',
    files: 'inside the app bundle',
    license: 'OFL-1.1',
    texts: ['font-jetbrains-mono.LICENSE', 'font-outfit.LICENSE', 'font-tomorrow.LICENSE'],
  },
  {
    name: 'rpc-websockets (used by the Solana web3 library)',
    files: 'inside the app bundle',
    license: 'LGPL-3.0',
    texts: ['rpc-websockets.LICENSE', 'lgpl-3.0.txt', 'gpl-3.0.txt'],
    source: ['https://github.com/elpheria/rpc-websockets'],
  },
];

// ─── Protocol programs: one entry per program, every ABI's SHA-256 ───
const LOCK_TEXT = { hysteria2: 'hysteria2.LICENSE', xray: 'xray.LICENSE', v2ray: 'v2ray.LICENSE' };
const LOCK_TITLE = { hysteria2: 'Hysteria 2', xray: 'Xray', v2ray: 'V2Ray' };

export function lockEntries(lock) {
  const byName = new Map();
  for (const r of lock) {
    for (const k of ['license', 'licenseUrl', 'sourceUrl']) {
      if (!r[k]) throw new Error(`android-deps.lock.json: ${r.name} ${r.abi} has no ${k}`);
    }
    if (!LOCK_TEXT[r.name]) throw new Error(`android-deps.lock.json: no licence text for ${r.name}`);
    const e = byName.get(r.name) ?? {
      name: `${LOCK_TITLE[r.name]} ${r.version}`,
      files: `lib/<abi>/lib${r.name}.so`,
      license: r.license,
      texts: [LOCK_TEXT[r.name]],
      source: [r.sourceUrl],
      builds: [],
    };
    e.builds.push(`${r.abi}: ${r.source}, SHA-256 ${r.sha256}`);
    byName.set(r.name, e);
  }
  return [...byName.values()];
}

export function buildNotices(root = ROOT) {
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'android/android-deps.lock.json'), 'utf8'));
  const entries = [...BUILT.slice(0, 2), ...lockEntries(lock), ...BUILT.slice(2)];
  const out = [
    'Devnet dVPN for Android: third-party notices',
    '',
    'Built on Sentinel. https://sentinel.co',
    '',
    'This app\'s own code is under the MIT License (LICENSE in its source). The parts below are the',
    'property of their authors and are under their own licences; the full texts follow the list.',
    '',
  ];
  entries.forEach((e, i) => {
    out.push(`${i + 1}. ${e.name}`, `   Files:   ${e.files}`, `   Licence: ${e.license}`);
    for (const s of e.source ?? []) out.push(`   Source:  ${s}`);
    for (const b of e.builds ?? []) out.push(`   Build:   ${b}`);
    if (e.note) out.push(`   Note:    ${e.note}`);
    out.push('');
  });
  const seen = new Set();
  for (const e of entries) {
    for (const t of e.texts) {
      if (seen.has(t)) continue;
      seen.add(t);
      const body = fs.readFileSync(path.join(root, 'android/licenses', t), 'utf8').replace(/\r\n/g, '\n').trimEnd();
      out.push('='.repeat(78), `${t}  (${e.name})`, '='.repeat(78), '', body, '');
    }
  }
  return `${out.join('\n')}\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = path.join(ROOT, NOTICES_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buildNotices());
  console.log(`${NOTICES_FILE} written`);
}
