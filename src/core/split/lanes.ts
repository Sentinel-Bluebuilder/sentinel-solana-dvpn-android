// ─── Split tunnelling picture: which apps go which way (pure, unit-tested) ───
// Two lanes: through the VPN, and the normal connection. Built from the saved [split] setting,
// what dvpnd really applies to this protocol (splitNotApplied), and the live coverage check
// (measured exit IPs), never from the setting alone.
import type { SplitSettings } from '../daemon/config';
import type { Coverage } from '../session/coverage';

export interface LaneItem { kind: 'app' | 'rest' | 'routes' | 'proxy-apps'; label: string; path?: string }
export interface LaneModel {
  live: boolean;                 // a session is running (else: the plan for the next one)
  applied: boolean;              // dvpnd applies the split to this protocol
  vpn: LaneItem[];
  direct: LaneItem[];
  note: string | null;           // why the picture differs from the setting
}

export function laneModel(o: {
  split: SplitSettings | undefined;
  liveService: string | null;     // null when not connected
  coverage: Coverage | null;
  notApplied: string | null;      // splitNotApplied() for the live (or chosen) protocol
  appName: (path: string) => string;
}): LaneModel {
  const s = o.split ?? { mode: 'off', apps: [], routes: [] };
  const live = !!o.liveService;
  const apps = s.apps.map((p) => ({ kind: 'app' as const, label: o.appName(p), path: p }));
  const routes: LaneItem[] = s.routes.length ? [{ kind: 'routes', label: `${s.routes.length} address range${s.routes.length === 1 ? '' : 's'}` }] : [];

  // V2Ray/Xray without whole-device mode: only apps that use the proxy go through.
  if (live && (o.coverage === 'proxy-only' || o.coverage === 'proxy-apps')) {
    return {
      live, applied: false,
      vpn: [{ kind: 'proxy-apps', label: o.coverage === 'proxy-apps' ? 'Browsers and apps that use the Windows proxy' : 'Apps you pointed at the VPN proxy' }],
      direct: [{ kind: 'rest', label: o.coverage === 'proxy-apps' ? 'Apps that ignore the proxy' : 'Every other app' }],
      note: 'This session is a proxy, so your app choices are not used. Turn on "Whole computer" to use them.',
    };
  }
  if (s.mode === 'off' || o.notApplied) {
    return { live, applied: s.mode === 'off', vpn: [{ kind: 'rest', label: 'Every app' }], direct: [], note: s.mode === 'off' ? null : o.notApplied };
  }
  if (s.mode === 'include') {
    return { live, applied: true, vpn: [...apps, ...routes], direct: [{ kind: 'rest', label: 'Every other app' }], note: null };
  }
  return { live, applied: true, vpn: [{ kind: 'rest', label: 'Every other app' }], direct: [...apps, ...routes], note: null };
}
