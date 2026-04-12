import { MEMO_PREFIX } from '../config.js';

// ─── Solana Payment ───
// Agent sends standard SPL USDC transfer to our wallet + memo instruction.
// No custom program needed — uses existing Token Program + Memo Program.
//
// Dependencies: @solana/web3.js, @solana/spl-token
// These are optional — only loaded when chain: 'solana' is used.

export interface SolanaPaymentResult {
  txHash: string;
  amount: number;
}

export async function payOnSolana(opts: {
  walletKey: string;         // base58 secret key
  agentId: string;
  hours: number;
  operatorUsdcAta: string;   // our USDC ATA on Solana
  pricePerHourUsdc: number;  // atomic units (6 decimals)
  rpcUrl?: string;
  onProgress?: (step: string, detail: string) => void;
}): Promise<SolanaPaymentResult> {
  const progress = opts.onProgress || (() => {});

  // Dynamic imports — only loaded when Solana is used
  const { Connection, Keypair, Transaction, PublicKey } = await import('@solana/web3.js');
  const { getAssociatedTokenAddress, createTransferCheckedInstruction, getMint } = await import('@solana/spl-token');

  const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
  const MEMO_PROGRAM = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

  const rpcUrl = opts.rpcUrl || 'https://api.mainnet-beta.solana.com';
  const connection = new Connection(rpcUrl, 'confirmed');

  // 1. Load keypair
  const secretKey = Uint8Array.from(
    typeof opts.walletKey === 'string'
      ? JSON.parse(opts.walletKey) // JSON array format [1,2,3,...]
      : opts.walletKey,
  );
  const keypair = Keypair.fromSecretKey(secretKey);

  progress('wallet', `Solana wallet: ${keypair.publicKey.toBase58()}`);

  // 2. Calculate amount
  const amount = opts.hours * opts.pricePerHourUsdc;
  progress('quote', `Cost: ${amount / 1e6} USDC for ${opts.hours} hours`);

  // 3. Get ATAs
  const fromAta = await getAssociatedTokenAddress(USDC_MINT, keypair.publicKey);
  const toAta = new PublicKey(opts.operatorUsdcAta);

  // 4. Build transaction
  const tx = new Transaction();

  // Memo instruction (routing info for our backend)
  const memo = `${MEMO_PREFIX}${opts.agentId}:hours:${opts.hours}`;
  tx.add({
    keys: [{ pubkey: keypair.publicKey, isSigner: true, isWritable: false }],
    programId: MEMO_PROGRAM,
    data: Buffer.from(memo, 'utf-8'),
  });

  // USDC transfer
  tx.add(
    createTransferCheckedInstruction(
      fromAta,        // from
      USDC_MINT,      // mint
      toAta,          // to
      keypair.publicKey, // owner
      amount,         // amount (atomic)
      6,              // decimals
    ),
  );

  // 5. Send and confirm
  progress('pay', `Sending ${amount / 1e6} USDC on Solana...`);

  const { blockhash } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = keypair.publicKey;
  tx.sign(keypair);

  const txHash = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction(txHash, 'confirmed');

  progress('pay', `Payment confirmed: ${txHash}`);

  return { txHash, amount };
}
