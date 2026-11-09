// ─── Background refresh cadences (F5) — same setting as `poll set` in the CLI ───
import { useEffect, useState } from 'react';
import { call, useApp } from '../lib/store';
import { POLL_JOBS, POLL_JOB_NAMES, DEFAULT_POLL, validPoll, type PollJob } from '../../../shared/poll';
import type { AppSettings } from '../../../shared/types';

export function PollSettings({ settings }: { settings: AppSettings }) {
  const { setSettings, toast } = useApp();
  const [text, setText] = useState<Record<string, string>>({});
  useEffect(() => { setText(Object.fromEntries(POLL_JOB_NAMES.map((k) => [k, String(settings.poll[k])]))); }, [settings.poll]);

  const save = async (job: PollJob): Promise<void> => {
    const n = validPoll(job, text[job]);
    const j = POLL_JOBS[job];
    if (n === null) {
      toast('warn', `${j.label}: use a whole number of seconds from ${j.min} to ${j.max}.`);
      setText((t) => ({ ...t, [job]: String(settings.poll[job]) }));
      return;
    }
    if (n === settings.poll[job]) return;
    setSettings(await call<AppSettings>(window.api.IPC.SETTINGS_SET, { poll: { ...settings.poll, [job]: n } }));
  };

  return (
    <div className="card overflow-hidden p-0">
      <p className="prose-cap border-b border-line px-4 py-3 text-meta text-fg-muted">Background refresh, in seconds. Shorter is fresher but sends more RPC requests (public devnet RPCs rate-limit). Most jobs pause while the window is hidden.</p>
      {POLL_JOB_NAMES.map((k) => (
        <div key={k} className="flex h-12 items-center justify-between gap-6 border-b border-line px-4">
          <div className="text-sm">{POLL_JOBS[k].label}<span className="num ml-2 text-meta text-fg-muted">{POLL_JOBS[k].min}–{POLL_JOBS[k].max} s, default {POLL_JOBS[k].def}</span></div>
          <input
            className="input num w-24 text-right"
            inputMode="numeric"
            value={text[k] ?? ''}
            onChange={(e) => setText((t) => ({ ...t, [k]: e.target.value.replace(/\D/g, '') }))}
            onBlur={() => void save(k)}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            aria-label={`${POLL_JOBS[k].label}, seconds`}
          />
        </div>
      ))}
      <div className="flex justify-end bg-bg-raised/40 px-4 py-3">
        <button className="btn-ghost" onClick={async () => { setSettings(await call<AppSettings>(window.api.IPC.SETTINGS_SET, { poll: DEFAULT_POLL })); toast('success', 'Refresh cadences back to defaults.'); }}>Reset to defaults</button>
      </div>
    </div>
  );
}
