// ─── Restore default settings: preferences reset, favourites + RPC endpoints kept ───
import { describe, expect, it, vi } from 'vitest';

const store = new Map<string, unknown>();
vi.mock('../../src/main/store', () => ({
  readJson: (f: string, d: unknown) => (store.has(f) ? store.get(f) : d),
  writeJson: (f: string, v: unknown) => { store.set(f, v); },
}));
vi.mock('../../src/core/chain/rpc', () => ({ setRpcUrls: () => undefined, isValidRpcUrl: (u: string) => u.startsWith('https://') }));

describe('resetSettings', () => {
  it('resets every preference except favourites and RPC endpoints', async () => {
    const { RESET_KEYS, resetSettings, updateSettings } = await import('../../src/main/system/settings');
    const { DEFAULT_SETTINGS } = await import('../../src/shared/types');
    updateSettings({ defaultBasis: 'per_hour', theme: 'dark', favourites: ['8sV25KKBRbYD9kEXVAYX2wmVwEzaSsBtfA8G8LvfTdib'], rpcUrls: ['https://rpc.example.com/?key=x'] });
    const s = resetSettings();
    expect(s.defaultBasis).toBe(DEFAULT_SETTINGS.defaultBasis);
    expect(s.theme).toBe(DEFAULT_SETTINGS.theme);
    expect(s.favourites).toEqual(['8sV25KKBRbYD9kEXVAYX2wmVwEzaSsBtfA8G8LvfTdib']);
    expect(s.rpcUrls).toEqual(['https://rpc.example.com/?key=x']);
    expect(RESET_KEYS).not.toContain('favourites');
    expect(RESET_KEYS).not.toContain('rpcUrls');
    expect(RESET_KEYS).toContain('poll');
  });
});
