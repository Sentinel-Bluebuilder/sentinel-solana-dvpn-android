// ─── `split` — split tunnelling: what is set, what each protocol does with it, apps to choose ───
// Changing it is `daemon set --split-mode/--split-apps/--split-routes` (engine session, d4d1f3c);
// this command is the read side the Split tunnelling page shows.
import type { Cmd } from './commands';
import { UsageError } from './args';
import { getDaemonSettings } from '../main/daemon/settings';
import { daemonInfo } from '../main/daemon/manager';
import { listApps } from '../main/system/apps';
import { filterApps, sameNameApps } from '../core/split/apps';
import { splitNotApplied } from '../core/session/state';
import { PROTOCOLS, protocolLabel } from '../shared/protocols';

/** Per protocol: null = applied, else the reason (same function the page and connect use). */
export function splitSupportRows(o: { daemonVersion: string | null; killSwitch?: string; wholeDevice?: boolean; hasApps: boolean; platform: string }): Array<{ protocol: string; reason: string | null }> {
  return PROTOCOLS.map((p) => ({ protocol: p, reason: splitNotApplied({ ...o, service: p }) }));
}

export const splitCmd: Cmd = async (a, o) => {
  const sub = a._[1] ?? 'status';
  if (sub === 'status') {
    const d = getDaemonSettings();
    if (!d.readable) { o.print('The VPN service settings cannot be read on this account yet. Install the service first.', { readable: false }); return; }
    const s = d.settings.split ?? { mode: 'off', apps: [], routes: [] };
    const version = daemonInfo().version;
    const rows = splitSupportRows({ daemonVersion: version, killSwitch: d.settings.killSwitch, wholeDevice: d.settings.wholeDevice, hasApps: s.apps.length > 0, platform: process.platform });
    const mode = s.mode === 'include' ? 'Only chosen apps and addresses use the VPN' : s.mode === 'exclude' ? 'Everything uses the VPN except what you left out' : 'Off: every app uses the VPN';
    const lines = [
      `Mode     ${s.mode} (${mode})`,
      `Apps     ${s.apps.length ? s.apps.join('\n         ') : 'none'}`,
      `Routes   ${s.routes.length ? s.routes.join(', ') : 'none'}`,
      `Service  ${version ?? 'not running'} · kill switch ${d.settings.killSwitch ?? 'off'}`,
      '',
      ...rows.map((r) => `${protocolLabel(r.protocol).padEnd(10)} ${r.reason ?? 'applied'}`),
      '',
      'Change it: daemon set --split-mode off|include|exclude --split-apps "C:\\a.exe;C:\\b.exe"|none --split-routes "CIDR,CIDR"|none --yes',
    ];
    o.print(lines.join('\n'), { split: s, daemonVersion: version, protocols: rows });
  } else if (sub === 'apps') {
    const chosen = getDaemonSettings().settings.split?.apps ?? [];
    const v = await listApps(chosen);
    if (!v.supported) { o.print('Choosing apps from a list works on Windows only. Give full paths to daemon set --split-apps.', v); return; }
    const q = typeof a.flags.search === 'string' ? a.flags.search : '';
    const apps = filterApps(v.apps, q);
    const mark = (p: string): string => (chosen.includes(p) ? '*' : ' ');
    const text = apps.map((x) => {
      const twins = sameNameApps(v.apps, x.path).length;
      return `${mark(x.path)} ${x.running ? 'running' : '       '}  ${x.name.padEnd(28).slice(0, 28)}  ${x.path}${twins ? `  (+${twins} with the same program name)` : ''}`;
    }).join('\n');
    o.print(`${text || 'No apps match.'}\n${apps.length} apps${q ? ` matching "${q}"` : ''}. * = chosen now.${v.error ? `\nSome apps could not be listed: ${v.error}` : ''}`, { ...v, apps });
  } else throw new UsageError('split status | apps [--search TEXT]');
};
