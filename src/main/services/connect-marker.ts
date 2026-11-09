// ─── A connect in progress, visible to other processes (DC1) ───
// The Cancel flag lives in the connecting process, so a Disconnect run from another process (a
// second CLI window, or the app while the CLI connects) found no session yet, said "No active
// session." and the connect then finished. The connecting process now leaves a marker in the
// shared data dir; a Disconnect elsewhere writes a stop request that connect() reads at each step.
import fs from 'node:fs';
import path from 'node:path';
import { log } from '../logger';

const MARKER = 'connect-in-progress.json';
const CANCEL = 'connect-cancel.json';
/** A marker older than this is left over from a crash (a connect takes minutes at most). */
export const MARKER_STALE_MS = 15 * 60_000;

export interface ConnectMarker { pid: number; startedAt: number; node: string }

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn('connect marker unreadable', { file: path.basename(file), err: (err as Error).message });
    return null;
  }
}

function remove(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch (err) {
    log.warn('connect marker not removed', { file: path.basename(file), err: (err as Error).message });
  }
}

/** True while a process with this id runs (EPERM = runs under another user). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function markConnecting(dir: string, node: string, pid = process.pid, now = Date.now()): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
    remove(path.join(dir, CANCEL)); // a stop asked of an earlier connect is not for this one
    fs.writeFileSync(path.join(dir, MARKER), JSON.stringify({ pid, startedAt: now, node } satisfies ConnectMarker));
  } catch (err) {
    log.warn('connect marker not written', { err: (err as Error).message });
  }
}

/** Drop our own marker (and a stop request aimed at us). Another process's marker is left alone. */
export function clearConnecting(dir: string, pid = process.pid): void {
  if (readJson<ConnectMarker>(path.join(dir, MARKER))?.pid === pid) remove(path.join(dir, MARKER));
  if (readJson<{ pid: number }>(path.join(dir, CANCEL))?.pid === pid) remove(path.join(dir, CANCEL));
}

/** A connect running in ANOTHER live process, or null. A stale or dead marker is removed. */
export function otherConnect(dir: string, pid = process.pid, now = Date.now(), alive = pidAlive): ConnectMarker | null {
  const m = readJson<ConnectMarker>(path.join(dir, MARKER));
  if (!m || typeof m.pid !== 'number' || m.pid === pid) return null;
  if (now - m.startedAt > MARKER_STALE_MS || !alive(m.pid)) {
    remove(path.join(dir, MARKER));
    return null;
  }
  return m;
}

export function requestCancel(dir: string, target: ConnectMarker, now = Date.now()): void {
  try {
    fs.writeFileSync(path.join(dir, CANCEL), JSON.stringify({ pid: target.pid, at: now }));
  } catch (err) {
    log.warn('connect stop request not written', { err: (err as Error).message });
  }
}

/** Another process asked this process's connect to stop. */
export function cancelRequested(dir: string, pid = process.pid): boolean {
  return readJson<{ pid: number }>(path.join(dir, CANCEL))?.pid === pid;
}

/** Resolves true once that connect's marker is gone, false after `ms`. */
export async function waitConnectEnded(dir: string, target: ConnectMarker, ms: number, everyMs = 500, alive = pidAlive): Promise<boolean> {
  const end = Date.now() + ms;
  for (;;) {
    const m = readJson<ConnectMarker>(path.join(dir, MARKER));
    if (!m || m.pid !== target.pid || !alive(target.pid)) return true;
    if (Date.now() >= end) return false;
    await new Promise((r) => setTimeout(r, everyMs));
  }
}
