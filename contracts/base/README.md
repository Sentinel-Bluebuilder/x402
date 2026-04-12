# BlueVpnPayment — Base Payment Contract

Solidity smart contract for AI agents to pay USDC for VPN access on Base L2.

## Contract

`BlueVpnPayment.sol` — Simple, auditable, no upgradability complexity.

### Functions

| Function | Description |
|----------|-------------|
| `pay(agentId, numHours)` | Agent pays USDC, event emitted for our backend |
| `quote(numHours)` | Returns USDC cost for given hours |
| `setPricePerHour(price)` | Owner updates pricing (admin) |
| `setPaused(bool)` | Owner pauses/unpauses contract (admin) |

### Events

```solidity
event VpnPayment(
    address indexed sender,  // who paid
    string agentId,          // agent registration ID (NOT sentinel address)
    uint256 numHours,        // hours purchased
    uint256 amount,          // USDC paid (6 decimals)
    uint256 timestamp
);
```

## Test

```bash
npm install
npx hardhat test
```

```
  BlueVpnPayment
    Deployment
      ✔ sets USDC address and price
      ✔ sets deployer as owner
    pay()
      ✔ transfers correct USDC amount to owner
      ✔ emits VpnPayment event with correct data
      ✔ reverts on 0 hours
      ✔ reverts on > 8760 hours
      ✔ reverts on empty agentId
      ✔ reverts when paused
      ✔ reverts on insufficient USDC balance
      ✔ handles max hours (8760 = 1 year)
    quote()
      ✔ returns correct cost
      ✔ returns 0 for 0 hours
    Admin
      ✔ owner can update price
      ✔ non-owner cannot update price
      ✔ owner can pause and unpause

  15 passing
```

## Deploy

```bash
# Base Sepolia (testnet)
DEPLOYER_PRIVATE_KEY=0x... npx hardhat run scripts/deploy.ts --network baseSepolia

# Base Mainnet
DEPLOYER_PRIVATE_KEY=0x... npx hardhat run scripts/deploy.ts --network base
```

## Addresses

| Network | USDC | Contract |
|---------|------|----------|
| Base Mainnet | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | TBD |
| Base Sepolia | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | TBD |

## Security

- Uses OpenZeppelin `SafeERC20` for token transfers
- Custom errors (gas efficient)
- Owner-only admin functions via `Ownable`
- Pausable in emergencies
- No upgradeability — what you see is what runs
- agentId in event, NOT sentinel address (clean chain separation)
