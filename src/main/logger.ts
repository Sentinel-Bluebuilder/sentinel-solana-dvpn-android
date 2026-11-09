// ─── File logger with redaction (F19.5, F24) ───
// Shape ported from sentinel-node-manager-solana services/logger.ts (secret-key
// regex, RPC query redaction) without winston: a 5 MB × 3 rolling file.
import fs from 'node:fs';
import path from 'node:path';

const SECRET_KEY_RE = /(mnemonic|password|privateKey|private[_-]?key|passphrase|seed|secret|token|api[_-]?key|authorization|credential)/i;
const URL_QUERY_RE = /((?:https?|wss?):\/\/[^\s?'"]+)\?[^\s'"]*/gi;
const MAX_BYTES = 5 * 1024 * 1024;
const KEEP = 3;

let dir: string | null = null;

export function initLogger(logDir: string): void {
  dir = logDir;
  fs.mkdirSync(dir, { recursive: true });
}

export function logFile(): string | null {
  return dir ? path.join(dir, 'app.log') : null;
}

// user:password@ in a URL is a credential too (the macOS app CLI fuzz: it was printed back)
const URL_USERINFO_RE = /((?:https?|wss?):\/\/)[^\s/?#@'"]+@/gi;

// A key in the URL path (an RPC gate puts its token there: https://host/c/<token>/) is a credential
// too; same rule as redactUrl in core/chain/rpc.ts: a path segment of 20+ key characters (QA-M6).
const URL_PATH_RE = /((?:https?|wss?):\/\/[^\s/?#'"]+)(\/[^\s?#'"]*)/gi;
const PATH_KEY_RE = /^[A-Za-z0-9_-]{20,}$/;

/** Strip query strings and path keys (RPC API keys live there) and user:password@ from any URL in a string. */
export function redactUrls(s: string): string {
  return s
    .replace(URL_USERINFO_RE, '$1<redacted>@')
    .replace(URL_PATH_RE, (_m, origin: string, p: string) => origin + p.split('/').map((seg) => (PATH_KEY_RE.test(seg) ? '<redacted>' : seg)).join('/'))
    .replace(URL_QUERY_RE, '$1?<redacted>');
}

/** Route console.* through the redacting log (Android: the shell copies stderr and any non-JSON stdout line to logcat). */
export function routeConsoleToLog(): void {
  const line = (a: unknown[]): string => a.map((x) => (x instanceof Error ? x.message : String(x))).join(' ');
  console.log = (...a: unknown[]): void => log.info(line(a));
  console.info = (...a: unknown[]): void => log.info(line(a));
  console.warn = (...a: unknown[]): void => log.warn(line(a));
  console.error = (...a: unknown[]): void => log.error(line(a));
}

export function redact(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactUrls(value);
  // the stack repeats the message, so it carries the same URLs
  if (value instanceof Error) return { message: redact(value.message), stack: value.stack === undefined ? undefined : redactUrls(value.stack) };
  if (depth > 6 || !value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = SECRET_KEY_RE.test(k) ? '[redacted]' : redact(v, depth + 1);
  return out;
}

function rotate(file: string): void {
  try {
    if (!fs.existsSync(file) || fs.statSync(file).size < MAX_BYTES) return;
    for (let i = KEEP - 1; i >= 1; i--) {
      const from = `${file}.${i}`;
      if (fs.existsSync(from)) fs.renameSync(from, `${file}.${i + 1}`);
    }
    fs.renameSync(file, `${file}.1`);
  } catch (err) {
    process.stderr.write(`log rotate failed: ${(err as Error).message}\n`);
  }
}

function write(level: string, msg: string, meta?: unknown): void {
  const line = `[${new Date().toISOString()}] ${level.padEnd(5)} ${redact(msg)}${meta === undefined ? '' : ' ' + JSON.stringify(redact(meta))}\n`;
  if (process.env.NODE_ENV !== 'production') process.stdout.write(line);
  const file = logFile();
  if (!file) return;
  try {
    rotate(file);
    fs.appendFileSync(file, line);
  } catch (err) {
    process.stderr.write(`log write failed: ${(err as Error).message}\n`);
  }
}

export const log = {
  debug: (m: string, meta?: unknown): void => { if (process.env.DVPN_LOG_LEVEL === 'debug') write('debug', m, meta); },
  info: (m: string, meta?: unknown): void => write('info', m, meta),
  warn: (m: string, meta?: unknown): void => write('warn', m, meta),
  error: (m: string, meta?: unknown): void => write('error', m, meta),
};

export function tailLog(lines = 200): string {
  const file = logFile();
  if (!file || !fs.existsSync(file)) return '';
  const text = fs.readFileSync(file, 'utf8');
  return text.split('\n').slice(-lines - 1).join('\n');
}

export function attachGlobalHandlers(): void {
  process.on('uncaughtException', (err) => log.error('uncaughtException', err));
  process.on('unhandledRejection', (reason) => log.error('unhandledRejection', { reason: String(reason) }));
}
