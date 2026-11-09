import { describe, expect, it } from 'vitest';
import { hostOf } from '../../src/main/scheduler';

describe('hostOf', () => {
  it('reads an IPv4 node uri', () => expect(hostOf('https://203.0.113.1:18711')).toBe('203.0.113.1'));
  it('ignores names and junk', () => {
    expect(hostOf('https://node.example.com:443')).toBeNull();
    expect(hostOf('')).toBeNull();
  });
});
