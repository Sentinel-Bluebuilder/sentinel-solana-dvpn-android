// ─── Settings draft: user edits made before the first read keep over the loaded settings ───
// The Split tunnelling / Kill switch pages read the VPN-service settings once on open. An edit made
// before that read answered was overwritten by it, and with no Apply bar until then the user's
// change was dropped silently (deba splitui 2026-10-29: include + 3 ranges, Apply showed "nothing
// changed", the session connected full tunnel).

type Settings = Record<string, unknown>;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Top-level keys whose value differs between two drafts (what one edit touched). */
export function changedKeys(before: Settings, after: Settings): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
}

/** Loaded settings with the touched keys taken from the draft (objects one level deep, so a
 *  changed split mode keeps the loaded split routes it did not touch). */
export function mergeLoaded<T extends Settings>(loaded: T, draft: Settings, touched: Iterable<string>): T {
  const out: Settings = { ...loaded };
  for (const k of touched) {
    if (!(k in draft)) continue;
    out[k] = isObj(loaded[k]) && isObj(draft[k]) ? { ...(loaded[k] as Settings), ...(draft[k] as Settings) } : draft[k];
  }
  return out as T;
}
