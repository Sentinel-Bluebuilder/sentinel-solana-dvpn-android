// ─── Small shared UI pieces ───
import { useId, useState, type InputHTMLAttributes, type ReactNode } from 'react';
import { useApp } from '../lib/store';
import { short } from '../../../shared/format';

/** Country flag, 4:3, `size` = height in px (24 x 18 by default, like the flags in leading VPN apps). */
export function Flag({ code, size = 18, className = '' }: { code: string; size?: number; className?: string }) {
  const c = (code || '').toLowerCase();
  const box = { width: Math.round(size * 4 / 3), height: size };
  if (!/^[a-z]{2}$/.test(c)) return <span className={`inline-block shrink-0 rounded-[3px] bg-bg-hover ${className}`} style={box} role="img" aria-label="unknown country" />;
  return <span className={`fi fi-${c} shrink-0 rounded-[3px] bg-cover shadow-[0_0_0_1px_rgba(127,127,127,0.25)] ${className}`} style={{ ...box, backgroundSize: 'cover' }} role="img" aria-label={c.toUpperCase()} />;
}

/** Solana mark (three slanted bars), drawn here so nothing is fetched. */
export function SolanaMark({ className = 'h-3.5 w-3.5' }: { className?: string }) {
  // One gradient id per instance: a shared id breaks every mark once the first one unmounts.
  const id = `solg${useId().replace(/:/g, '')}`;
  return (
    <svg viewBox="0 0 397 311" className={className} aria-hidden>
      <defs>
        <linearGradient id={id} x1="360" y1="-37" x2="141" y2="383" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#14F195" /><stop offset="1" stopColor="#9945FF" />
        </linearGradient>
      </defs>
      <path fill={`url(#${id})`} d="M64.6 237.9a13 13 0 0 1 9.2-3.8h317.4c5.8 0 8.7 7 4.6 11.1l-62.7 62.7a13 13 0 0 1-9.2 3.8H6.5c-5.8 0-8.7-7-4.6-11.1l62.7-62.7zM64.6 3.8A13.4 13.4 0 0 1 73.8 0h317.4c5.8 0 8.7 7 4.6 11.1l-62.7 62.7a13 13 0 0 1-9.2 3.8H6.5c-5.8 0-8.7-7-4.6-11.1L64.6 3.8zM333.1 120.1a13 13 0 0 0-9.2-3.8H6.5c-5.8 0-8.7 7-4.6 11.1l62.7 62.7a13 13 0 0 0 9.2 3.8h317.4c5.8 0 8.7-7 4.6-11.1l-62.7-62.7z" />
    </svg>
  );
}

/** App mark: the Solana mark on a dark tile (owner 2026-10-22), same in both themes, like the app icon. */
export function AppMark({ size = 40 }: { size?: number }) {
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center bg-sol-ink shadow-[inset_0_0_0_1px_rgba(255,255,255,0.14),0_4px_14px_rgb(var(--sol-purple)/0.28)]"
      style={{ width: size, height: size, borderRadius: Math.round(size * 0.26) }}
      aria-hidden
    >
      <span style={{ width: size * 0.56, height: size * 0.44 }} className="inline-flex"><SolanaMark className="h-full w-full" /></span>
    </span>
  );
}

export function DevnetBadge() {
  return <span className="devnet-badge"><span className="h-1.5 w-1.5 rounded-full bg-warn" />Devnet · test tokens</span>;
}

/** Page head: title + one short line on the left, page actions on the right, one row. */
export function PageHeader({ title, subtitle, right }: { title: string; subtitle?: string; right?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
      <div className="min-w-0">
        <h1 className="font-display text-title">{title}</h1>
        {subtitle && <p className="prose-cap mt-1 text-sm text-fg-dim">{subtitle}</p>}
      </div>
      {right && <div className="flex shrink-0 items-center gap-2">{right}</div>}
    </div>
  );
}

/** A section: quiet title left, its actions right. */
export function Section({ title, right, children, className = '' }: { title: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`section ${className}`}>
      <div className="section-head">
        <h2 className="section-title">{title}</h2>
        {right && <div className="flex items-center gap-2">{right}</div>}
      </div>
      {children}
    </section>
  );
}

/** Numbers that belong together sit in one strip, split by hairlines (not one card each). */
export function StatStrip({ children }: { children: ReactNode }) {
  return <div className="stat-strip">{children}</div>;
}

/** One cell of a StatStrip; also usable alone as a card (Stat). */
export function StatCell({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="stat-cell">
      <div className="label">{label}</div>
      {/* An amount is never cut short: on a narrow tile the unit wraps to the next line. */}
      <div className="num font-display text-value [overflow-wrap:anywhere]">{value}</div>
      {hint && <div className="mt-1 text-meta text-fg-muted">{hint}</div>}
    </div>
  );
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="card">
      <div className="label">{label}</div>
      <div className="num font-display text-value">{value}</div>
      {hint && <div className="mt-1 text-meta text-fg-muted">{hint}</div>}
    </div>
  );
}

/** On/off switch. A real checkbox underneath, so labels, keyboard, tests and hooks keep working. */
export function Switch({ checked, onChange, disabled, label, ...rest }: {
  checked: boolean; onChange: (on: boolean) => void; disabled?: boolean; label?: string;
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'checked' | 'type'>) {
  return (
    <span className="relative inline-flex h-6 w-10 shrink-0 items-center">
      <input
        type="checkbox"
        role="switch"
        aria-label={label}
        className="peer absolute inset-0 z-10 m-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        {...rest}
      />
      <span className="absolute inset-0 rounded-full border border-line-strong bg-bg-hover transition-colors peer-checked:border-transparent peer-checked:bg-sol peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[rgb(var(--sol-purple))] peer-disabled:opacity-45" aria-hidden />
      <span className="pointer-events-none absolute left-1 h-4 w-4 rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.35)] transition-transform peer-checked:translate-x-4" aria-hidden />
    </span>
  );
}

/** A shortened address that copies the FULL address on click (lists and tables, where a Copy button per row is noise). */
export function CopyAddr({ text, chars }: { text: string; chars?: number }) {
  const [done, setDone] = useState(false);
  if (!text) return <span className="mono">—</span>;
  return (
    <button
      type="button"
      className="mono rounded px-0.5 hover:bg-bg-hover hover:text-fg focus-visible:outline"
      title={done ? 'Copied' : `Copy full address ${text}`}
      aria-label={`Copy address ${text}`}
      data-copy-addr={text}
      onClick={async (e) => {
        e.stopPropagation();
        await window.api.invoke(window.api.IPC.COPY, text);
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
    >
      {done ? 'Copied' : short(text, chars)}
    </button>
  );
}

export function Copy({ text, label }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="btn-ghost btn-sm"
      onClick={async () => {
        await window.api.invoke(window.api.IPC.COPY, text);
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
    >
      {done ? 'Copied' : label ?? 'Copy'}
    </button>
  );
}

export function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }, (_, i) => <div key={i} className="h-14 animate-pulse rounded-lg border border-line bg-bg-card" style={{ animationDelay: `${i * 90}ms` }} />)}
    </div>
  );
}

export function Banner({ kind, children, action }: { kind: 'info' | 'warn' | 'error'; children: ReactNode; action?: ReactNode }) {
  const tone = kind === 'error' ? 'border-bad/40 bg-bad-soft' : kind === 'warn' ? 'border-warn/35 bg-warn-soft' : 'border-accent/35 bg-accent-soft';
  const dot = kind === 'error' ? 'bg-bad' : kind === 'warn' ? 'bg-warn' : 'bg-accent';
  return (
    <div className={`mb-4 flex items-center justify-between gap-4 rounded-lg border px-4 py-3 text-sm ${tone}`} role={kind === 'error' ? 'alert' : 'status'}>
      <div className="flex items-baseline gap-2"><span className={`h-1.5 w-1.5 shrink-0 -translate-y-px self-center rounded-full ${dot}`} />{children}</div>
      {action}
    </div>
  );
}

/** Confirmation sheet for every spend action: shows exactly what will happen first. */
export function ConfirmModal({ title, lines, confirmLabel, danger, onConfirm, onClose }: {
  title: string; lines: ReactNode[]; confirmLabel: string; danger?: boolean; onConfirm: () => Promise<void> | void; onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/65 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label={title}>
      <div className="card-raised w-full max-w-md rounded-xl p-6">
        <h2 className="mb-3 font-display text-section">{title}</h2>
        <ul className="mb-5 space-y-2 text-sm text-fg-dim">{lines.map((l, i) => <li key={i}>{l}</li>)}</ul>
        <div className="flex justify-end gap-2">
          <button className="btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button
            className={danger ? 'btn-danger' : 'btn-primary'}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try { await onConfirm(); onClose(); } catch (err) { console.warn('confirm action failed', err); setBusy(false); }
            }}
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function Toasts() {
  const { toasts, dismiss } = useApp();
  return (
    <div className="fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2" aria-live="polite">
      {toasts.map((t) => (
        <button
          key={t.id}
          data-toast={t.kind}
          onClick={() => dismiss(t.id)}
          className={`rounded-lg border px-4 py-3 text-left text-sm shadow-card backdrop-blur ${t.kind === 'error' ? 'border-bad/50 bg-bad-soft' : t.kind === 'success' ? 'border-ok/50 bg-ok-soft' : t.kind === 'warn' ? 'border-warn/50 bg-warn-soft' : 'border-line bg-[var(--glass)]'}`}
        >
          {t.message}
        </button>
      ))}
    </div>
  );
}
