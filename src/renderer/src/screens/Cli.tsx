// ─── CLI screen: every app function as a command, run inside the app ───
// Pattern from sentinel-node-manager-solana's CLI screen: command reference on
// the left (grouped, filterable, insert / copy / run), terminal on the right
// (history with ↑/↓). Commands come from src/cli/catalogue.ts — the same list
// as `devnet-dvpn help` and docs/CLI.md.
import { useMemo, useRef, useState, useEffect } from 'react';
import { create } from 'zustand';
import { call, useApp } from '../lib/store';
import { byPlatform, onAndroid } from '../lib/platform';
import { PageHeader } from '../components/ui';
import { CATALOGUE, GROUP_LABEL, type CliEntry, type CliGroup } from '../../../cli/catalogue';

interface Line { id: number; kind: 'input' | 'ok' | 'err' | 'info' | 'confirm'; text: string }
interface CliRun { ok: boolean; text: string; needsConfirm?: boolean; code?: number }

// Kept outside the screen so output and history survive switching screens.
const useTerm = create<{ lines: Line[]; history: string[]; push(l: Omit<Line, 'id'>): void; clear(): void; remember(cmd: string): void }>((set) => ({
  lines: [{ id: 0, kind: 'info', text: `Same commands as the devnet-dvpn CLI, run inside the app. Type help, or pick one ${byPlatform('on the left', 'above')}.` }],
  history: [],
  push: (l) => set((s) => ({ lines: [...s.lines.slice(-400), { ...l, id: Date.now() + Math.random() }] })),
  clear: () => set({ lines: [] }),
  remember: (cmd) => set((s) => ({ history: [...s.history.filter((h) => h !== cmd), cmd].slice(-100) })),
}));

const runnable = (e: CliEntry): boolean => !e.appBlocked && !/[<…]|--yes/.test(e.usage) && !e.usage.includes('key=value');

export function Cli() {
  const { lines, history, push, clear, remember } = useTerm();
  const toast = useApp((s) => s.toast);
  const [filter, setFilter] = useState('');
  const [input, setInput] = useState('');
  const [idx, setIdx] = useState(-1);
  const [running, setRunning] = useState(false);
  const outRef = useRef<HTMLDivElement | null>(null);
  const inRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => { outRef.current?.scrollTo({ top: outRef.current.scrollHeight }); }, [lines.length]);

  const groups = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const m = new Map<CliGroup, CliEntry[]>();
    for (const e of CATALOGUE) {
      if (q && !`${e.cmd} ${e.summary} ${GROUP_LABEL[e.group]}`.toLowerCase().includes(q)) continue;
      m.set(e.group, [...(m.get(e.group) ?? []), e]);
    }
    return m;
  }, [filter]);

  const run = async (raw: string): Promise<void> => {
    const line = raw.trim();
    if (!line || running) return;
    remember(line);
    setIdx(-1);
    if (line === 'clear' || line === 'cls') { clear(); return; }
    push({ kind: 'input', text: `$ ${line}` });
    setRunning(true);
    try {
      const r = await call<CliRun>(window.api.IPC.CLI_RUN, line, { quiet: true });
      if (r.text) push({ kind: r.needsConfirm ? 'confirm' : r.ok ? 'ok' : 'err', text: r.text });
      else if (r.ok) push({ kind: 'info', text: 'Done.' });
    } catch (err) {
      push({ kind: 'err', text: (err as Error).message });
    } finally {
      setRunning(false);
      inRef.current?.focus();
    }
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowUp' && history.length) {
      e.preventDefault();
      const n = idx === -1 ? history.length - 1 : Math.max(0, idx - 1);
      setIdx(n); setInput(history[n]);
    } else if (e.key === 'ArrowDown' && idx !== -1) {
      e.preventDefault();
      const n = idx + 1;
      if (n >= history.length) { setIdx(-1); setInput(''); } else { setIdx(n); setInput(history[n]); }
    }
  };

  const tone: Record<Line['kind'], string> = { input: 'text-accent-ink', ok: 'text-fg', err: 'text-bad', info: 'text-fg-muted', confirm: 'text-warn' };

  return (
    <div className="flex max-w-6xl flex-col md:h-[calc(100vh-150px)] md:min-h-[480px]">
      <PageHeader
        title="CLI"
        subtitle={byPlatform('Every app function as a command. The same commands work in PowerShell and in scripts.', 'Every app function as a command, run here on the phone.')}
        right={onAndroid() ? undefined : <button className="btn-ghost" onClick={async () => { try { await call(window.api.IPC.CLI_POWERSHELL); } catch (err) { console.warn('open powershell failed', err); } }}>Open in PowerShell</button>}
      />
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 pb-1 md:grid-cols-12">
        <div className="card flex max-h-[45vh] min-h-0 flex-col p-0 md:col-span-5 md:max-h-none">
          <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
            <div className="section-title whitespace-nowrap">Commands <span className="num ml-1 text-meta text-fg-muted">{CATALOGUE.length}</span></div>
            <input className="input h-8 max-w-[200px]" placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter commands" />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {[...groups.entries()].map(([g, list]) => (
              <div key={g}>
                <div className="sticky top-0 z-10 flex h-8 items-center border-b border-line bg-bg-card/95 px-4 text-label uppercase text-fg-muted backdrop-blur">{GROUP_LABEL[g]}</div>
                {list.map((e) => (
                  // Compact row: name + one-line summary; actions show on hover or keyboard focus.
                  <div key={e.cmd} className="group border-b border-line px-4 py-2 hover:bg-bg-hover">
                    <div className="flex min-h-8 items-center justify-between gap-2">
                      <code className="mono font-medium text-accent-ink">{e.cmd}</code>
                      <div className="flex items-center gap-1 opacity-60 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
                        {e.confirm && <span className="pill border-warn/40 text-warn" title="Signs or changes the computer: prints what it would do until you add --yes">--yes</span>}
                        {e.appBlocked
                          ? <span className="pill text-fg-muted" title={e.appBlocked}>CLI only</span>
                          : <>
                              <button className="btn-ghost btn-sm" onClick={() => { setInput(e.usage.replace(/ ?--yes/, '')); inRef.current?.focus(); }} title="Put it in the prompt">Insert</button>
                              {runnable(e) && <button className="btn-ghost btn-sm" disabled={running} onClick={() => void run(e.usage)} data-run={e.cmd}>Run</button>}
                            </>}
                        <button className="btn-ghost btn-sm" onClick={async () => { await window.api.invoke(window.api.IPC.COPY, `devnet-dvpn ${e.usage}`); toast('success', 'Copied.'); }} title="Copy for PowerShell">Copy</button>
                      </div>
                    </div>
                    <div className="truncate text-meta text-fg-dim" title={e.summary}>{e.summary}</div>
                    <pre className="mono mt-1 overflow-x-auto whitespace-pre text-fg-muted" tabIndex={0} aria-label={`Usage: ${e.cmd}`}>{e.usage}</pre>
                  </div>
                ))}
              </div>
            ))}
            {!groups.size && <div className="empty-line">No command matches “{filter}”.</div>}
          </div>
        </div>

        <div className="card flex min-h-[50vh] flex-col p-0 md:col-span-7 md:min-h-0">
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <div className="section-title">Terminal</div>
            <div className="flex items-center gap-2">
              <span className={`pill ${running ? 'border-warn/40 text-warn' : 'border-ok/40 text-ok'}`}><span className={`h-1.5 w-1.5 rounded-full ${running ? 'animate-pulse bg-warn' : 'bg-ok'}`} />{running ? 'Running…' : 'Ready'}</span>
              <button className="btn-ghost btn-sm" onClick={clear}>Clear</button>
            </div>
          </div>
          <div ref={outRef} className="min-h-0 flex-1 overflow-y-auto bg-bg-input px-4 py-3 font-mono text-meta" role="log" aria-live="polite">
            {lines.map((l) => <pre key={l.id} className={`my-1 whitespace-pre-wrap break-words ${tone[l.kind]}`}>{l.text}</pre>)}
          </div>
          <form className="flex items-center gap-2 border-t border-line px-4 py-3" onSubmit={(e) => { e.preventDefault(); const v = input; setInput(''); void run(v); }}>
            <span className="font-mono text-sm text-ok">$</span>
            <input
              ref={inRef}
              className="h-8 flex-1 bg-transparent font-mono text-sm text-fg outline-none placeholder:text-fg-muted focus-visible:outline-none"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKey}
              placeholder={running ? 'Running…' : 'Type a command, e.g. nodes list --online'}
              disabled={running}
              spellCheck={false}
              autoComplete="off"
              aria-label="Command"
              autoFocus
            />
            <button type="submit" className="btn-primary btn-sm" disabled={running || !input.trim()}>Run</button>
          </form>
        </div>
      </div>
    </div>
  );
}
