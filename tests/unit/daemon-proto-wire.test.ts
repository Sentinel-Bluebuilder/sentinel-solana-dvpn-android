// ─── The app's daemon.proto puts every credential on the wire (cb33 rename) ───
// cb33 renamed Credential.ticket to ticket_request (same field number 3). proto-loader drops an object key
// the proto does not name, without an error, so a stale key would start a plan session with no ticket.
// Encode real StartSession requests with the app's proto and check the credential reaches the bytes.
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import * as protoLoader from '@grpc/proto-loader';
import type { Credential } from '../../src/core/daemon/client';

const def = protoLoader.loadSync(path.join(__dirname, '../../resources/daemon.proto'), { keepCase: false, longs: String, enums: String, defaults: true, oneofs: true });
const start = (def['sentinel.daemon.v1.ClientService'] as Record<string, protoLoader.MethodDefinition<object, object>>).StartSession;
const wire = (credential: Credential | Record<string, unknown>): string => start.requestSerialize({ node: 'Node1', credential }).toString('latin1');

describe('StartSession credential on the wire', () => {
  it('a plan ticket request carries its provider and subscription', () => {
    const cred: Credential = { ticketRequest: { provider: 'Prov1111', subscription: 'Sub22222' } };
    const b = wire(cred);
    expect(b).toContain('Prov1111');
    expect(b).toContain('Sub22222');
  });
  it('the pre-cb33 key name is not in the proto (it would be dropped silently)', () => {
    expect(wire({ ticket: { provider: 'Prov1111', subscription: 'Sub22222' } })).not.toContain('Prov1111');
  });
  it('channel, new channel and held ticket credentials carry their values', () => {
    expect(wire({ channel: 'Chan3333' })).toContain('Chan3333');
    expect(wire({ ticketHash: 'Hash4444' })).toContain('Hash4444');
    expect(wire({ newChannel: { mode: 1, escrow: '5000000' } }).length).toBeGreaterThan(wire({}).length);
  });
});
