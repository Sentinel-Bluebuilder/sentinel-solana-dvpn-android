// ─── Types shared by main, preload and renderer ───
// Everything crossing IPC is JSON: bigints travel as decimal strings.
import type { ConnView } from '../core/session/state';
import type { NodeRecord, ProbeResult } from '../core/nodes/discovery';
import type { PlanRecord, SubscriptionRecord } from '../core/plans/plans';
import type { WalletStatus } from '../core/app/wallet-status';
import type { Basis } from '../core/pricing/cost';
import type { KillSwitch } from '../core/daemon/config';
import type { Coverage } from '../core/session/coverage';
import { DEFAULT_POLL, type PollSettings } from './poll';

export type { ConnView, NodeRecord, ProbeResult, PlanRecord, SubscriptionRecord, WalletStatus, Basis, KillSwitch, Coverage };

export interface AppSettings {
  rpcUrls: string[];
  defaultBasis: Basis;
  defaultGb: number;
  defaultHours: number;
  preferredCountry: string | null;
  autoConnect: boolean;
  autoTopUpDevice: boolean; // send the device SOL from the wallet when it runs low before a connect
  startWithOs: boolean;
  closeToTray: boolean;
  thirdPartyChecks: boolean; // IP check + speed test hit third-party services
  notifications: boolean; // desktop notifications while the window is hidden (F21.3)
  proxyOnConnect: boolean; // V2Ray/Xray: point the Windows system proxy at the session on connect (restored on disconnect)
  theme: 'system' | 'dark' | 'light';
  language: 'en';
  favourites: string[];
  allowanceTdvpn: string; // default device allowance (display units)
  poll: PollSettings; // seconds per background job (src/shared/poll.ts)
}

export const DEFAULT_SETTINGS: AppSettings = {
  rpcUrls: ['https://api.devnet.solana.com'],
  defaultBasis: 'per_gb',
  defaultGb: 1,
  defaultHours: 1,
  preferredCountry: null,
  autoConnect: false,
  autoTopUpDevice: true,
  startWithOs: false,
  closeToTray: true,
  thirdPartyChecks: true,
  notifications: true,
  proxyOnConnect: true,
  theme: 'system',
  language: 'en',
  favourites: [],
  allowanceTdvpn: '50',
  poll: DEFAULT_POLL,
};

export interface DaemonInfo {
  reachable: boolean;
  bridge: 'running' | 'stopped' | 'missing' | 'error';
  version: string | null;
  networkOk: boolean | null; // daemon program_id/mint == app constants
  error: string | null;
  home: string | null;
  device: string | null;
}

export interface LiveSession {
  id: string;
  node: string;
  status: string;
  service: string;
  rxBytes: string;
  txBytes: string;
  seconds: string;
  spent: string;
  channel: string;
  proxyEndpoint: string;
  error: string;
  /** dvpnd's live warning code ('' = none); the copy is sessionWarningCopy. */
  warning: string;
  startedAt: number | null;
}

export interface PendingSettlement {
  channel: string;
  node: string;
  mode: number;
  escrow: string;
  redeemed: string;
  status: 'open' | 'closing' | 'ready' | 'in-use';
  readyAt: number | null;
  refundable: string;
}

export interface AppSnapshot {
  hasWallet: boolean;
  owner: string | null;
  signerKind: 'in-app' | 'browser' | null;
  wallet: WalletStatus | null;
  daemon: DaemonInfo;
  conn: ConnView;
  session: LiveSession | null;
  settlements: PendingSettlement[];
  subscriptions: SubscriptionRecord[];
  rpc: { serving: string | null; healthy: boolean; publicOnly: boolean };
  lastCloseMessage: { message: string; action: string | null } | null;
  /** Why the last connect did not finish, with its next step and server (Home shows the button). */
  lastConnectError: { code: string; message: string; action: string | null; node: string } | null;
  proxyActive: boolean; // Windows system proxy currently points at our SOCKS endpoint
  publicIp: { ip: string; source: string; at: number; viaProxy?: boolean; directIp?: string | null; sid?: string | null; nodeIp?: string | null } | null; // F5.9: 30 s while connected, once when idle
  homeIp: string | null; // the user's own IP, measured while not connected (coverage check)
  coverage: Coverage | null; // what the live session really covers (core/session/coverage)
  dns: string | null; // the VPN service's resolver, by preset name (F15)
}

export interface NodeView extends NodeRecord {
  probe: ProbeResult | null;
  favourite: boolean;
}

export interface HistoryEntry {
  id: string;
  node: string;
  country: string;
  service: string;
  startedAt: number;
  endedAt: number | null;
  rxBytes: string;
  txBytes: string;
  spent: string;
  channel: string;
  closeReason: string | null;
}

export interface ConnectRequest {
  node: string;
  basis: Basis;
  units: number;
  confirmed: true;
  subscription?: { provider: string; subscription: string };
  /** Server switch (F11.6): check the new server first, then stop the current session. */
  switch?: boolean;
}

export interface Result<T = undefined> {
  ok: boolean;
  data?: T;
  error?: string;
  code?: string;
  action?: string | null;
}
