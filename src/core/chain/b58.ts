// ─── base58 with CJS/ESM interop ───
// bs58@6 ships ESM with a default export; bundled to CommonJS (CLI, Electron main)
// the default lands on `.default`, under vitest it is the module itself.
import * as bs58ns from 'bs58';

type Codec = { encode(b: Uint8Array): string; decode(s: string): Uint8Array };
const mod = bs58ns as unknown as Codec & { default?: Codec & { default?: Codec } };
const codec: Codec = typeof mod.encode === 'function' ? mod : (mod.default?.default ?? mod.default)!;

export const b58encode = (b: Uint8Array): string => codec.encode(b);
export const b58decode = (s: string): Uint8Array => codec.decode(s);
