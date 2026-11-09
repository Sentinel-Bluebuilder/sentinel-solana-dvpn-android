import { describe, it, expect } from 'vitest';
import { rpcUnavailableCopy, RPC_UNAVAILABLE, isTransportError } from '../../src/core/chain/rpc';

// Matrix 2026-10-22: "config: all RPC endpoints failed: … 429 …" reached the CLI user raw.
describe('RPC unavailable copy', () => {
  const mk = (m: string) => Object.assign(new Error(m), { name: RPC_UNAVAILABLE });
  it('a 429 reads as rate-limited, names rpc set', () => {
    const c = rpcUnavailableCopy(mk('config: all RPC endpoints failed:\n  https://api.devnet.solana.com/: Error: 429 Too Many Requests'));
    expect(c?.message).toMatch(/rate-limiting/);
    expect(c?.message).not.toMatch(/https?:\/\//);
    expect(c?.action).toMatch(/rpc set/);
  });
  it('other transport failures read as unreachable', () => {
    expect(rpcUnavailableCopy(mk('config: all RPC endpoints failed:\n  x: ECONNREFUSED'))?.message).toMatch(/could not be reached/);
  });
  it('a daemon-relayed exhaustion (plain Error, node: prefix) reads the same', () => {
    const c = rpcUnavailableCopy(new Error('node:9EQJ7d: all RPC endpoints failed:\n  https://devnet.helius-rpc.com/?<redacted>: failed to get info'));
    expect(c?.message).toMatch(/could not be reached/);
    expect(c?.message).not.toMatch(/https?:\/\//);
  });
  // W-RPC-GARBAGE (health:fault-rpc-bad): `rpc set https://example.com` answered 405 + a web page.
  const page = 'failed to get info about account Cu5vofxVQgZXRVwfBqApw84ZWy1hjhDmHkznyDr6TRiQ: Error: 405 Method Not Allowed: <!doctype html><html lang="en"><head><title>Example Domain</title>';
  it('an endpoint that answers with a web page is a failed endpoint, not a chain error', () => {
    expect(isTransportError(new Error(page))).toBe(true);
    expect(isTransportError(new Error('404 Not Found: <html><body>nope</body></html>'))).toBe(true);
    expect(isTransportError(new Error('Unexpected token \'<\', "<!DOCTYPE "... is not valid JSON'))).toBe(true);
  });
  it('chain-level errors and a 400 stay chain errors (thrown, not retried)', () => {
    expect(isTransportError(new Error('failed to get info about account X: Error: Invalid param: WrongSize'))).toBe(false);
    expect(isTransportError(new Error('400 Bad Request: {"jsonrpc":"2.0","error":{"code":-32602}}'))).toBe(false);
    expect(isTransportError(new Error('custom program error: 0x1790 (ChannelNotOpen 6032)'))).toBe(false);
  });
  it('every endpoint answering a web page reads as a wrong address, plain, no URL or HTML', () => {
    const c = rpcUnavailableCopy(mk(`connect: all RPC endpoints failed:\n  https://example.com/: ${page.slice(0, 160)}`));
    expect(c?.message).toMatch(/did not answer like a Solana RPC endpoint/);
    expect(c?.message).not.toMatch(/https?:\/\/|<|405/);
    expect(c?.action).toMatch(/rpc set/);
    // one endpoint unreachable + one web page: still "could not be reached"
    expect(rpcUnavailableCopy(mk(`x: all RPC endpoints failed:\n  a: fetch failed\n  b: ${page.slice(0, 160)}`))?.message).toMatch(/could not be reached/);
  });
  it('leaves every other error alone', () => {
    expect(rpcUnavailableCopy(new Error('429 Too Many Requests'))).toBeNull();
    expect(rpcUnavailableCopy(undefined)).toBeNull();
  });
});
