// ─── Local session history + export (F13.4, F13.5) ───
import type { HistoryEntry, LiveSession } from '../../shared/types';
import { readJson, writeJson } from '../store';

const FILE = 'history.json';
const MAX = 1000;

export function listHistory(): HistoryEntry[] {
  return readJson<HistoryEntry[]>(FILE, []);
}

function save(list: HistoryEntry[]): void {
  writeJson(FILE, list.slice(0, MAX));
}

export function recordStart(s: LiveSession, country = ''): void {
  const list = listHistory().filter((h) => h.id !== s.id);
  list.unshift({
    id: s.id, node: s.node, country, service: s.service, startedAt: s.startedAt ?? Date.now(), endedAt: null,
    rxBytes: s.rxBytes, txBytes: s.txBytes, spent: s.spent, channel: s.channel, closeReason: null,
  });
  save(list);
}

export function recordEnd(s: LiveSession, reason: string): void {
  const list = listHistory();
  const h = list.find((x) => x.id === s.id);
  if (!h) return;
  Object.assign(h, { endedAt: Date.now(), rxBytes: s.rxBytes, txBytes: s.txBytes, spent: s.spent, closeReason: reason || null });
  save(list);
}

export function historyCsv(list = listHistory()): string {
  const cols: Array<keyof HistoryEntry> = ['id', 'node', 'country', 'service', 'startedAt', 'endedAt', 'rxBytes', 'txBytes', 'spent', 'channel', 'closeReason'];
  const esc = (v: unknown): string => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...list.map((h) => cols.map((c) => esc(h[c])).join(','))].join('\n') + '\n';
}
