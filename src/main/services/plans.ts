// ─── Plans + subscriptions service (F10) ───
// Subscribing pays the plan price up front; cancelling refunds nothing (UI says
// so before purchase). Expected terms ride the instruction so a price change
// between view and sign fails on chain (PlanTermsChanged) instead of overcharging.
import type { PlanRecord, Result, SubscriptionRecord } from '../../shared/types';
import { listPlans, markProviderAnswering, planRoster, providerApi, subscriptionsOf, type ProviderProbeEntry, type RosterEntry } from '../../core/plans/plans';
import { openSubscription, closeSubscription } from '../../core/chain/builders';
import { pda } from '../../core/chain/program';
import { signAndSend } from '../../core/app/signer';
import { describeInstructionError } from '../../core/chain/errors';
import { ownerAddress, ownerSigner } from '../wallet/vault';
import { patch } from '../app-state';
import { log } from '../logger';

let plans: PlanRecord[] = [];

const PROBE_MS = 4_000;
const probeCache = new Map<string, ProviderProbeEntry>();

/** W2: a provider is "answering" when its signed metadata verifies within a few seconds. */
async function providerAnswers(provider: string): Promise<boolean> {
  try {
    await Promise.race([
      providerApi(provider, { timeoutMs: PROBE_MS }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('probe timed out')), PROBE_MS + 1_000).unref?.()),
    ]);
    return true;
  } catch (err) {
    log.info('plan provider not answering', { provider, err: (err as Error).message.split('\n')[0] });
    return false;
  }
}

export async function refreshPlans(): Promise<PlanRecord[]> {
  plans = await markProviderAnswering(await listPlans(), providerAnswers, probeCache);
  return plans;
}

export const cachedPlans = (): PlanRecord[] => plans;

export async function refreshSubscriptions(): Promise<SubscriptionRecord[]> {
  const owner = ownerAddress();
  if (!owner) return [];
  try {
    const subs = await subscriptionsOf(owner);
    patch({ subscriptions: subs });
    return subs;
  } catch (err) {
    log.warn('subscriptions refresh failed', { err: (err as Error).message });
    return [];
  }
}

/** W2: an unreachable provider and a TIMEOUT read the same to the user (exported for tests). */
export function rosterErrorText(msg: string): string {
  if (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|timeout|timed out|fetch failed|socket hang up/i.test(msg)) {
    return 'This plan\'s provider is not answering right now, so its server list can\'t be shown. Try again later or pick another plan.';
  }
  return `Could not read this plan's server list: ${msg.split('\n')[0]}`;
}

/** The provider's own API lists the plan's servers; an offline provider is a normal state, not a crash. */
export async function roster(provider: string, plan: string): Promise<RosterEntry[]> {
  try {
    return await planRoster(provider, plan);
  } catch (err) {
    const msg = (err as Error).message;
    log.warn('plan roster failed', { plan, err: msg });
    throw new Error(rosterErrorText(msg));
  }
}

export async function subscribe(req: { plan: string; confirmed: true }): Promise<Result<{ signature: string; subscription: string }>> {
  if (req.confirmed !== true) return { ok: false, error: 'Confirm the price first.', code: 'not-confirmed' };
  const owner = ownerAddress();
  if (!owner) return { ok: false, error: 'Set up a wallet first.' };
  const p = (plans.length ? plans : await refreshPlans()).find((x) => x.address === req.plan);
  if (!p) return { ok: false, error: 'That plan is not listed any more.', code: 'plan-gone' };
  if (!p.providerListed) return { ok: false, error: 'This plan\'s provider is not active.', code: 'provider-inactive' };
  try {
    const ix = await openSubscription({ owner, plan: p.address, provider: p.provider, terms: { price: p.price, durationSeconds: p.durationSeconds, dataCapGb: p.dataCapGb, maxConnections: p.maxConnections } });
    const r = await signAndSend(ownerSigner(), [ix], 'open_subscription');
    await refreshSubscriptions();
    return { ok: true, data: { signature: r.signature, subscription: pda.subscription(owner, p.address).toBase58() } };
  } catch (err) {
    return { ok: false, error: describeInstructionError(err) ?? (err as Error).message, code: 'subscribe-failed' };
  }
}

/** Close an EXPIRED subscription to recover its rent (no refund of the price). */
export async function closeSub(subscription: string): Promise<Result<string>> {
  const owner = ownerAddress();
  if (!owner) return { ok: false, error: 'Set up a wallet first.' };
  const s = (await refreshSubscriptions()).find((x) => x.address === subscription);
  if (!s) return { ok: false, error: 'Subscription not found.' };
  try {
    const r = await signAndSend(ownerSigner(), [await closeSubscription({ owner, subscription, rentPayer: s.rentPayer })], 'close_subscription');
    await refreshSubscriptions();
    return { ok: true, data: r.signature };
  } catch (err) {
    return { ok: false, error: describeInstructionError(err) ?? (err as Error).message, code: 'close-sub-failed' };
  }
}
