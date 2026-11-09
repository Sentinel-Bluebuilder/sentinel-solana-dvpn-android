// ─── Diagnostics (F4, F14, F19) ───
import { useEffect, useState } from 'react';
import { call } from '../lib/store';
import { byPlatform } from '../lib/platform';
import { Copy, PageHeader, Section, StatCell, StatStrip } from '../components/ui';
import type { AppSnapshot } from '../../../shared/types';
import { protocolLabel } from '../../../shared/protocols';
import { InstallServiceButton } from '../components/InstallServiceButton';

import type { RpcState } from '../../../core/chain/rpc';

interface DoctorRow { name: string; ok: boolean; level: 'ok' | 'warn' | 'fail'; detail: string }
interface DriverRow { name: string; found: string; status: string; detail: string }
interface DriversView { supported: boolean; live: { ok: boolean; rebootRequired: boolean; deps: DriverRow[] } | null; installer: { at: string } | null; error: string | null }

const DRIVER_NAMES: Record<string, string> = {
  wireguard: 'WireGuard', amneziawg: 'AmneziaWG', openvpn: 'OpenVPN', 'openvpn-wintun': 'OpenVPN Wintun adapter',
  'openvpn-dco': 'OpenVPN DCO adapter', windows: 'Windows (64-bit)', 'deps.json': 'Bundled driver list',
  dvpnd: 'VPN engine (dvpnd)', v2ray: 'V2Ray', xray: 'Xray', hysteria2: 'Hysteria2',
};
const DRIVER_COPY: Record<string, string> = {
  present: 'Installed', installed: 'Installed', upgraded: 'Updated', missing: 'Not installed',
  failed: 'Could not install', incompatible: 'Wrong version',
};

const CHECK_NAMES: Record<string, string> = {
  kill_switch: 'Kill switch state', build: 'Service build', rpc: 'Solana RPC', mint: 'Token mint', clock: 'System clock',
  key: 'Device key', grant: 'Spending permission', mandate: 'Spending permission', privileges: 'Service privileges', dns_backend: 'DNS control', kill_switch_backend: 'Firewall control',
  clock_skew: 'System clock', dns_servers: 'DNS servers answer',
};

function checkName(n: string): string {
  if (CHECK_NAMES[n]) return CHECK_NAMES[n];
  const m = /^service_(binaries|adapter)_(.+)$/.exec(n);
  if (m) return `${protocolLabel(m[2])} ${m[1] === 'binaries' ? 'program' : 'adapter'}`;
  // Unknown names from a newer service: sentence case like the rest ("clock skew" → "Clock skew").
  const s = n.replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function Diagnostics({ snap }: { snap: AppSnapshot }) {
  const [doctor, setDoctor] = useState<DoctorRow[] | null>(null);
  const [rpc, setRpc] = useState<RpcState | null>(null);
  const [ip, setIp] = useState<string>('');
  const [speed, setSpeed] = useState<string>('');
  const [log, setLog] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (name: string, fn: () => Promise<void>): Promise<void> => {
    setBusy(name);
    try { await fn(); } catch (err) { console.warn(`${name} failed`, err); } finally { setBusy(null); }
  };
  const loadDoctor = (): Promise<void> => run('doctor', async () => setDoctor(await call<DoctorRow[]>(window.api.IPC.DAEMON_DOCTOR)));
  const loadRpc = (): Promise<void> => run('rpc', async () => setRpc(await call<RpcState>(window.api.IPC.RPC_STATE)));
  const [drivers, setDrivers] = useState<DriversView | null>(null);
  const [driverMsg, setDriverMsg] = useState('');
  const loadDrivers = (): Promise<void> => run('drivers', async () => setDrivers(await call<DriversView>(window.api.IPC.DRIVERS_STATUS)));
  const repair = (): Promise<void> => run('repair', async () => {
    setDriverMsg(byPlatform('Waiting for the Windows permission prompt…', 'Re-linking the bundled programs…'));
    const r = await call<{ ok: boolean; error?: string; view: DriversView }>(window.api.IPC.DRIVERS_REPAIR);
    setDrivers(r.view);
    setDriverMsg(r.ok ? (r.view.live?.rebootRequired ? 'Drivers installed. Restart Windows to finish.' : byPlatform('All VPN drivers are ready.', 'All protocol programs are ready.')) : r.error ?? 'Repair did not finish.');
    // Q0313: the repair's own report can be the check from before it ran, which kept "Repair
    // drivers" on screen for minutes after a good repair. A good repair re-reads the drivers now.
    if (r.ok) setDrivers(await call<DriversView>(window.api.IPC.DRIVERS_STATUS, undefined, { quiet: true }));
    void loadDoctor();
  });
  useEffect(() => { void loadDoctor(); void loadRpc(); void loadDrivers(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const d = snap.daemon;
  return (
    <div>
      <PageHeader title="Diagnostics" subtitle="Everything here is read-only except Restore network." />
      <StatStrip>
        <StatCell label="VPN service" value={d.reachable ? 'Running' : 'Not reachable'} hint={d.version ?? d.error ?? undefined} />
        <StatCell label="Network" value={d.networkOk === false ? 'Mismatch' : d.networkOk ? 'Solana devnet' : '—'} />
        <StatCell label="Solana RPC slot" value={rpc?.slot ? rpc.slot : '—'} hint={rpc ? `${rpc.serving ?? 'none'}${rpc.latencyMs != null ? ` · ${rpc.latencyMs} ms` : ''}` : undefined} />
      </StatStrip>

      {/* Wide windows: service and drivers left, live checks and the log right. */}
      <div className="grid gap-x-6 xl:grid-cols-2">
      <div>
      <Section title="Service check" right={<button className="btn-ghost btn-sm" disabled={busy === 'doctor'} onClick={() => void loadDoctor()}>Run again</button>}>
      <div className="card">
        {!d.reachable && <div className="mb-3 flex items-center gap-3 text-sm" data-service-missing><span className="mr-auto text-bad">{byPlatform('The VPN service is not answering. If it was removed, install it again (one administrator prompt).', 'The VPN service is not answering. Start it again; it runs inside this app.')}</span><InstallServiceButton /></div>}
        {doctor?.some((r) => r.level === 'warn') && <p className="mb-2 text-meta text-fg-muted">Items marked ! are advisory: a protocol works only once its program is installed.</p>}
        {!doctor ? <p className="text-sm text-fg-dim">Checking…</p> : doctor.map((r) => (
          <div key={r.name} data-check={r.name} className="grid grid-cols-[1.25rem_8rem_1fr] gap-2 sm:grid-cols-[1.25rem_12rem_1fr] border-b border-line py-2 text-sm last:border-0">
            <span className={r.level === 'ok' ? 'text-ok' : r.level === 'warn' ? 'text-warn' : 'text-bad'} aria-label={r.level}>{r.level === 'ok' ? '✓' : r.level === 'warn' ? '!' : '✗'}</span>
            <span className="text-fg-dim">{checkName(r.name)}</span>
            <span className="min-w-0 break-words text-fg-dim">{r.detail || 'OK'}</span>
          </div>
        ))}
      </div>
      </Section>

      {drivers?.supported !== false && (
        <Section title={byPlatform('VPN drivers', 'Protocol programs')} right={<>
          <button className="btn-ghost btn-sm" disabled={busy === 'drivers' || busy === 'repair'} onClick={() => void loadDrivers()}>Check again</button>
          {drivers?.live && !drivers.live.ok && <button className="btn-primary btn-sm" disabled={!!busy} onClick={() => void repair()}>{byPlatform('Repair drivers', 'Repair')}</button>}
        </>}>
        <div className="card">
          {!drivers ? <p className="text-sm text-fg-dim">Checking…</p> : drivers.live ? drivers.live.deps.map((r) => {
            const good = r.status === 'present' || r.status === 'installed' || r.status === 'upgraded';
            return (
              <div key={r.name} data-driver={r.name} className="grid grid-cols-[1.25rem_8rem_1fr] gap-2 sm:grid-cols-[1.25rem_12rem_1fr] border-b border-line py-2 text-sm last:border-0">
                <span className={good ? 'text-ok' : 'text-bad'} aria-label={good ? 'ok' : 'fail'}>{good ? '✓' : '✗'}</span>
                <span className="text-fg-dim">{DRIVER_NAMES[r.name] ?? r.name}</span>
                <span className="min-w-0 break-words text-fg-dim">{DRIVER_COPY[r.status] ?? r.status}{r.found ? ` · ${r.found}` : ''}{r.detail ? ` — ${r.detail}` : ''}</span>
              </div>
            );
          }) : <p className="text-sm text-bad">{drivers.error}</p>}
          {driverMsg && <p className="mt-2 text-sm">{driverMsg}</p>}
          <p className="mt-2 text-meta text-fg-muted">{byPlatform('WireGuard, AmneziaWG and OpenVPN carry those protocols; V2Ray, Xray and Hysteria2 ship inside the app. Repair installs only what is missing.', 'All six protocols ship inside the app: WireGuard and AmneziaWG run in the VPN engine, the others as bundled programs. Repair re-links any that are missing.')}</p>
        </div>
        </Section>
      )}
      </div>

      <div>
      <Section title="Connection checks">
      <div className="card">
        <div className="mb-3 flex flex-wrap gap-2">
          <button className="btn-ghost" disabled={!!busy} onClick={() => void run('ip', async () => { const r = await call<{ ip?: string; source?: string; error?: string }>(window.api.IPC.QUALITY_IP); setIp(r.error ?? `${r.ip} (via ${r.source})`); })}>Check my IP</button>
          <button className="btn-ghost" disabled={!!busy} onClick={() => void run('speed', async () => { setSpeed('Testing…'); const r = await call<{ mbps?: number; source?: string; error?: string }>(window.api.IPC.QUALITY_SPEED); setSpeed(r.error ?? `${r.mbps} Mbps (via ${r.source})`); })}>Speed test</button>
          <button className="btn-ghost" disabled={!!busy} onClick={() => void loadRpc()}>Check RPC</button>
          <button className="btn-danger ml-auto" disabled={!!busy} onClick={() => void run('restore', async () => { await call(window.api.IPC.RESTORE_NETWORK); })}>Restore network</button>
        </div>
        {ip && <p className="text-sm">Public IP: <span className="mono">{ip}</span>{snap.session ? ' — should be the server’s address while connected.' : ''}</p>}
        {speed && <p className="text-sm">Download: {speed}</p>}
        {rpc && rpc.benched.length > 0 && <p className="text-sm text-warn">Skipping {rpc.benched.length} rate-limited RPC endpoint(s) for now.</p>}
        <p className="mt-2 text-meta text-fg-muted">Restore network ends any session and removes kill-switch rules and system-proxy settings this app made.</p>
      </div>
      </Section>

      <Section title="App log" right={<>
        <button className="btn-ghost btn-sm" onClick={() => void run('log', async () => setLog(await call<string>(window.api.IPC.LOG_TAIL)))}>Load</button>
        {log && <Copy text={log} label="Copy log" />}
      </>}>
      <div className="card">
        {log ? <pre className="mono max-h-80 overflow-auto whitespace-pre-wrap rounded bg-bg-input p-3">{log}</pre> : <p className="text-meta text-fg-muted">Secrets and API keys are removed from the log.</p>}
      </div>
      </Section>
      </div>
      </div>
    </div>
  );
}
