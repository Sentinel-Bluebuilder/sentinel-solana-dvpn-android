// ─── split (Android): which apps and addresses use the VPN, every protocol ───
// The desktop split (daemon set --split-*) is dvpnd's; on Android the VPN service applies it.
import { UsageError } from './args';
import { splitApps, splitGet, splitRoutesSet, splitSet, type SplitMode, type SplitState } from '../main/system/split-apps';
import type { Cmd } from './commands';

const SPLIT_TEXT: Record<SplitMode, string> = {
  all: 'Every app uses the VPN (this app reaches the network on its own).',
  include: 'Only these apps use the VPN:',
  exclude: 'Every app uses the VPN except:',
};
const ROUTES_TEXT: Record<SplitMode, string> = {
  all: 'Every address uses the VPN.',
  include: 'Only these addresses use the VPN:',
  exclude: 'Every address uses the VPN except:',
};
const splitText = (s: SplitState): string =>
  [SPLIT_TEXT[s.mode], ...s.packages.map((p) => `  ${p}`), ROUTES_TEXT[s.routeMode], ...s.routes.map((r) => `  ${r}`)].join('\n');
export const splitAndroidCmd: Cmd = async (a, o) => {
  const sub = a._[1] ?? 'show';
  // `status` is the desktop name for the same view; accept it so the shared help and habits work here too.
  if (sub === 'show' || sub === 'status') {
    const s = await splitGet();
    o.print(splitText(s), s);
    return;
  }
  if (sub === 'routes') {
    const mode = a._[2];
    if (!mode) throw new UsageError('split routes all|include|exclude [address|network…]');
    const s = await splitRoutesSet(mode, a._.slice(3));
    o.print(`${splitText(s)}\nApplies from the next connect or server switch.`, s);
    return;
  }
  if (sub === 'apps') {
    const q = typeof a.flags.search === 'string' ? a.flags.search.toLowerCase() : '';
    const apps = (await splitApps()).filter((x) => !q || x.pkg.toLowerCase().includes(q) || x.label.toLowerCase().includes(q));
    o.print(apps.length ? apps.map((x) => `${x.pkg}  ${x.label}${x.system ? '  (preinstalled)' : ''}`).join('\n') : (q ? `No apps match "${q}".` : 'No apps found.'), apps.map(({ icon: _icon, ...rest }) => rest)); // icons are for the screen
    return;
  }
  if (sub !== 'set') throw new UsageError(`unknown: split ${sub}`);
  const mode = a._[2];
  if (!mode) throw new UsageError('split set all|include|exclude [package…]');
  const s = await splitSet(mode, a._.slice(3));
  o.print(`${splitText(s)}\nApplies from the next connect or server switch.`, s);
};
