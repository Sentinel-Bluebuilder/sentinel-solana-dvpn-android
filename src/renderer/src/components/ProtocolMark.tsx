// ─── Protocol logos (official files, bundled; sources + policies in docs/ASSETS.md) ───
// Every protocol shows its official mark. WireGuard and OpenVPN are registered trademarks; the owner
// chose to show them (2026-10-22: "we can use it its no problem all the vpn apps use it"), see docs/ASSETS.md.
import wireguard from '../assets/protocols/wireguard.png';
import openvpnDark from '../assets/protocols/openvpn-on-dark.svg';
import openvpnLight from '../assets/protocols/openvpn-on-light.svg';
import xrayDark from '../assets/protocols/xray-on-dark.svg';
import xrayLight from '../assets/protocols/xray-on-light.svg';
import hy2Dark from '../assets/protocols/hysteria2-on-dark.svg';
import hy2Light from '../assets/protocols/hysteria2-on-light.svg';
import v2ray from '../assets/protocols/v2ray.png';
import awgDark from '../assets/protocols/amneziawg-on-dark.svg';
import awgLight from '../assets/protocols/amneziawg-on-light.svg';
import { PROTOCOLS, protocolLabel, type ProtocolId } from '../../../shared/protocols';

/** File per theme; one file when the mark reads on both. null = name badge only. */
export const PROTOCOL_LOGOS: Record<ProtocolId, { dark: string; light: string } | null> = {
  wireguard: { dark: wireguard, light: wireguard },
  amneziawg: { dark: awgDark, light: awgLight },
  openvpn: { dark: openvpnDark, light: openvpnLight },
  v2ray: { dark: v2ray, light: v2ray },
  xray: { dark: xrayDark, light: xrayLight },
  hysteria2: { dark: hy2Dark, light: hy2Light },
};

/** Badge text for a protocol shown without a logo (null in PROTOCOL_LOGOS). None today; unknown
    protocols fall back to their first two letters. */
export const PROTOCOL_BADGES: Partial<Record<ProtocolId, string>> = {};

/** The protocol's mark at `size` px (square box, logo fitted inside), or a short name badge. */
export function ProtocolMark({ protocol, size = 24, className = '' }: { protocol: string; size?: number; className?: string }) {
  const id = protocol.toLowerCase() as ProtocolId;
  const name = protocolLabel(id);
  const logo = PROTOCOLS.includes(id) ? PROTOCOL_LOGOS[id] : null;
  const box = { width: size, height: size };
  if (!logo) {
    const text = PROTOCOL_BADGES[id] ?? name.slice(0, 2);
    // A name tile the same height as a logo: body face, semibold, 11-12 px, short padding, so the
    // letters stay crisp at list size (the display face and a 1 px outline both smudged at 9-10 px).
    const style = { height: size, minWidth: size, padding: '0 5px', fontSize: Math.max(11, Math.round(size * 0.5)) };
    return (
      <span className={`inline-flex shrink-0 items-center justify-center rounded-[5px] bg-fg/10 font-sans font-semibold leading-none tracking-[0.02em] text-fg ${className}`}
        style={style} role="img" aria-label={name} title={name} data-protocol-mark={id}>
        {text}
      </span>
    );
  }
  const img = (src: string, cls: string) => <img src={src} alt="" className={`${cls} object-contain`} style={box} draggable={false} />;
  return (
    <span className={`inline-flex shrink-0 items-center justify-center ${className}`} style={box} role="img" aria-label={name} title={name} data-protocol-mark={id}>
      {logo.dark === logo.light ? img(logo.dark, '') : <>{img(logo.dark, 'logo-on-dark')}{img(logo.light, 'logo-on-light')}</>}
    </span>
  );
}

/** Several protocols in a row (server lists): marks with names, or marks only when `compact`. */
export function ProtocolList({ names, compact = false, size = 20 }: { names: string[]; compact?: boolean; size?: number }) {
  if (!names.length) return <span>—</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1 align-middle">
      {names.map((n) => (compact ? <ProtocolMark key={n} protocol={n} size={size} /> : <ProtocolTag key={n} protocol={n} size={size} />))}
    </span>
  );
}

/** Mark + display name, for rows and chips. */
export function ProtocolTag({ protocol, size = 20 }: { protocol: string; size?: number }) {
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap">
      <ProtocolMark protocol={protocol} size={size} />
      <span>{protocolLabel(protocol)}</span>
    </span>
  );
}
