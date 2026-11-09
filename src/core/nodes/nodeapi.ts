// ─── HTTPS to node / provider daemons + signed-message checks ───
// Ported from sentinel-node-tester-solana lib/nodeapi.js (mirrors
// sentinel-go-sdk/auth byte for byte). The app only READS from daemons: signed
// metadata (signature over domain32 ‖ sha256(payload bytes)), plan rosters. Session
// credentials (vouchers, ticket requests) are the client daemon's job.
//
// TLS: daemons use self-signed certs and advertise a sha256 pin in their signed
// metadata (payload.api.tls_sha256). With a pin the handshake is torn down on
// mismatch BEFORE any request byte is sent.
import https from 'node:https';
import { createHash, createPublicKey, verify as edVerify } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';

/** Domain as dvpnd cf4c372+ builds it: sha256(tag) (sentinel-go-sdk/auth NewDomain). */
export function domain(tag: string): Buffer {
  return createHash('sha256').update(tag, 'utf8').digest();
}

/** Domain as dvpnd dfe36c7 built it: the tag zero-padded to 32 bytes. Nodes on that build still run. */
export function legacyDomain(tag: string): Buffer {
  if (Buffer.byteLength(tag) > 32) throw new Error(`domain ${tag} exceeds 32 bytes`); // copy:internal
  const d = Buffer.alloc(32);
  d.write(tag, 'utf8');
  return d;
}

// Each list = the current domain first, then the one older nodes sign with (tag renamed for providers).
export const DOMAIN_NODE_METADATA: readonly Buffer[] = [domain('sentinel-dvpn/node-metadata/v1'), legacyDomain('sentinel-dvpn/node-metadata/v1')];
export const DOMAIN_PROVIDER_METADATA: readonly Buffer[] = [domain('sentinel-dvpn/provider-metadata/v1'), legacyDomain('sentinel-dvpn/provider-meta/v1')];

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** ed25519 verify of (dom ‖ msg) by a base58 Solana pubkey, via node:crypto. */
export function verifyDomain(pubkey: string, dom: Buffer, msg: Buffer, sig: Buffer): boolean {
  const raw = new PublicKey(pubkey).toBuffer();
  const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
  return edVerify(null, Buffer.concat([dom, msg]), key, sig);
}

/** Extract the raw `payload` JSON text (byte-exact) from a SignedMessage body. */
export function rawPayload(text: string): string | null {
  const keyStr = '"payload"';
  const k = text.indexOf(keyStr);
  if (k < 0) return null;
  let i = text.indexOf(':', k + keyStr.length);
  if (i < 0) return null;
  i += 1;
  while (i < text.length && /\s/.test(text[i])) i += 1;
  if (text[i] !== '{') return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let j = i; j < text.length; j++) {
    const c = text[j];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(i, j + 1);
    }
  }
  return null;
}

export interface SignedBody { payload?: Record<string, unknown>; signature?: string; signer?: string }

export function verifySignedMetadata(text: string, json: SignedBody | null, doms: readonly Buffer[] = DOMAIN_NODE_METADATA): boolean {
  const raw = rawPayload(text);
  if (!raw || !json || !json.signature || !json.signer) return false;
  const digest = createHash('sha256').update(Buffer.from(raw, 'utf8')).digest();
  try {
    const sig = Buffer.from(json.signature, 'base64');
    const signer = json.signer;
    return doms.some((d) => verifyDomain(signer, d, digest, sig));
  } catch (err) {
    console.warn(`[nodeapi] signature check threw: ${(err as Error).message}`);
    return false;
  }
}

export interface HttpsResult {
  status: number;
  text: string;
  json: SignedBody & Record<string, unknown> | null;
  certSha256: string | null;
  latencyMs: number;
}

export class TlsPinError extends Error {
  code = 'tls-pin-mismatch';
}

export function httpsRequest(url: string, opts: { method?: string; pinSha256?: string | null; timeoutMs?: number; captureCert?: boolean } = {}): Promise<HttpsResult> {
  const { method = 'GET', pinSha256 = null, timeoutMs = 10_000, captureCert = false } = opts;
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    let certSha256: string | null = null;
    const started = Date.now();
    const req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method,
      rejectUnauthorized: false, // self-signed daemon certs; trust comes from the signed pin
      agent: false, // fresh connection so the handshake hook always runs
      timeout: timeoutMs,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch (err) {
          console.warn(`[nodeapi] ${u.host}${u.pathname}: body is not JSON (${(err as Error).message})`);
        }
        resolve({ status: res.statusCode ?? 0, text, json, certSha256, latencyMs: Date.now() - started });
      });
    });
    req.on('socket', (socket) => {
      socket.once('secureConnect', () => {
        const tls = socket as import('node:tls').TLSSocket;
        const cert = tls.getPeerCertificate();
        const got = cert && cert.raw ? createHash('sha256').update(cert.raw).digest('hex') : '';
        if (captureCert) certSha256 = got || null;
        if (pinSha256 && got.toLowerCase() !== pinSha256.toLowerCase()) {
          const e = new TlsPinError(`TLS certificate of ${u.hostname} does not match its signed pin`);
          socket.destroy(e);
          req.destroy(e);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`request to ${u.host} timed out after ${timeoutMs}ms`)));
    req.on('error', reject);
    req.end();
  });
}

export function parseUri(uri: string): { host: string; port: number; origin: string } | null {
  try {
    const u = new URL(uri);
    const port = Number(u.port) || 443;
    return { host: u.hostname, port, origin: `https://${u.hostname}:${port}` };
  } catch (err) {
    console.warn(`[nodeapi] not a URL: ${uri} (${(err as Error).message})`);
    return null;
  }
}
