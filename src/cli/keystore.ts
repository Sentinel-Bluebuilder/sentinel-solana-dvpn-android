// ─── CLI key store ───
// DVPN_KEYFILE (or --keyfile) points at a solana-keygen JSON that is used in
// place and never copied — how tests use the devnet wallet. Otherwise the key is
// kept in <data>/wallet.cli.dpapi, protected with Windows DPAPI (current user)
// through PowerShell, so a CLI-imported key is not left in plain text. On Android the key is
// sealed by the app with an Android Keystore key (<data>/wallet.cli.keystore, ciphertext only).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Keypair } from '@solana/web3.js';
import { keypairFromInput, keypairToJson } from '../core/wallet/keys';
import type { KeyStore } from '../main/host';
import { isAndroid, sealSync, unsealSync } from '../main/platform/android-bridge';

function dpapi(mode: 'protect' | 'unprotect', b64: string): string {
  const op = mode === 'protect' ? 'Protect' : 'Unprotect';
  const script = `Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); $o=[System.Security.Cryptography.ProtectedData]::${op}($b,$null,'CurrentUser'); [Convert]::ToBase64String($o)`;
  try {
    // stderr piped, not inherited: by default execFileSync also copies it to our console, so the
    // raw "Exception calling Protect" printed above the plain message (cli191 test-host).
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { input: b64, encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    // A logon without a password (SSH key login, some service accounts) has no DPAPI user
    // key: Windows answers "Access is denied" (clean-VM run 2026-10-20).
    if (/Access is denied/i.test(String((err as { stderr?: unknown }).stderr ?? (err as Error).message))) {
      throw new Error('Windows cannot encrypt a wallet for this logon (no password session, e.g. an SSH key login). Use a key file instead: --keyfile <path> or DVPN_KEYFILE.');
    }
    throw new Error(`Windows wallet encryption failed: ${(err as Error).message.split('\n')[0]}`);
  }
}

export function cliKeyStore(dataDir: string, keyfile?: string): KeyStore {
  if (keyfile) {
    return {
      kind: 'keyfile',
      exists: () => fs.existsSync(keyfile),
      load: (): Keypair | null => (fs.existsSync(keyfile) ? keypairFromInput(fs.readFileSync(keyfile, 'utf8')) : null),
      save() { throw new Error('A --keyfile wallet is read-only. Unset DVPN_KEYFILE to import or create a wallet.'); },
      remove() { throw new Error('A --keyfile wallet is never deleted by this CLI.'); },
    };
  }
  if (isAndroid()) return androidKeyStore(dataDir);
  const file = path.join(dataDir, 'wallet.cli.dpapi');
  return {
    // Not 'keyfile': vault.ts skips its "never replace a wallet" check only for a read-only key
    // file, and this store CAN be overwritten (VM sweep 2026-10-21: a second `wallet create
    // --yes` replaced the first wallet).
    kind: 'dpapi',
    exists: () => fs.existsSync(file),
    load(): Keypair | null {
      if (!fs.existsSync(file)) return null;
      const json = Buffer.from(dpapi('unprotect', fs.readFileSync(file, 'utf8')), 'base64').toString('utf8');
      return keypairFromInput(json);
    },
    save(kp) {
      fs.writeFileSync(file, dpapi('protect', Buffer.from(keypairToJson(kp), 'utf8').toString('base64')), 'utf8');
    },
    remove() {
      fs.rmSync(file, { force: true });
    },
  };
}

function androidKeyStore(dataDir: string): KeyStore {
  const file = path.join(dataDir, 'wallet.cli.keystore');
  return {
    kind: 'keystore',
    exists: () => fs.existsSync(file),
    load(): Keypair | null {
      if (!fs.existsSync(file)) return null;
      return keypairFromInput(unsealSync(fs.readFileSync(file, 'utf8').trim()).toString('utf8'));
    },
    save(kp) {
      const json = keypairToJson(kp);
      const sealed = sealSync(Buffer.from(json, 'utf8'));
      // Read it back before saying it is saved.
      if (unsealSync(sealed).toString('utf8') !== json) throw new Error('Android Keystore did not return the wallet it sealed. Nothing was saved.');
      fs.writeFileSync(file, `${sealed}\n`, { encoding: 'utf8', mode: 0o600 });
    },
    remove() {
      fs.rmSync(file, { force: true });
    },
  };
}
