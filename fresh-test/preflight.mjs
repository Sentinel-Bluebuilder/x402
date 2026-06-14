// ─── Preflight: operator balances + live server reachability ───
import { readFileSync } from 'fs';
import { createPublicClient, http, formatUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const SERVER = process.env.SERVER_URL || 'https://x402.sentinel.co';

const env = Object.fromEntries(
  readFileSync('C:/Users/Connect/Desktop/x402/wallets.env', 'utf8')
    .split('\n').filter((l) => l && !l.trim().startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);

const op = privateKeyToAccount(env.PRIMARY_OPERATOR_KEY);
const pub = createPublicClient({ chain: base, transport: http('https://mainnet.base.org') });
const [eth, usdc] = await Promise.all([
  pub.getBalance({ address: op.address }),
  pub.readContract({
    address: USDC,
    abi: [{ name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: '', type: 'address' }], outputs: [{ type: 'uint256' }] }],
    functionName: 'balanceOf',
    args: [op.address],
  }),
]);
console.log(`operator: ${op.address}`);
console.log(`  ETH:  ${formatUnits(eth, 18)}`);
console.log(`  USDC: ${formatUnits(usdc, 6)}`);
console.log(`  match 0xCC689D: ${op.address.toLowerCase().startsWith('0xcc689d')}`);
console.log(`server: ${SERVER}`);

for (const path of ['/health', '/pricing', '/nodes']) {
  try {
    const r = await fetch(SERVER + path, { signal: AbortSignal.timeout(15000) });
    const t = await r.text();
    console.log(`GET ${path} -> ${r.status} len=${t.length} ${t.slice(0, 100).replace(/\s+/g, ' ')}`);
  } catch (e) {
    console.log(`GET ${path} -> ERR ${e.message}`);
  }
}
