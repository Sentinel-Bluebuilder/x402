import { ethers, network } from 'hardhat';

// USDC addresses per network
const USDC_ADDRESSES: Record<string, string> = {
  base: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  baseSepolia: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
};

async function main() {
  const networkName = network.name;
  const usdcAddress = USDC_ADDRESSES[networkName];

  if (!usdcAddress) {
    throw new Error(`No USDC address for network: ${networkName}. Use base or baseSepolia.`);
  }

  const pricePerHour = process.env.PRICE_PER_HOUR || '10000'; // 0.01 USDC default

  console.log(`Deploying BlueVpnPayment on ${networkName}`);
  console.log(`  USDC: ${usdcAddress}`);
  console.log(`  Price per hour: ${pricePerHour} (${Number(pricePerHour) / 1e6} USDC)`);

  const BlueVpnPayment = await ethers.getContractFactory('BlueVpnPayment');
  const payment = await BlueVpnPayment.deploy(usdcAddress, pricePerHour);
  await payment.waitForDeployment();

  const address = await payment.getAddress();
  console.log(`\nBlueVpnPayment deployed to: ${address}`);
  console.log(`Owner: ${await payment.owner()}`);
  console.log(`\nAdd to .env: PAYMENT_CONTRACT_ADDRESS=${address}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
