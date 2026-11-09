// The log file and logcat never carry an RPC key: not in the query, not in user:password@, and not in
// the URL path, where an RPC gate puts its token (QA-M6: a config echo printed the gate token).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { redact, redactUrls, routeConsoleToLog } from '../../src/main/logger';

const TOKEN = 'pcjwPAbiA1CUVb48vVb98iXy';

describe('redactUrls', () => {
  it('a gate token in the URL path is hidden', () => {
    const s = `fetch failed: request to http://10.0.0.5:8899/c/${TOKEN}/ timed out`;
    expect(redactUrls(s)).toBe('fetch failed: request to http://10.0.0.5:8899/c/<redacted>/ timed out');
    expect(redactUrls(s)).not.toContain(TOKEN);
  });
  it('query keys and credentials are still hidden', () => {
    expect(redactUrls('see https://rpc.example.org/?api-key=0123456789abcdef now')).toBe('see https://rpc.example.org/?<redacted> now');
    expect(redactUrls('wss://u:p@rpc.example.org/x')).toBe('wss://<redacted>@rpc.example.org/x');
  });
  it('short path parts and plain URLs stay as they are', () => {
    expect(redactUrls('https://api.devnet.solana.com/v1/metadata')).toBe('https://api.devnet.solana.com/v1/metadata');
    expect(redactUrls('no url here: abcdefghijklmnopqrstuvwxyz')).toBe('no url here: abcdefghijklmnopqrstuvwxyz');
  });
  it('nested values and error messages are redacted', () => {
    const out = JSON.stringify(redact({ e: new Error(`bad http://h:1/c/${TOKEN}`), list: [`wss://h/c/${TOKEN}`] }));
    expect(out).not.toContain(TOKEN);
  });
});

describe('routeConsoleToLog', () => {
  const saved = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  afterEach(() => Object.assign(console, saved));

  it('console output goes through the redacting log, never raw', () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    routeConsoleToLog();
    console.warn(`[rpc] attempt failed on http://h:8899/c/${TOKEN}/`);
    console.error(new Error(`boom https://h/c/${TOKEN}`));
    spy.mockRestore();
    const all = writes.join('');
    expect(all).toContain('[rpc] attempt failed on http://h:8899/c/<redacted>/');
    expect(all).toContain('boom https://h/c/<redacted>');
    expect(all).not.toContain(TOKEN);
  });
});
