import { expect } from 'chai';
import { ethers } from 'hardhat';
import { loadFixture } from '@nomicfoundation/hardhat-toolbox/network-helpers';

describe('BlueVpnPayment', function () {
  const PRICE_PER_HOUR = 10_000n; // 0.01 USDC (6 decimals)
  const INITIAL_BALANCE = 1_000_000_000n; // 1000 USDC

  async function deployFixture() {
    const [owner, agent, other] = await ethers.getSigners();

    // Deploy mock USDC
    const MockERC20 = await ethers.getContractFactory('MockERC20');
    const usdc = await MockERC20.deploy('USD Coin', 'USDC', 6);

    // Deploy payment contract
    const BlueVpnPayment = await ethers.getContractFactory('BlueVpnPayment');
    const payment = await BlueVpnPayment.deploy(await usdc.getAddress(), PRICE_PER_HOUR);

    // Fund agent with USDC
    await usdc.mint(agent.address, INITIAL_BALANCE);

    // Agent approves payment contract
    await usdc.connect(agent).approve(await payment.getAddress(), ethers.MaxUint256);

    return { payment, usdc, owner, agent, other };
  }

  describe('Deployment', function () {
    it('sets USDC address and price', async function () {
      const { payment, usdc } = await loadFixture(deployFixture);
      expect(await payment.usdc()).to.equal(await usdc.getAddress());
      expect(await payment.pricePerHour()).to.equal(PRICE_PER_HOUR);
    });

    it('sets deployer as owner', async function () {
      const { payment, owner } = await loadFixture(deployFixture);
      expect(await payment.owner()).to.equal(owner.address);
    });
  });

  describe('pay()', function () {
    it('transfers correct USDC amount to owner', async function () {
      const { payment, usdc, owner, agent } = await loadFixture(deployFixture);

      const hours = 720n; // 30 days
      const expectedCost = hours * PRICE_PER_HOUR; // 7,200,000 = 7.20 USDC

      const ownerBefore = await usdc.balanceOf(owner.address);
      await payment.connect(agent).pay('agent-123', hours);
      const ownerAfter = await usdc.balanceOf(owner.address);

      expect(ownerAfter - ownerBefore).to.equal(expectedCost);
    });

    it('emits VpnPayment event with correct data', async function () {
      const { payment, agent } = await loadFixture(deployFixture);

      const hours = 24n;
      const expectedAmount = hours * PRICE_PER_HOUR;

      await expect(payment.connect(agent).pay('agent-456', hours))
        .to.emit(payment, 'VpnPayment')
        .withArgs(
          agent.address,
          'agent-456',
          hours,
          expectedAmount,
          (v: bigint) => v > 0n, // timestamp
        );
    });

    it('reverts on 0 hours', async function () {
      const { payment, agent } = await loadFixture(deployFixture);
      await expect(payment.connect(agent).pay('agent-1', 0)).to.be.revertedWithCustomError(payment, 'InvalidHours');
    });

    it('reverts on > 8760 hours', async function () {
      const { payment, agent } = await loadFixture(deployFixture);
      await expect(payment.connect(agent).pay('agent-1', 8761)).to.be.revertedWithCustomError(payment, 'InvalidHours');
    });

    it('reverts on empty agentId', async function () {
      const { payment, agent } = await loadFixture(deployFixture);
      await expect(payment.connect(agent).pay('', 1)).to.be.revertedWithCustomError(payment, 'EmptyAgentId');
    });

    it('reverts when paused', async function () {
      const { payment, agent } = await loadFixture(deployFixture);
      await payment.setPaused(true);
      await expect(payment.connect(agent).pay('agent-1', 1)).to.be.revertedWithCustomError(payment, 'ContractPaused');
    });

    it('reverts on insufficient USDC balance', async function () {
      const { payment, other } = await loadFixture(deployFixture);
      // other has no USDC
      await expect(payment.connect(other).pay('agent-1', 1)).to.be.reverted;
    });

    it('handles max hours (8760 = 1 year)', async function () {
      const { payment, usdc, agent } = await loadFixture(deployFixture);
      // 8760 * 10000 = 87,600,000 = 87.60 USDC — agent has 1000
      await expect(payment.connect(agent).pay('agent-max', 8760)).to.emit(payment, 'VpnPayment');
    });
  });

  describe('quote()', function () {
    it('returns correct cost', async function () {
      const { payment } = await loadFixture(deployFixture);
      expect(await payment.quote(720)).to.equal(720n * PRICE_PER_HOUR);
    });

    it('returns 0 for 0 hours', async function () {
      const { payment } = await loadFixture(deployFixture);
      expect(await payment.quote(0)).to.equal(0n);
    });
  });

  describe('Admin', function () {
    it('owner can update price', async function () {
      const { payment } = await loadFixture(deployFixture);
      const newPrice = 20_000n;
      await expect(payment.setPricePerHour(newPrice))
        .to.emit(payment, 'PriceUpdated')
        .withArgs(PRICE_PER_HOUR, newPrice);
      expect(await payment.pricePerHour()).to.equal(newPrice);
    });

    it('non-owner cannot update price', async function () {
      const { payment, agent } = await loadFixture(deployFixture);
      await expect(payment.connect(agent).setPricePerHour(1)).to.be.revertedWithCustomError(payment, 'OwnableUnauthorizedAccount');
    });

    it('owner can pause and unpause', async function () {
      const { payment } = await loadFixture(deployFixture);
      await payment.setPaused(true);
      expect(await payment.paused()).to.be.true;
      await payment.setPaused(false);
      expect(await payment.paused()).to.be.false;
    });
  });
});
