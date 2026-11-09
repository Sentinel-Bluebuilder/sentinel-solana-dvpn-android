// ─── dvpnd gRPC client (client role) ───
// Shape ported from plans-solana lib/daemon.js (grpc-js + proto-loader options,
// deadlines, gRPC status mapping). Targets:
//   Windows  unix:\\.\pipe\ProtectedPrefix\Administrators\dvpnd\client   (named pipe; needs socket_group=Users)
//   Linux    unix:///<home>/daemon.sock
//   dev rig  127.0.0.1:<port>   (a bridge to a WSL daemon socket)
// The app never builds tunnels, edits the firewall or signs vouchers: it asks dvpnd.
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

export const DEFAULT_WINDOWS_PIPE = '\\\\.\\pipe\\ProtectedPrefix\\Administrators\\dvpnd\\client';
const DEADLINE_MS = 20_000;
const START_DEADLINE_MS = 120_000; // StartSession opens a channel on chain + dials the node

// ─── Wire types (proto3 JSON via proto-loader: longs as strings, camelCase) ───
export interface DaemonUsage { rxBytes: string; txBytes: string; seconds: string }
export interface DaemonSession {
  id: string;
  node: string;
  status: string; // open | active | closing | ended | closed
  service: string;
  usage: DaemonUsage | null;
  spent: string;
  startedAt: { seconds: string; nanos: number } | null;
  endedAt: { seconds: string; nanos: number } | null;
  error: string;
  channel: string;
  ticketHash: string;
  proxyEndpoint: string;
  /** Up but degraded (live only): 'large-packets'. Empty or absent (older dvpnd) = all is well. */
  warning?: string;
  /** A reconnect's new session: the id it replaces. Empty or absent (older dvpnd) = none. */
  replaces?: string;
  /** Unix seconds the reconnect chain's first session started (int64 as string); '0'/absent = startedAt. */
  chainStartedUnix?: string;
  /** On the replaced session's last event / ended row: the new session's id. */
  replacedBy?: string;
}
export interface DaemonChannel { address: string; node: string; mode: number; escrow: string; cumulative: string; openedAt: string; status: string }
export interface DaemonTicket { hash: string; provider: string; node: string; subscription: string; expiresAt: string; dataCapBytes: string }
export interface DaemonVersion { commit: string; tag: string; network: string; programId: string; mint: string }

export type Credential =
  | { channel: string }
  | { newChannel: { mode: number; escrow: string } }
  | { ticketRequest: { provider: string; subscription: string } }
  | { ticketHash: string };

export interface StopResult { session: DaemonSession | null; killSwitchReleased: boolean; dnsRevertFailed: boolean }

/** A daemon failure with its gRPC status kept, so the UI can map it. */
export class DaemonError extends Error {
  grpcCode: number;
  kind: 'unavailable' | 'precondition' | 'not-found' | 'timeout' | 'permission' | 'invalid' | 'internal';
  constructor(err: grpc.ServiceError | Error, op: string) {
    const code = (err as grpc.ServiceError).code ?? grpc.status.UNKNOWN;
    const detail = (err as grpc.ServiceError).details || err.message;
    super(`${op}: ${detail}`);
    this.name = 'DaemonError';
    this.grpcCode = code;
    this.kind = code === grpc.status.UNAVAILABLE ? 'unavailable'
      : code === grpc.status.DEADLINE_EXCEEDED ? 'timeout'
        : code === grpc.status.NOT_FOUND ? 'not-found'
          : code === grpc.status.FAILED_PRECONDITION || code === grpc.status.ABORTED || code === grpc.status.ALREADY_EXISTS ? 'precondition'
            : code === grpc.status.PERMISSION_DENIED || code === grpc.status.UNAUTHENTICATED ? 'permission'
              : code === grpc.status.INVALID_ARGUMENT ? 'invalid'
                : 'internal';
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Stub = any;

export class DaemonClient {
  private readonly clientSvc: Stub;
  private readonly daemonSvc: Stub;
  readonly target: string;

  constructor(target: string, protoPath: string) {
    this.target = target;
    const def = protoLoader.loadSync(protoPath, { keepCase: false, longs: String, enums: String, defaults: true, oneofs: true });
    const pkg = grpc.loadPackageDefinition(def) as Stub;
    const v1 = pkg.sentinel.daemon.v1;
    const creds = grpc.credentials.createInsecure(); // local pipe / socket only; never a network address
    const opts = { 'grpc.default_authority': 'localhost' };
    this.clientSvc = new v1.ClientService(target, creds, opts);
    this.daemonSvc = new v1.DaemonService(target, creds, opts);
  }

  private unary<T>(svc: Stub, method: string, req: object, deadlineMs = DEADLINE_MS, md = new grpc.Metadata()): Promise<T> {
    return new Promise((resolve, reject) => {
      svc[method](req, md, { deadline: new Date(Date.now() + deadlineMs) }, (err: grpc.ServiceError | null, res: T) => {
        if (err) reject(new DaemonError(err, method));
        else resolve(res);
      });
    });
  }

  async getVersion(): Promise<DaemonVersion> {
    const r = await this.unary<{ version: DaemonVersion }>(this.daemonSvc, 'GetVersion', {}, 5000);
    return r.version;
  }

  /** `basis`: what the user chose for a deposit. dvpnd otherwise uses the basis in its config file, which may
   *  be left from another session (Q0283: a per-GB connect ran on per-hour terms). Older dvpnd ignores it. */
  async startSession(node: string, credential: Credential, basis?: 'per_gb' | 'per_hour'): Promise<DaemonSession> {
    const req: Record<string, unknown> = { node, credential };
    if (basis) req.terms = { basis: startTermsBasis(basis) };
    const r = await this.unary<{ session: DaemonSession }>(this.clientSvc, 'StartSession', req, START_DEADLINE_MS);
    return r.session;
  }

  /** keepKillSwitch: a new session follows at once (server switch), so dvpnd keeps the block (gap #67, rc+; older dvpnd ignores it). */
  async stopSession(id: string, opts: { keepKillSwitch?: boolean } = {}): Promise<StopResult> {
    const md = new grpc.Metadata();
    if (opts.keepKillSwitch) md.set('x-keep-kill-switch', '1');
    const r = await this.unary<{ session: DaemonSession; killSwitchReleased: boolean; dnsRevertFailed: boolean }>(this.clientSvc, 'StopSession', { id }, 60_000, md);
    return { session: r.session ?? null, killSwitchReleased: !!r.killSwitchReleased, dnsRevertFailed: !!r.dnsRevertFailed };
  }

  async getSession(id: string): Promise<DaemonSession | null> {
    const r = await this.unary<{ session: DaemonSession | null }>(this.clientSvc, 'GetSession', { id });
    return r.session ?? null;
  }

  async listSessions(): Promise<DaemonSession[]> {
    const r = await this.unary<{ sessions: DaemonSession[] }>(this.clientSvc, 'ListSessions', {});
    return r.sessions ?? [];
  }

  async listChannels(): Promise<DaemonChannel[]> {
    const r = await this.unary<{ channels: DaemonChannel[] }>(this.clientSvc, 'ListChannels', {});
    return r.channels ?? [];
  }

  async listTickets(): Promise<DaemonTicket[]> {
    const r = await this.unary<{ tickets: DaemonTicket[] }>(this.clientSvc, 'ListTickets', {});
    return r.tickets ?? [];
  }

  /** Server stream of session updates. Returns a cancel function. */
  watchSession(id: string, onUpdate: (s: DaemonSession) => void, onEnd: (err: DaemonError | null) => void): () => void {
    const call = this.clientSvc.WatchSession({ id });
    let done = false;
    const finish = (err: DaemonError | null): void => {
      if (done) return;
      done = true;
      onEnd(err);
    };
    call.on('data', (m: { session: DaemonSession }) => { if (m.session) onUpdate(m.session); });
    call.on('error', (e: grpc.ServiceError) => {
      if (e.code === grpc.status.CANCELLED) finish(null);
      else finish(new DaemonError(e, 'WatchSession'));
    });
    call.on('end', () => finish(null));
    return () => {
      done = true;
      call.cancel();
    };
  }

  close(): void {
    this.clientSvc.close();
    this.daemonSvc.close();
  }
}

/** grpc-js target for a Windows named pipe path (or a unix socket path). */
/** dvpnd's session.Basis numbers (per_gb = 1, per_hour = 2). Exported for tests. */
export function startTermsBasis(basis: 'per_gb' | 'per_hour'): number {
  return basis === 'per_hour' ? 2 : 1;
}

export function pipeTarget(pathOrPipe: string): string {
  return `unix:${pathOrPipe}`;
}
