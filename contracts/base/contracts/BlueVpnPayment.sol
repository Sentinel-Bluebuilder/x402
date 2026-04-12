// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title BlueVpnPayment
 * @notice AI agents pay USDC for time-based VPN access.
 *         Agent registers off-chain first (gets agentId), then calls pay().
 *         Our backend watches VpnPayment events and provisions Sentinel access.
 */
contract BlueVpnPayment is Ownable {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdc;
    uint256 public pricePerHour;
    bool public paused;

    event VpnPayment(
        address indexed sender,
        string agentId,
        uint256 numHours,
        uint256 amount,
        uint256 timestamp
    );

    event PriceUpdated(uint256 oldPrice, uint256 newPrice);
    event Paused(bool state);

    error InvalidHours();
    error EmptyAgentId();
    error ContractPaused();

    constructor(address _usdc, uint256 _pricePerHour) Ownable(msg.sender) {
        usdc = IERC20(_usdc);
        pricePerHour = _pricePerHour;
    }

    /**
     * @notice Pay for VPN access. Agent must have approved USDC spend first.
     * @param agentId The agent's registration ID from our API (NOT sentinel address)
     * @param numHours Number of hours to purchase (1 - 8760)
     */
    function pay(string calldata agentId, uint256 numHours) external {
        if (paused) revert ContractPaused();
        if (numHours == 0 || numHours > 8760) revert InvalidHours();
        if (bytes(agentId).length == 0) revert EmptyAgentId();

        uint256 amount = numHours * pricePerHour;
        usdc.safeTransferFrom(msg.sender, owner(), amount);

        emit VpnPayment(msg.sender, agentId, numHours, amount, block.timestamp);
    }

    /**
     * @notice Calculate cost for a given number of hours
     * @param numHours Number of hours
     * @return USDC amount in atomic units (6 decimals)
     */
    function quote(uint256 numHours) external view returns (uint256) {
        return numHours * pricePerHour;
    }

    // ─── Admin ───

    function setPricePerHour(uint256 _price) external onlyOwner {
        emit PriceUpdated(pricePerHour, _price);
        pricePerHour = _price;
    }

    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
        emit Paused(_paused);
    }
}
