// ─── Node discovery + probe (F6) ───
// Ported from sentinel-node-tester-solana lib/discovery.js. Discovery is on-chain
// only. "Listed" outlives a dead daemon by up to the listing TTL, so a listing is
// split into `listed` (status) and `listingFresh` (TTL not lapsed); the probe then
// asks the node itself — signed /v1/metadata, signer = on-chain owner, claims
// match the account, TLS pin recorded for the session.
import net from 'node:net';
import { allNodes, nodeByPda, signerAuthorized } from '../chain/accounts';
import { fetchConfig } from '../chain/program';
import { PERM_SIGN_NODE_METADATA, PROGRAM_ID, STATUS_LISTED } from '../chain/idl';
import { httpsRequest, parseUri, verifySignedMetadata } from './nodeapi';
import { countryName, continentOf, countryNameToCode } from './country';

export interface NodeRecord {
  address: string;
  owner: string;
  listed: boolean;
  listedAt: number;
  expiresAt: number;
  listingFresh: boolean;
  uri: string;
  countryCode: string;
  country: string;
  continent: string;
  protocols: number;
  protocolNames: string[];
  pricePerGb: string;
  pricePerHour: string;
}

export function enrich(n: Record<string, unknown>, ttlSeconds: number, now: number): NodeRecord {
  const listedAt = Number(n.listedAt ?? 0);
  const expiresAt = listedAt ? listedAt + ttlSeconds : 0;
  const listed = Number(n.status) === STATUS_LISTED;
  const code = countryNameToCode(String(n.country ?? '')); // chain stores a code; tolerate names (F6.8)
  return {
    address: String(n.address),
    owner: String(n.owner),
    listed,
    listedAt,
    expiresAt,
    listingFresh: listed && expiresAt > now,
    uri: String(n.uri ?? ''),
    countryCode: code,
    country: countryName(code),
    continent: continentOf(code),
    protocols: Number(n.protocols ?? 0),
    protocolNames: (n.protocolNames as string[]) ?? [],
    pricePerGb: String(n.channelPricePerGb ?? '0'),
    pricePerHour: String(n.channelPricePerHour ?? '0'),
  };
}

/** Every node account, enriched; newest listing first. */
export async function discoverNodes(): Promise<NodeRecord[]> {
  const [nodes, cfg] = await Promise.all([allNodes(), fetchConfig()]);
  const now = Math.floor(Date.now() / 1000);
  return nodes.map((n) => enrich(n, cfg.nodeListingTtlSeconds, now)).sort((a, b) => b.listedAt - a.listedAt);
}

export async function discoverNode(address: string): Promise<NodeRecord | null> {
  const [n, cfg] = await Promise.all([nodeByPda(address), fetchConfig()]);
  return n ? enrich(n, cfg.nodeListingTtlSeconds, Math.floor(Date.now() / 1000)) : null;
}

export function tcpReachable(host: string, port: number, timeoutMs = 6000): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (ok: boolean): void => { sock.destroy(); resolve(ok); };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

export interface ProbeResult {
  ok: boolean;
  reachable: boolean;
  latencyMs: number | null;
  signatureValid: boolean | null;
  claimsMatch: boolean | null;
  signerIsOwner: boolean | null;
  /** The owner, or an operator holding a live PermSignNodeMetadata grant; null = not checked. */
  signerAuthorized: boolean | null;
  metadataExpired: boolean | null;
  tlsPinMatch: boolean | null;
  peers: number | null;
  maxPeers: number | null;
  downloadMbps: number | null;
  uploadMbps: number | null;
  city: string | null;
  serviceType: string | null;
  version: string | null;
  error: string | null;
  probedAt: number;
}

/** DVPN_NODE_API_OVERRIDES=<node>=https://host:port,… — lab nodes whose on-chain URI is not routable from here (test rig only). */
export function nodeApiOverride(address: string, raw = process.env.DVPN_NODE_API_OVERRIDES ?? ''): string | null {
  for (const part of raw.split(',')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === address) return part.slice(eq + 1).trim();
  }
  return null;
}

/**
 * REALITY carries no traffic on this protocol (doc 18 §6, weakness 1), and one REALITY
 * inbound was enough to break the client, so any REALITY inbound hides the node (F6.6).
 * V2Ray/Xray metadata: service.payload.inbounds[].security = "tls" | "reality" | "none".
 */
export function hasRealityTransport(service: unknown): boolean {
  const s = service as { type?: unknown; payload?: { inbounds?: Array<{ security?: unknown }> } } | null | undefined;
  if (!s) return false;
  if (typeof s.type === 'string' && /reality/i.test(s.type)) return true;
  return (s.payload?.inbounds ?? []).some((i) => typeof i?.security === 'string' && /reality/i.test(i.security));
}

/** Ask the node what it is. Never throws. `ok` = safe to pay this node. */
export async function probeNode(node: Pick<NodeRecord, 'address' | 'owner' | 'uri'>, { timeoutMs = 6000 } = {}): Promise<ProbeResult> {
  const out: ProbeResult = {
    ok: false, reachable: false, latencyMs: null, signatureValid: null, claimsMatch: null, signerIsOwner: null, signerAuthorized: null,
    metadataExpired: null, tlsPinMatch: null, peers: null, maxPeers: null, downloadMbps: null, uploadMbps: null,
    city: null, serviceType: null, version: null, error: null, probedAt: Date.now(),
  };
  const target = parseUri(nodeApiOverride(node.address) ?? node.uri);
  if (!target) { out.error = 'Node address on chain is not a valid URL'; return out; }
  if (!(await tcpReachable(target.host, target.port, Math.min(timeoutMs, 6000)))) { out.error = 'Node is not reachable'; return out; }
  let res;
  try {
    res = await httpsRequest(`${target.origin}/v1/metadata`, { timeoutMs, captureCert: true });
  } catch (err) {
    out.error = `Node did not answer: ${(err as Error).message}`;
    return out;
  }
  out.latencyMs = res.latencyMs;
  if (res.status !== 200 || !res.json) { out.error = `Node answered HTTP ${res.status}`; return out; }
  out.reachable = true;
  const m = (res.json.payload ?? {}) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  out.signatureValid = verifySignedMetadata(res.text, res.json);
  out.signerIsOwner = res.json.signer === node.owner;
  // cf4c372 VerifyMetadata: the payload names its signer as `operator` (the owner too, when it signs).
  out.claimsMatch = m.node === node.address && m.owner === node.owner && m.program_id === PROGRAM_ID.toBase58() && typeof res.json.signer === 'string' && m.operator === res.json.signer;
  out.metadataExpired = Number(m.expires_at ?? 0) > 0 && Math.floor(Date.now() / 1000) >= Number(m.expires_at);
  const pin = m.api?.tls_sha256 ? String(m.api.tls_sha256).toLowerCase() : null;
  out.tlsPinMatch = pin && res.certSha256 ? pin === res.certSha256.toLowerCase() : null;
  out.peers = m.peers ? Number(m.peers.current) : null;
  out.maxPeers = m.peers ? Number(m.peers.max) : null;
  if (m.bandwidth) {
    // bytes/s: cf4c372 names them *_bytes_per_second, dfe36c7 download/upload.
    out.downloadMbps = Math.round((Number(m.bandwidth.download_bytes_per_second ?? m.bandwidth.download ?? 0) * 8 / 1e6) * 100) / 100;
    out.uploadMbps = Math.round((Number(m.bandwidth.upload_bytes_per_second ?? m.bandwidth.upload ?? 0) * 8 / 1e6) * 100) / 100;
  }
  out.city = m.location?.city ?? null;
  out.serviceType = m.service?.type ? String(m.service.type) : null;
  out.version = m.sdk_version ?? null;
  let authError: string | null = null;
  if (out.signatureValid && typeof res.json.signer === 'string') {
    try {
      out.signerAuthorized = await signerAuthorized(node.owner, res.json.signer, PERM_SIGN_NODE_METADATA, node.address);
    } catch (err) {
      authError = `Could not check the node operator's permission: ${(err as Error).message}`;
    }
  }
  if (!out.signatureValid) out.error = 'Node metadata signature is invalid';
  else if (authError) out.error = authError;
  else if (!out.signerAuthorized) out.error = 'Node metadata is signed by neither the node owner nor an operator it allowed';
  else if (!out.claimsMatch) out.error = 'Node metadata does not match its on-chain account';
  else if (out.metadataExpired) out.error = 'Node metadata has expired';
  else if (out.tlsPinMatch === false) out.error = 'Node TLS certificate does not match its pin';
  else if (out.maxPeers !== null && out.peers !== null && out.maxPeers > 0 && out.peers >= out.maxPeers) out.error = 'Node is full';
  else if (hasRealityTransport(m.service)) out.error = 'Transport not supported (REALITY)';
  out.ok = out.error === null;
  return out;
}

/** Probe many nodes with bounded concurrency; `onResult` fires per node (progress "Probed X/Y"). */
export async function probeAll(nodes: NodeRecord[], onResult: (address: string, r: ProbeResult) => void, { concurrency = 30, timeoutMs = 6000 } = {}): Promise<void> {
  let i = 0;
  const worker = async (): Promise<void> => {
    while (i < nodes.length) {
      const n = nodes[i++];
      onResult(n.address, await probeNode(n, { timeoutMs }));
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, nodes.length) }, worker));
}
