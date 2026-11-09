// ─── Plans, providers, subscriptions (F10) ───
// Ported from sentinel-node-tester-solana lib/plans.js. A plan belongs to a
// provider; which nodes it covers is the provider's ROSTER, served over its
// public API (GET /v1/plans/{plan}/nodes). The provider's metadata signature,
// owner and TLS pin are checked before the roster is trusted.
import { allPlans, allProviders, providerByPda, signerAuthorized, subscriptionsByOwner } from '../chain/accounts';
import { PERM_SIGN_PROVIDER_METADATA, PROGRAM_ID, STATUS_LISTED } from '../chain/idl';
import { httpsRequest, parseUri, verifySignedMetadata, DOMAIN_PROVIDER_METADATA } from '../nodes/nodeapi';

export interface PlanRecord {
  address: string;
  provider: string;
  price: string; // base units, whole term
  durationSeconds: number;
  dataCapGb: number; // 0 = unlimited
  maxConnections: number;
  listed: boolean;
  providerUri: string;
  providerListed: boolean;
  /** W2: did the provider's API answer a short probe? undefined = not probed (list order = chain order). */
  providerAnswering?: boolean;
}

export interface ProviderProbeEntry { ok: boolean; at: number }

/**
 * W2: probe each distinct provider once (cached `ttlMs`), mark every plan with the answer and sort
 * plans whose provider answers first (stable inside each group). A probe that throws counts as
 * "not answering". Exported for tests.
 */
export async function markProviderAnswering(
  plans: PlanRecord[],
  probe: (providerPda: string) => Promise<boolean>,
  cache: Map<string, ProviderProbeEntry>,
  now = Date.now(),
  ttlMs = 60_000,
): Promise<PlanRecord[]> {
  const providers = [...new Set(plans.map((p) => p.provider))];
  await Promise.all(providers.map(async (prov) => {
    const hit = cache.get(prov);
    if (hit && now - hit.at < ttlMs) return;
    let ok = false;
    try { ok = await probe(prov); } catch { ok = false; }
    cache.set(prov, { ok, at: now });
  }));
  const marked = plans.map((p) => ({ ...p, providerAnswering: !!cache.get(p.provider)?.ok }));
  return [...marked.filter((p) => p.providerAnswering), ...marked.filter((p) => !p.providerAnswering)];
}

export async function listPlans(): Promise<PlanRecord[]> {
  const [plans, providers] = await Promise.all([allPlans(), allProviders()]);
  const byPda = new Map(providers.map((p) => [p.address, p]));
  return plans.map((p) => {
    const prov = byPda.get(p.provider);
    return {
      address: p.address,
      provider: p.provider,
      price: String(p.price),
      durationSeconds: Number(p.durationSeconds),
      dataCapGb: Number(p.dataCapGb),
      maxConnections: Number(p.maxConnections),
      listed: Number(p.status) === STATUS_LISTED,
      providerUri: prov?.uri ?? '',
      providerListed: prov ? Number(prov.status) === STATUS_LISTED : false,
    };
  }).filter((p) => p.listed);
}

export interface SubscriptionRecord {
  address: string;
  plan: string;
  provider: string;
  openedAt: number;
  expiresAt: number;
  active: boolean;
  rentPayer: string;
  maxConnections: number; // copied from the plan at purchase; counts TICKETS until they expire (0 = no limit)
  raw: Record<string, unknown>;
}

export async function subscriptionsOf(owner: string, now = Math.floor(Date.now() / 1000)): Promise<SubscriptionRecord[]> {
  const subs = await subscriptionsByOwner(owner);
  return subs.map((s) => ({
    address: s.address,
    plan: s.plan,
    provider: s.provider,
    openedAt: Number(s.openedAt ?? 0),
    expiresAt: Number(s.expiresAt ?? 0),
    active: Number(s.expiresAt ?? 0) > now,
    rentPayer: String(s.rentRecipient),
    maxConnections: Number(s.maxConnections ?? 0),
    raw: s,
  })).sort((a, b) => b.openedAt - a.openedAt);
}

export class ProviderError extends Error {
  constructor(message: string, public code: string) { super(message); }
}

/** DVPN_PROVIDER_API_OVERRIDES=<provider>=https://host:port,… — lab providers not routable from here (test rig only). */
export function providerApiOverride(address: string, raw = process.env.DVPN_PROVIDER_API_OVERRIDES ?? ''): string | null {
  for (const part of raw.split(',')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === address) return part.slice(eq + 1).trim().replace(/\/+$/, '');
  }
  return null;
}

/** Provider's verified API origin + TLS pin. */
export async function providerApi(providerPda: string, { timeoutMs = 8000 } = {}): Promise<{ origin: string; tlsSha256: string }> {
  const p = await providerByPda(providerPda);
  if (!p) throw new ProviderError(`Provider ${providerPda} not found on chain`, 'provider-not-found');
  const origin = providerApiOverride(providerPda) ?? parseUri(p.uri)?.origin;
  if (!origin) throw new ProviderError(`Provider advertises no usable address ("${p.uri}")`, 'provider-no-uri');
  const res = await httpsRequest(`${origin}/v1/metadata`, { timeoutMs, captureCert: true });
  if (res.status !== 200 || !res.json?.payload) throw new ProviderError(`Provider did not answer (HTTP ${res.status})`, 'provider-unreachable');
  const m = res.json.payload as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const problems: string[] = [];
  if (!verifySignedMetadata(res.text, res.json, DOMAIN_PROVIDER_METADATA)) problems.push('signature does not verify');
  if (m.owner !== p.owner) problems.push('owner does not match the chain');
  if (m.provider !== providerPda || m.program_id !== PROGRAM_ID.toBase58()) problems.push('provider or program does not match the chain');
  // cf4c372: the payload's operator is its signer, and the signer is the owner or holds a live
  // PermSignProviderMetadata grant from it. The operator field alone proves nothing.
  const signer = typeof res.json.signer === 'string' ? res.json.signer : '';
  if (!signer || m.operator !== signer) problems.push('operator is not the signer');
  else {
    try {
      if (!(await signerAuthorized(p.owner, signer, PERM_SIGN_PROVIDER_METADATA, providerPda))) problems.push('signed by neither the owner nor an operator it allowed');
    } catch (err) {
      problems.push(`operator permission could not be checked (${(err as Error).message})`);
    }
  }
  const pin = m.api?.tls_sha256 ? String(m.api.tls_sha256).toLowerCase() : null;
  if (!pin || !res.certSha256 || pin !== res.certSha256.toLowerCase()) problems.push('TLS certificate does not match its pin');
  if (problems.length) throw new ProviderError(`Provider metadata rejected: ${problems.join('; ')}`, 'provider-metadata-invalid');
  return { origin, tlsSha256: pin as string };
}

export interface RosterEntry { node: string; live: boolean; probedAt: number }

export async function planRoster(providerPda: string, planPda: string): Promise<RosterEntry[]> {
  const api = await providerApi(providerPda);
  const res = await httpsRequest(`${api.origin}/v1/plans/${planPda}/nodes`, { timeoutMs: 8000, pinSha256: api.tlsSha256 });
  const nodes = (res.json as { nodes?: unknown[] } | null)?.nodes;
  if (res.status !== 200 || !Array.isArray(nodes)) throw new ProviderError(`Provider roster unavailable (HTTP ${res.status})`, 'provider-roster-failed');
  return nodes.map((n) => {
    const r = n as Record<string, unknown>;
    return { node: String(r.node), live: !!r.live, probedAt: Number(r.probed_at ?? 0) };
  });
}
