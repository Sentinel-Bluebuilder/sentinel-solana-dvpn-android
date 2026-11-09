// ─── Android app bridge (Node → Kotlin) ───
// The app passes the abstract socket name in DVPN_APP_BRIDGE (android/…/node/AppBridge.kt).
// One JSON line per call. `bridgeCallSync` runs the call in a short child Node process so sync
// callers (the KeyStore interface) can use it; `bridgeCall` is the async form.
import net from 'node:net';
import { execFileSync } from 'node:child_process';

export interface BridgeReply { ok: boolean; data?: string; error?: string; [k: string]: unknown }

export const isAndroid = (): boolean => process.platform === 'android' || process.env.DVPN_PLATFORM === 'android';

function bridgeName(): string {
  const n = process.env.DVPN_APP_BRIDGE;
  if (!n) throw new Error('The Android app bridge is not available (DVPN_APP_BRIDGE unset): run this CLI from the app.');
  return n;
}

/** Linux abstract socket path for net.connect. */
export const abstractPath = (name: string): string => `\0${name}`;

export function bridgeCall(req: Record<string, unknown>, timeoutMs = 15_000): Promise<BridgeReply> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(abstractPath(bridgeName()));
    let buf = '';
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('The Android app did not answer in time.')); }, timeoutMs);
    sock.on('connect', () => sock.write(JSON.stringify(req) + '\n'));
    sock.on('data', (d) => { buf += d.toString('utf8'); });
    sock.on('error', (e) => { clearTimeout(timer); reject(new Error(`Android app bridge: ${e.message}`)); });
    sock.on('close', () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(buf.trim()) as BridgeReply);
      } catch (err) {
        reject(new Error(`Android app bridge sent an unreadable reply: ${(err as Error).message}`));
      }
    });
  });
}

// Child script: reads the request on stdin, writes the reply on stdout.
const CHILD = `
const net = require('node:net');
let input = '';
process.stdin.on('data', (d) => { input += d; }).on('end', () => {
  const s = net.connect('\\0' + process.env.DVPN_APP_BRIDGE);
  let out = '';
  s.on('connect', () => s.write(input.trim() + '\\n'));
  s.on('data', (d) => { out += d; });
  s.on('error', (e) => { process.stdout.write(JSON.stringify({ ok: false, error: e.message })); });
  s.on('close', () => { if (out) process.stdout.write(out.trim()); });
});`;

export function bridgeCallSync(req: Record<string, unknown>, timeoutMs = 15_000): BridgeReply {
  bridgeName();
  const out = execFileSync(process.execPath, ['-e', CHILD], { input: JSON.stringify(req), encoding: 'utf8', timeout: timeoutMs });
  try {
    return JSON.parse(out.trim()) as BridgeReply;
  } catch (err) {
    throw new Error(`Android app bridge sent an unreadable reply: ${(err as Error).message}`);
  }
}

/** Seal bytes with the app's Android Keystore key (AES-256-GCM; the key never leaves Keystore). */
export function sealSync(plain: Buffer): string {
  const r = bridgeCallSync({ op: 'seal', data: plain.toString('base64') });
  if (!r.ok || !r.data) throw new Error(`Android Keystore could not encrypt the wallet: ${r.error ?? 'no data'}`);
  return r.data;
}

export function unsealSync(sealedB64: string): Buffer {
  const r = bridgeCallSync({ op: 'unseal', data: sealedB64 });
  if (!r.ok || !r.data) throw new Error(`Android Keystore could not decrypt the wallet (was the app reinstalled?): ${r.error ?? 'no data'}`);
  return Buffer.from(r.data, 'base64');
}


/** Android: is the VPN interface held with no session (the kill switch blocking)? null = unknown. */
export async function androidHeldBlock(): Promise<boolean | null> {
  const r = await bridgeCall({ op: 'vpnState' }, 5000);
  const st = r.ok ? (r.state as { held?: unknown; connected?: unknown } | null | undefined) : null;
  if (!st || typeof st.held !== 'boolean') return null;
  return st.held && st.connected !== true;
}
