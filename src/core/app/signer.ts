// ─── Owner signer (decision D10) ───
// Two modes behind one shape:
//   in-app   owner key held in main, encrypted at rest with safeStorage
//   browser  unsigned tx handed to a wallet extension through a loopback page,
//            signed tx relayed back and checked with assertRelayable
import { Keypair, type PublicKey, type TransactionInstruction, type VersionedTransaction } from '@solana/web3.js';
import { buildTx, sendSigned, serialised, assertRelayable, type TxResult, type BuiltTx } from '../chain/tx';

export interface OwnerSigner {
  readonly publicKey: PublicKey;
  readonly kind: 'in-app' | 'browser';
  signTransaction(tx: VersionedTransaction, built: BuiltTx): Promise<VersionedTransaction>;
}

export function keypairSigner(kp: Keypair): OwnerSigner {
  return {
    publicKey: kp.publicKey,
    kind: 'in-app',
    async signTransaction(tx) {
      tx.sign([kp]);
      return tx;
    },
  };
}

/** Simulate → sign (in-app or browser) → send → confirm, serialised per app. */
export async function signAndSend(signer: OwnerSigner, ixs: TransactionInstruction[], label: string): Promise<TxResult & { label: string }> {
  return serialised(async () => {
    const built = await buildTx(ixs, signer.publicKey, { label });
    const signed = await signer.signTransaction(built.tx, built);
    if (signer.kind === 'browser') assertRelayable(signed, signer.publicKey);
    const res = await sendSigned(signed, { lastValidBlockHeight: built.lastValidBlockHeight, label });
    return { ...res, label };
  });
}
