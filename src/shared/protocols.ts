// ─── Protocol ids + display names (one list for every screen and the CLI) ───
// Ids match the chain bit names (core/chain/idl.ts PROTOCOL_BITS) and dvpnd service types.

export const PROTOCOLS = ['wireguard', 'amneziawg', 'openvpn', 'v2ray', 'xray', 'hysteria2'] as const;
export type ProtocolId = (typeof PROTOCOLS)[number];

const LABELS: Record<ProtocolId, string> = {
  wireguard: 'WireGuard',
  amneziawg: 'AmneziaWG',
  openvpn: 'OpenVPN',
  v2ray: 'V2Ray',
  xray: 'Xray',
  hysteria2: 'Hysteria2',
};

/** Display name for a protocol id (case-insensitive); unknown ids come back as given. */
export function protocolLabel(id: string): string {
  return LABELS[id.toLowerCase() as ProtocolId] ?? id;
}
