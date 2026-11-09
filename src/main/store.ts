// ─── JSON files under userData, atomic writes (ARCHITECTURE "Data at rest") ───
import fs from 'node:fs';
import path from 'node:path';
import { log } from './logger';

let root: string | null = null;

export function initStore(dir: string): void {
  root = dir;
  fs.mkdirSync(dir, { recursive: true });
}

export function storePath(name: string): string {
  if (!root) throw new Error('store not initialised'); // copy:internal
  return path.join(root, name);
}

export function readJson<T>(name: string, fallback: T): T {
  const p = storePath(name);
  try {
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, 'utf8')) as T;
  } catch (err) {
    log.warn(`store: ${name} unreadable, using defaults`, { err: (err as Error).message });
    return fallback;
  }
}

let tmpSeq = 0;

// Windows refuses a rename onto a file another process is replacing that instant (EPERM/EACCES/
// EBUSY); it clears within milliseconds. Linux/Android rename is atomic and never hits this.
const sleepMs = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
function renameRetrying(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= 20 || !(code === 'EPERM' || code === 'EACCES' || code === 'EBUSY')) throw err;
      sleepMs(5 + attempt * 5);
    }
  }
}

export function writeJson(name: string, value: unknown): void {
  const p = storePath(name);
  // A tmp name of its own per process and write: the app and the CLI share this folder, and with
  // one shared "<file>.tmp" one process renamed the other's file away, so its rename threw ENOENT
  // (a node-test disconnect failed that way and left the session up).
  const tmp = `${p}.${process.pid}.${++tmpSeq}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
    renameRetrying(tmp, p);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch (cleanupErr) {
      log.warn(`store: could not remove ${path.basename(tmp)}`, { err: (cleanupErr as Error).message });
    }
    throw err;
  }
}
