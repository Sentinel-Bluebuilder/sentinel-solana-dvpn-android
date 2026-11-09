import { describe, expect, it } from 'vitest';
import { lowFundsWarnings, type WalletStatus } from '../../src/core/app/wallet-status';

const base: WalletStatus = {
  owner: 'o', device: 'd', ownerLamports: 1e9, ownerTdvpn: '50000000', delegated: '50000000', userBalance: '0',
  userExists: true, userOpenChannels: 0, userRentPayer: null, grant: { allowance: '50000000', rentPayer: 'o', permissions: 788529152 },
  deviceLamports: 50_000_000, ready: true, at: 0,
};

describe('lowFundsWarnings', () => {
  it('is quiet when funded', () => expect(lowFundsWarnings(base)).toEqual([]));
  it('is quiet before setup is finished', () => expect(lowFundsWarnings({ ...base, ready: false, deviceLamports: 0 })).toEqual([]));
  it('flags each floor separately', () => {
    const keys = lowFundsWarnings({ ...base, deviceLamports: 1_000_000, ownerTdvpn: '10', grant: { allowance: '5', rentPayer: 'o', permissions: 788529152 } }).map((w) => w.key);
    expect(keys).toEqual(['device-sol', 'tdvpn', 'allowance']);
  });
  it('counts refundable balance toward tDVPN', () => expect(lowFundsWarnings({ ...base, ownerTdvpn: '0', userBalance: '2000000' })).toEqual([]));
});
