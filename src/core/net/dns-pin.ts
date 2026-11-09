// ─── Pinned addresses for the RPC hosts (gap #67) ───
// While the kill switch holds the block with no tunnel up (a server switch, "Always" after a
// restart), DNS is blocked but the RPC endpoints' addresses are let through: dvpnd permits them
// and dials them by IP (its rpcpin). The app has to do the same, or every chain call fails with
// "fetch failed" and the user can never reconnect through the block (test-host kesw18).
// So: lookups for the RPC hosts answer from the last good result at once and refresh it in the
// background; every other host goes to the normal resolver untouched.
import dns from 'node:dns';
import fs from 'node:fs';

type Answer = { address: string; family: number };
type Cb = (err: NodeJS.ErrnoException | null, address?: string | Answer[], family?: number) => void;
type LookupFn = (hostname: string, options: dns.LookupAllOptions, cb: (err: NodeJS.ErrnoException | null, addrs: dns.LookupAddress[]) => void) => void;

const REFRESH_MS = 5 * 60_000;
const hosts = new Set<string>();
const pinned = new Map<string, { addrs: Answer[]; at: number; disk?: boolean }>();
let original: LookupFn | null = null;
let pinFile: string | null = null;
/** How long a live lookup gets before an address saved by an EARLIER process is used (the block drops UDP 53 silently). */
const DISK_LIVE_WAIT_MS = 1500;

/** The RPC hosts to pin (called whenever the pool changes). */
export function pinHosts(urls: string[]): void {
  hosts.clear();
  for (const u of urls) {
    try {
      const h = new URL(u).hostname;
      if (h && !/^[\d.]+$/.test(h) && !h.startsWith('[')) hosts.add(h.toLowerCase());
    } catch (err) {
      console.warn(`[dns-pin] skipped ${(err as Error).message}`);
    }
  }
}

function answer(addrs: Answer[], opts: { all?: boolean; family?: number | string }, cb: Cb): void {
  const fam = opts.family === 'IPv4' ? 4 : opts.family === 'IPv6' ? 6 : Number(opts.family) || 0;
  const list = fam ? addrs.filter((a) => a.family === fam) : addrs;
  if (!list.length) {
    cb(Object.assign(new Error(`no pinned address of family ${fam}`), { code: 'ENOTFOUND' }));
    return;
  }
  if (opts.all) cb(null, list);
  else cb(null, list[0].address, list[0].family);
}

// post-release F-C4-1: a V2Ray/Xray session has no tunnel interface, so a held kill switch blocks the
// host's DNS while dvpnd still admits the RPC addresses by IP. The pin above lived in one process only:
// every CLI command (wallet show, channels fund) and an app started under the block began with an empty
// pin and failed. The last good answers are now saved next to the settings and read by the next process.
// A saved address only ever lets a call TRY an IP; the firewall decides, so a stale one fails closed.
function savePins(): void {
  if (!pinFile) return;
  try {
    const out: Record<string, Answer[]> = {};
    for (const [h, v] of pinned) if (hosts.has(h)) out[h] = v.addrs;
    fs.writeFileSync(`${pinFile}.tmp`, JSON.stringify(out), { mode: 0o600 });
    fs.renameSync(`${pinFile}.tmp`, pinFile);
  } catch (err) {
    console.warn(`[dns-pin] could not save ${pinFile}: ${(err as Error).message}`);
  }
}

/** Where the last good RPC addresses are kept between processes (the app's data dir). Loads what is there. */
export function setPinFile(file: string): void {
  pinFile = file;
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`[dns-pin] could not read ${file}: ${(err as Error).message}`);
    return;
  }
  try {
    const saved = JSON.parse(raw) as Record<string, Answer[]>;
    for (const [h, addrs] of Object.entries(saved)) {
      const ok = Array.isArray(addrs) ? addrs.filter((a) => a && typeof a.address === 'string' && (a.family === 4 || a.family === 6)) : [];
      if (ok.length && !pinned.has(h)) pinned.set(h, { addrs: ok, at: 0, disk: true });
    }
  } catch (err) {
    console.warn(`[dns-pin] ignored unreadable ${file}: ${(err as Error).message}`);
  }
}

// Q0390 (Azure India, TLX2 10-30): the RPC host resolves by location. Through the tunnel (a US node) the
// app pinned 208.115.212.49; the kill switch allows only what dvpnd resolved on the direct path
// (74.63.203.93). A held block between servers then dropped every app call. So keep the recent distinct
// answers, newest first, and hand them all out: Node's connect tries each in turn (autoSelectFamily, ~250 ms
// per try), so the one the block admits connects and the others cost a moment.
export const PIN_KEEP = 4;

/** Newest answers first, then earlier ones not in them, at most PIN_KEEP. Exported for tests. */
export function mergeAnswers(fresh: Answer[], earlier: Answer[] = []): Answer[] {
  const seen = new Set(fresh.map((a) => a.address));
  return [...fresh, ...earlier.filter((a) => !seen.has(a.address))].slice(0, PIN_KEEP);
}

function resolveAll(host: string, done: (err: NodeJS.ErrnoException | null, addrs?: Answer[]) => void): void {
  (original as LookupFn)(host, { all: true }, (err, addrs) => {
    if (err || !addrs?.length) { done(err ?? Object.assign(new Error('no address'), { code: 'ENOTFOUND' })); return; }
    const list = mergeAnswers(addrs.map((a) => ({ address: a.address, family: a.family })), pinned.get(host)?.addrs);
    const before = JSON.stringify(pinned.get(host)?.addrs);
    pinned.set(host, { addrs: list, at: Date.now() });
    if (before !== JSON.stringify(list)) savePins();
    done(null, list);
  });
}

/** Wrap dns.lookup once (net and fetch read dns.lookup at call time). */
export function installDnsPin(): void {
  if (original) return;
  original = dns.lookup as unknown as LookupFn;
  const wrapped = (hostname: string, a?: unknown, b?: unknown): void => {
    const cb = (typeof a === 'function' ? a : b) as Cb;
    const opts = (typeof a === 'number' ? { family: a } : typeof a === 'object' && a ? a : {}) as { all?: boolean; family?: number | string };
    const host = String(hostname).toLowerCase();
    if (!hosts.has(host)) { (original as unknown as (...x: unknown[]) => void)(hostname, ...(typeof a === 'function' ? [a] : [a, b])); return; }
    const hit = pinned.get(host);
    if (hit?.disk) {
      // Saved by an earlier process: a live answer wins; the saved one serves only if DNS is blocked or slow.
      let settled = false;
      const finish = (addrs: Answer[]): void => { if (!settled) { settled = true; answer(addrs, opts, cb); } };
      const timer = setTimeout(() => finish(hit.addrs), DISK_LIVE_WAIT_MS);
      resolveAll(host, (err, list) => {
        clearTimeout(timer);
        if (err || !list) { if (!settled) console.warn(`[dns-pin] ${host}: ${err?.code ?? 'no answer'}; using the saved addresses`); finish(hit.addrs); } else finish(list);
      });
      return;
    }
    if (hit) {
      answer(hit.addrs, opts, cb);
      if (Date.now() - hit.at > REFRESH_MS) {
        hit.at = Date.now(); // one refresh at a time
        resolveAll(host, (err) => { if (err) console.warn(`[dns-pin] refresh ${host}: ${err.code ?? err.message}; keeping the pinned addresses`); });
      }
      return;
    }
    resolveAll(host, (err, list) => { if (err || !list) cb(err); else answer(list, opts, cb); });
  };
  (dns as unknown as { lookup: unknown }).lookup = wrapped;
}

/** Tests only: seed a pinned answer. */
export function _seedPin(host: string, addrs: Answer[]): void { pinned.set(host.toLowerCase(), { addrs, at: Date.now() }); }

/** Tests only. */
export function _resetDnsPin(): void {
  if (original) (dns as unknown as { lookup: unknown }).lookup = original;
  original = null;
  pinFile = null;
  hosts.clear();
  pinned.clear();
}
