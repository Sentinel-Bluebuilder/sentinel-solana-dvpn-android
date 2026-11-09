import { describe, expect, it } from 'vitest';
import { createHash, createPrivateKey, sign as edSign } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import { readFileSync } from 'node:fs';
import { rawPayload, verifySignedMetadata, DOMAIN_NODE_METADATA, DOMAIN_PROVIDER_METADATA } from '../../src/core/nodes/nodeapi';
import { countryName, continentOf, flagEmoji } from '../../src/core/nodes/country';
import { closeReasonCopy, connectErrorCopy, phaseFromDaemon, viewFor, openedChannelOn429, NODE_ERROR_ALIASES } from '../../src/core/session/state';
import { planChannel, refundable, formatCountdown } from '../../src/core/settlement/settlement';
import { costPreview, fundingBlocker, priceLabel } from '../../src/core/pricing/cost';
import { keypairFromInput, keypairToJson } from '../../src/core/wallet/keys';
import bs58 from 'bs58';

// ─── Signed metadata ───
function signed(kp: Keypair, payloadText: string, dom: Buffer = DOMAIN_NODE_METADATA[0]): string {
  const digest = createHash('sha256').update(Buffer.from(payloadText, 'utf8')).digest();
  const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(kp.secretKey.subarray(0, 32))]), format: 'der', type: 'pkcs8' });
  const sig = edSign(null, Buffer.concat([dom, digest]), key);
  return `{"payload": ${payloadText},"signature":"${Buffer.from(sig).toString('base64')}","signer":"${kp.publicKey.toBase58()}"}`;
}

describe('nodeapi', () => {
  it('extracts payload bytes exactly, including braces inside strings', () => {
    const p = '{"a":"x}{\\"y","b":{"c":1}}';
    expect(rawPayload(`{"payload":  ${p},"signer":"z"}`)).toBe(p);
  });
  it('verifies a correctly signed body and rejects a tampered one or wrong domain', () => {
    const kp = Keypair.generate();
    const p = '{"node":"N","owner":"O","expires_at":0}';
    const text = signed(kp, p);
    expect(verifySignedMetadata(text, JSON.parse(text))).toBe(true);
    const tampered = text.replace('"N"', '"M"');
    expect(verifySignedMetadata(tampered, JSON.parse(tampered))).toBe(false);
    expect(verifySignedMetadata(text, JSON.parse(text), DOMAIN_PROVIDER_METADATA)).toBe(false);
  });
  it('accepts the legacy padded domain (dfe36c7 nodes) for nodes and providers', () => {
    const kp = Keypair.generate();
    const p = '{"node":"N"}';
    const node = signed(kp, p, DOMAIN_NODE_METADATA[1]);
    expect(verifySignedMetadata(node, JSON.parse(node))).toBe(true);
    const prov = signed(kp, p, DOMAIN_PROVIDER_METADATA[1]);
    expect(verifySignedMetadata(prov, JSON.parse(prov), DOMAIN_PROVIDER_METADATA)).toBe(true);
    expect(verifySignedMetadata(prov, JSON.parse(prov))).toBe(false);
  });
  // Live replies captured from test-host (dvpnd cf4c372-rc) on 2026-10-21. They expire, but the signature does not.
  it('verifies real cf4c372 node and provider metadata', () => {
    for (const [file, doms] of [['node-metadata.cf4c372.json', DOMAIN_NODE_METADATA], ['provider-metadata.cf4c372.json', DOMAIN_PROVIDER_METADATA]] as const) {
      const text = readFileSync(`tests/fixtures/${file}`, 'utf8');
      expect(verifySignedMetadata(text, JSON.parse(text), doms), file).toBe(true);
      expect(verifySignedMetadata(text, JSON.parse(text), doms === DOMAIN_NODE_METADATA ? DOMAIN_PROVIDER_METADATA : DOMAIN_NODE_METADATA), file).toBe(false);
    }
  });
});

describe('country', () => {
  it('names, continents, flags', () => {
    expect(countryName('de')).toBe('Germany');
    expect(countryName('??')).toBe('Unknown');
    expect(continentOf('US')).toBe('North America');
    expect(continentOf('ZZ')).toBe('Other');
    expect(flagEmoji('IN')).toBe('🇮🇳');
  });
});

describe('session state', () => {
  it('maps daemon status', () => {
    expect(phaseFromDaemon('active')).toBe('connected');
    expect(phaseFromDaemon('active', 'tunnel down')).toBe('reconnecting');
    expect(phaseFromDaemon('open')).toBe('connecting');
    expect(phaseFromDaemon('closed')).toBe('idle');
  });
  it('keeps Stop visible while reconnecting', () => {
    expect(viewFor('reconnecting').canStop).toBe(true);
    expect(viewFor('connected').canDisconnect).toBe(true);
  });
  it('has copy for every node and client close reason (dvpnd cf4c372)', () => {
    for (const r of ['closed by client', 'closed by operator', 'credit exhausted', 'idle', 'position closed on chain', 'close grace elapsed', 'no enforcer', 'retrying close',
      'data cap reached', 'lease not funded', 'position closing', 'replaced', 'ticket expired',
      'stopped by user', 'escrow exhausted', 'connection lost', 'node overcharging', 'service stats unavailable', 'daemon restarted', 'daemon stopping',
      'node usage unconfirmed: local counter stalled']) {
      expect(closeReasonCopy(r).message).not.toBe('The session ended.');
    }
    expect(closeReasonCopy('node usage unconfirmed: local counter stalled').message).toMatch(/losing data/);
    expect(closeReasonCopy('node overcharging').message).not.toMatch(/losing data/);
    expect(closeReasonCopy('credit exhausted').action).toMatch(/Add funds/);
    // Q0366: dvpnd's plain end after a dead path and one failed redial.
    expect(closeReasonCopy('the connection to this server stopped working')).toEqual({ message: 'The connection to this server stopped working.', action: 'Pick another server' });
  });
  it('dvpnd ledger-audit refusals get plain words, never the catch-all (port of the macOS app 53e9746, gap #73)', () => {
    const c = connectErrorCopy('StartSession: failed precondition: node settled exceeds the recorded sessions');
    expect(c.code).toBe('node-ledger');
    expect(c.message).toMatch(/Nothing more was paid/);
    for (const e of ['node claims unpaid usage', 'node usage exceeds local usage beyond tolerance', 'node ledger disagrees with the chain']) {
      expect(connectErrorCopy(`StartSession: failed precondition: ${e}`).code).toBe('node-ledger');
    }
    expect(connectErrorCopy('failed precondition: node price differs from the listing').code).toBe('node-price');
  });
  it('a local port held by another program is named, not blamed on the server (edge porttaken)', () => {
    const raw = 'StartSession: failed precondition: starting service: starting v2ray: process exited: exit status 1: Failed to start: app/proxyman/inbound: failed to listen TCP on 1080 > transport/internet: failed to listen on address: 127.0.0.1:1080 > listen tcp 127.0.0.1:1080: bind: address already in use';
    const c = connectErrorCopy(raw);
    expect(c.code).toBe('port-in-use');
    expect(c.message).toMatch(/port 1080/);
    expect(c.message).not.toMatch(/didn't come up/);
    expect(connectErrorCopy('failed precondition: stop requested while connecting: starting service: failed to listen TCP on 1080').code).toBe('cancelled');
  });
  it('a disconnect during connect says so, whatever step it interrupted (Linux edge races)', () => {
    for (const raw of [
      'StartSession: failed precondition: stop requested while connecting: open_channel: sending transaction: transaction 5UfcRe outcome unknown',
      'failed precondition: stop requested while connecting: reading node ledger: Get "https://203.0.113.1:18711/v1/ledger": context canceled',
      'failed precondition: stop requested while connecting: starting service: starting dvpn-wg-client: waiting for the first reply: context canceled',
    ]) {
      const c = connectErrorCopy(raw);
      expect(c.code, raw).toBe('cancelled');
      expect(c.message).toMatch(/because you disconnected/);
      expect(c.message).not.toMatch(/Something went wrong/);
    }
  });
  it('an intercepted RPC connection gets plain words, not the catch-all (Test Lab Pixel 8a)', () => {
    const raw = 'failed precondition: open_channel: fetching latest blockhash: transient rpc error: rpc call getLatestBlockhash() on https://api.devnet.solana.com: Post "https://api.devnet.solana.com": tls: received record with version 3 when expecting version 303';
    const c = connectErrorCopy(raw);
    expect(c.code).toBe('rpc-network');
    expect(c.message).toMatch(/Nothing was paid/);
    expect(connectErrorCopy('Post "https://x": x509: certificate signed by unknown authority').code).toBe('rpc-network');
  });
  it('a node API that refuses before any deposit is "not answering, nothing was paid" (the Linux app d590ee4b)', () => {
    const c = connectErrorCopy('fetching node metadata from https://203.0.113.1:18713: Get "https://203.0.113.1:18713/v1/metadata": dial tcp 203.0.113.1:18713: connect: connection refused');
    expect(c.code).toBe('node-offline');
    expect(c.message).toMatch(/nothing was paid/);
    expect(connectErrorCopy('fetching node metadata from https://1.2.3.4:1: context deadline exceeded').code).toBe('timeout');
  });
  it('a stalled Solana RPC is named as the RPC, not the server (the Linux app rig F5)', () => {
    const c = connectErrorCopy('fetching node account Abc: rpc call getAccountInfo() on https://api.devnet.solana.com: Post "https://api.devnet.solana.com": context deadline exceeded');
    expect(c.code).toBe('rpc-timeout');
    expect(c.message).toMatch(/nothing was paid/);
    expect(connectErrorCopy('node api: Get "https://1.2.3.4:443/": context deadline exceeded').code).toBe('timeout');
    expect(connectErrorCopy('rpc call getAccountInfo() on https://x: 429 Too Many Requests').code).toBe('rpc-busy');
  });
  it('a session already running gets plain words and a Disconnect button, not the catch-all (mx-a13)', () => {
    const c = connectErrorCopy('rpc error: code = FailedPrecondition desc = failed precondition: a session is already active');
    expect(c.code).toBe('session-active');
    expect(c.action).toBe('Disconnect');
    expect(c.message).toMatch(/Nothing was paid/);
  });
  it('names the protocol when Hysteria2 gets no answer (gap #80, mtu-a188)', () => {
    const raw = 'StartSession: failed precondition: starting service: starting hysteria2: process exited: exit status 1: client mode\nFATAL failed to initialize client {"error": "connect error: timeout: no recent network activity"}';
    const c = connectErrorCopy(raw);
    expect(c.code).toBe('tunnel-failed');
    expect(c.message).toMatch(/Hysteria2/);
    expect(c.action).toBe('Try another protocol');
    expect(connectErrorCopy('starting service: starting wireguard: handshake did not complete').message).not.toMatch(/Hysteria2 couldn't/);
  });
  it('maps node API errors and flags retryable ones', () => {
    expect(connectErrorCopy('node error: ticket_invalid').retry).toBe(true);
    // cf4c372 names (sentinel-go-sdk/api/error.go) map to the same copy and canonical code.
    for (const [alias, canon] of Object.entries(NODE_ERROR_ALIASES)) {
      expect(connectErrorCopy(`403 Forbidden: ${alias}: ticket is not valid`).code, alias).toBe(canon);
    }
    expect(connectErrorCopy('invalid_ticket: ticket is not valid').message).not.toMatch(/Something went wrong/);
    expect(connectErrorCopy('code=peer_limit_reached').code).toBe('peer_limit_reached');
    // Q0068: a refused ticket request from a device with a wrong clock says so, never "plan couldn't give access"
    expect(connectErrorCopy('403 Forbidden: ticket_request_stale: ticket request is stale').code).toBe('ticket_request_stale');
    expect(connectErrorCopy('issuing ticket: ticket request is stale').message).toMatch(/clock/);
    expect(connectErrorCopy('ticket_request_stale').retry).toBe(false);
    expect(connectErrorCopy('502 Bad Gateway: provider_unreachable: provider did not answer').code).toBe('provider_unreachable');
    expect(connectErrorCopy('ticket_request_stale: ticket request is stale: check the device clock').code).toBe('ticket_request_stale');
    expect(connectErrorCopy('403 Forbidden: invalid_ticket: ticket is not valid').code).toBe('ticket_invalid');
    expect(connectErrorCopy('HTTP 429 Too Many Requests').code).toBe('rpc-busy');
    // An out-of-credit key also answers 429, but retrying never helps (laptop 2026-10-21).
    const quota = connectErrorCopy("StartSession: failed precondition: fetching node account X: rpc call getAccountInfo() on https://devnet.helius-rpc.com status code: 429. could not decode body to rpc response: invalid character 'm' looking for beginning of value");
    expect(quota.code).toBe('rpc-quota');
    expect(quota.retry).toBe(false);
    expect(connectErrorCopy('StartSession: failed precondition: internal: internal error').code).toBe('node-error');
    expect(connectErrorCopy('weird').code).toBe('unknown');
  });
});

describe('settlement', () => {
  const base = { address: 'C', owner: 'O', node: 'N', opener: 'O', escrow: '1000', redeemed: '250', closeStartedAt: 0, rentPayer: 'O' };
  const ctx = { now: 10_000, graceSeconds: 7200, inUse: new Set<string>() };
  it('stream closes now; open voucher starts close; closing voucher waits then closes', () => {
    expect(planChannel({ ...base, mode: 1, status: 0 }, ctx).kind).toBe('close');
    expect(planChannel({ ...base, mode: 0, status: 0 }, ctx).kind).toBe('start-close');
    const w = planChannel({ ...base, mode: 0, status: 1, closeStartedAt: 5000 }, ctx);
    expect(w).toEqual({ kind: 'wait', channel: 'C', readyAt: 12_200, secondsLeft: 2200 });
    expect(planChannel({ ...base, mode: 0, status: 1, closeStartedAt: 2000 }, ctx).kind).toBe('close');
  });
  it('never touches a channel in use', () => {
    expect(planChannel({ ...base, mode: 1, status: 0 }, { ...ctx, inUse: new Set(['C']) }).kind).toBe('in-use');
  });
  it('refund + countdown', () => {
    expect(refundable({ ...base, mode: 0, status: 0 })).toBe(750n);
    expect(formatCountdown(7200)).toBe('2 h 0 min');
    expect(formatCountdown(90)).toBe('1 min');
  });
});

describe('pricing', () => {
  const node = { pricePerGb: '1500000', pricePerHour: '0' };
  it('escrow = unit price × units', () => {
    const c = costPreview(node, 'per_gb', 2);
    expect(c.escrow).toBe('3000000');
    expect(c.available).toBe(true);
    expect(costPreview(node, 'per_hour', 1).available).toBe(false);
    expect(priceLabel('0', 'per_hour')).toBe('—');
  });
  it('names the first funding blocker', () => {
    const ok = { escrow: '3000000', walletTdvpn: '9000000', userBalance: '0', delegated: '3000000', allowance: '3000000', deviceLamports: 10_000_000 };
    expect(fundingBlocker(ok)).toBeNull();
    expect(fundingBlocker({ ...ok, walletTdvpn: '1' })).toMatch(/Not enough/);
    expect(fundingBlocker({ ...ok, delegated: '1' })).toMatch(/approval/);
    expect(fundingBlocker({ ...ok, allowance: '1' })).toMatch(/spending limit/);
    expect(fundingBlocker({ ...ok, deviceLamports: 1 })).toMatch(/SOL/);
  });
});

describe('amounts', () => {
  it('uses the IDL token decimals', async () => {
    const a = await import('../../src/core/chain/amounts');
    const i = await import('../../src/core/chain/idl');
    expect(a.TOKEN_DECIMALS).toBe(i.TOKEN_DECIMALS);
  });
});

describe('keys', () => {
  it('imports keygen JSON and base58 to the same key', () => {
    const kp = Keypair.generate();
    expect(keypairFromInput(keypairToJson(kp)).publicKey.toBase58()).toBe(kp.publicKey.toBase58());
    expect(keypairFromInput(bs58.encode(kp.secretKey)).publicKey.toBase58()).toBe(kp.publicKey.toBase58());
    expect(() => keypairFromInput('one two three')).toThrow(/recovery phrase/);
  });
});

describe('connect error copy: daemon-side failures (box rig)', () => {
  it.each([
    ['StartSession: failed precondition: starting service: starting openvpn: not ready: tunnel not connected: WAIT,', 'tunnel-failed'],
    ['exec: "openvpn": executable file not found in $PATH', 'protocol-missing'],
    ['Transaction simulation failed: insufficient lamports 100, need 2000', 'device-sol'],
    ['rpc error: code = DeadlineExceeded desc = context deadline exceeded', 'timeout'],
    ['credit_exhausted', 'credit_exhausted'],
  ])('%s → %s', (raw, code) => expect(connectErrorCopy(raw).code).toBe(code));
  it('raw daemon text never reaches the copy', () => expect(connectErrorCopy('starting openvpn: not ready: tunnel not connected: WAIT').message).not.toMatch(/WAIT|openvpn/));
});

describe('plan wording', async () => {
  const { plural, formatPeriod } = await import('../../src/shared/format');
  it.each([[86400, '1 day'], [172800, '2 days'], [3600, '1 hour'], [7200, '2 hours'], [1800, '30 minutes'], [60, '1 minute'], [90000, '25 hours']])('%i s → %s', (s, w) => expect(formatPeriod(s)).toBe(w));
  it('plural', () => { expect(plural(1, 'device')).toBe('1 device'); expect(plural(2, 'device')).toBe('2 devices'); expect(plural(0, 'device')).toBe('0 devices'); });
});

// ─── A 429 after dvpnd paid a new deposit ───
describe('openedChannelOn429', () => {
  // Shape copied from the VM app log, 2026-10-21 01:18 UTC.
  const real = 'StartSession: failed precondition: fetching channel Dp67JR1mddrbRSjdehsyhHBTQJxqQciiw3VDNp4MdGbk: (*jsonrpc.RPCError)(0x2b2e14cb0ab0)({\n Code: (int) 429,\n Message: (string) (len=31) "Connection rate limits exceeded"';
  it('names the paid deposit from a rate-limited read-back', () => {
    expect(openedChannelOn429(real)).toBe('Dp67JR1mddrbRSjdehsyhHBTQJxqQciiw3VDNp4MdGbk');
  });
  it('ignores other errors and 429s with no deposit named', () => {
    expect(openedChannelOn429(real.replace('429', '500').replace('rate limits', 'thing'))).toBeNull();
    expect(openedChannelOn429('HTTP 429 Too Many Requests')).toBeNull();
    expect(openedChannelOn429('fetching channel Dp67JR1mddrbRSjdehsyhHBTQJxqQciiw3VDNp4MdGbk: account not found')).toBeNull();
  });
});
