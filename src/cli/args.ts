// ─── Tiny argv parser: positionals + --flag value / --flag / --flag=value ───
export interface Args {
  _: string[];
  flags: Record<string, string | true>;
}

const BOOLEAN = new Set(['json', 'yes', 'online', 'no-probe', 'follow', 'help', 'all', 'fresh', 'compare']);

export function parseArgs(argv: string[]): Args {
  const out: Args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { out._.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) { out.flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
      const name = a.slice(2);
      const next = argv[i + 1];
      if (BOOLEAN.has(name) || next === undefined || next.startsWith('--')) out.flags[name] = true;
      else { out.flags[name] = next; i++; }
    } else if (a === '-y') out.flags.yes = true;
    else out._.push(a);
  }
  return out;
}

export function str(a: Args, name: string, fallback?: string): string | undefined {
  const v = a.flags[name];
  return typeof v === 'string' ? v : fallback;
}

/** A whole number in [min, max]; anything else (0, -5, 1.5, 1e3, '１') is a usage error, never a fallback (linux-app 46754684). */
export function whole(a: Args, name: string, fallback: number, min: number, max: number): number {
  const v = str(a, name);
  if (v === undefined) return fallback;
  if (!/^\d{1,9}$/.test(v) || Number(v) < min || Number(v) > max) throw new UsageError(`--${name} must be a whole number from ${min} to ${max}`);
  return Number(v);
}

export const flag = (a: Args, name: string): boolean => a.flags[name] === true || a.flags[name] === 'true';

export class UsageError extends Error {}
