// ─── String catalogue (F25): every navigation/heading string lives here ───
// English only for v1; screens read t('key') so a language can be added without a code hunt.
const en = {
  'nav.home': 'Connect',
  'nav.nodes': 'Servers',
  'nav.plans': 'Plans',
  'nav.activity': 'Activity',
  'nav.nodetest': 'Node test',
  'nav.wallet': 'Wallet',
  'nav.killswitch': 'Kill switch',
  'nav.split': 'Split tunnelling',
  'nav.settings': 'Settings',
  'nav.diagnostics': 'Diagnostics',
  'nav.cli': 'CLI',
  'nav.more': 'More',
  'app.tagline': 'Pay any node directly. No accounts, no servers of ours.',
  'net.devnet': 'Solana devnet — test tokens only',
  'onb.title': 'Welcome to Devnet dVPN',
  'onb.wallet': 'Your wallet',
  'onb.device': 'This device',
  'onb.service': 'VPN service',
  'rpc.publicOnly': 'Only the public devnet RPC is configured. It rate-limits real use; add your own endpoint in Settings.',
} as const;

export type StringKey = keyof typeof en;
export const t = (k: StringKey): string => en[k];
