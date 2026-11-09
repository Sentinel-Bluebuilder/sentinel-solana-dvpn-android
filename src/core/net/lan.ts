// ─── This computer's local network ranges (for "Allow local network" copy) ───
// Pure: takes os.networkInterfaces()-shaped input. Private IPv4 only (RFC 1918 + link-local),
// skipping loopback and our own VPN adapters, so the Kill switch page can say exactly what
// "local network" lets through (ExpressVPN/Mullvad show the same idea as "devices on your LAN").

export interface IfaceAddr { address: string; netmask: string; family: string | number; internal: boolean; cidr?: string | null }

const PRIVATE = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/;
const VPN_IFACE = /^(dvpn|ddv|wg|awg|wintun|openvpn|tun|tap|hysteria|xray|v2ray)/i;

function maskBits(mask: string): number {
  return mask.split('.').reduce((n, o) => n + (Number(o) >>> 0).toString(2).split('').filter((b) => b === '1').length, 0);
}

function networkOf(ip: string, bits: number): string {
  const n = ip.split('.').reduce((acc, o) => ((acc << 8) | Number(o)) >>> 0, 0);
  const masked = bits === 0 ? 0 : (n & (~0 << (32 - bits))) >>> 0;
  return [24, 16, 8, 0].map((s) => (masked >>> s) & 255).join('.');
}

export function lanRanges(ifaces: Record<string, IfaceAddr[] | undefined>): string[] {
  const out = new Set<string>();
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (VPN_IFACE.test(name)) continue;
    for (const a of addrs ?? []) {
      if (a.internal || !(a.family === 'IPv4' || a.family === 4) || !PRIVATE.test(a.address)) continue;
      const bits = maskBits(a.netmask);
      out.add(`${networkOf(a.address, bits)}/${bits}`);
    }
  }
  return [...out].sort();
}
