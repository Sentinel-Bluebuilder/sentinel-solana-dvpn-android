import { describe, it, expect } from 'vitest';
import { hasRealityTransport } from '../../src/core/nodes/discovery';

// Shape captured from the box xray node H84xka… /v1/metadata on 2026-10-20.
const xrayTls = {
  type: 'xray',
  payload: { inbounds: [
    { port: 18726, protocol: 'vless', security: 'tls', transport: 'ws' },
    { port: 18727, protocol: 'vmess', security: 'tls', transport: 'grpc' },
  ] },
};

describe('hasRealityTransport (F6.6)', () => {
  it('passes TLS-only V2Ray/Xray nodes and non-proxy services', () => {
    expect(hasRealityTransport(xrayTls)).toBe(false);
    expect(hasRealityTransport({ type: 'wireguard' })).toBe(false);
    expect(hasRealityTransport(null)).toBe(false);
  });

  it('hides a node with any REALITY inbound, even next to working ones', () => {
    const mixed = { ...xrayTls, payload: { inbounds: [...xrayTls.payload.inbounds, { port: 443, protocol: 'vless', security: 'reality', transport: 'tcp' }] } };
    expect(hasRealityTransport(mixed)).toBe(true);
  });
});
