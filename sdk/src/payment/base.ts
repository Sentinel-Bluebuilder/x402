import { ethers } from 'ethers';
import { BASE_RPC_URL, BASE_USDC_ADDRESS } from '../config.js';

// ─── Contract ABI (only what we call) ───

const PAYMENT_ABI = [
  'function pay(string agentId, uint256 numHours) external',
  'function quote(uint256 numHours) external view returns (uint256)',
];

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function allowance(address owner, address spender) external view returns (uint256)',
  'function balanceOf(address account) external view returns (uint256)',
];

// ─── Pay on Base ───

export interface BasePaymentResult {
  txHash: string;
  amount: bigint;
  blockNumber: number;
}

export async function payOnBase(opts: {
  walletKey: string;
  agentId: string;
  hours: number;
  contractAddress: string;
  rpcUrl?: string;
  onProgress?: (step: string, detail: string) => void;
}): Promise<BasePaymentResult> {
  const progress = opts.onProgress || (() => {});
  const rpcUrl = opts.rpcUrl || BASE_RPC_URL;

  // 1. Connect wallet
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(opts.walletKey, provider);

  const payment = new ethers.Contract(opts.contractAddress, PAYMENT_ABI, wallet);
  const usdc = new ethers.Contract(BASE_USDC_ADDRESS, ERC20_ABI, wallet);

  // 2. Get quote
  const amount: bigint = await payment.quote(opts.hours);
  progress('quote', `Cost: ${ethers.formatUnits(amount, 6)} USDC for ${opts.hours} hours`);

  // 3. Check USDC balance
  const balance: bigint = await usdc.balanceOf(wallet.address);
  if (balance < amount) {
    throw new Error(`Insufficient USDC: have ${ethers.formatUnits(balance, 6)}, need ${ethers.formatUnits(amount, 6)}`);
  }

  // 4. Approve USDC spend if needed
  const allowance: bigint = await usdc.allowance(wallet.address, opts.contractAddress);
  if (allowance < amount) {
    progress('approve', 'Approving USDC spend...');
    const approveTx = await usdc.approve(opts.contractAddress, ethers.MaxUint256);
    await approveTx.wait(1);
    progress('approve', 'USDC approved');
  }

  // 5. Pay
  progress('pay', `Paying ${ethers.formatUnits(amount, 6)} USDC...`);
  const tx = await payment.pay(opts.agentId, opts.hours);
  const receipt = await tx.wait(2); // wait for 2 confirmations

  progress('pay', `Payment confirmed: ${receipt.hash}`);

  return {
    txHash: receipt.hash,
    amount,
    blockNumber: receipt.blockNumber,
  };
}
