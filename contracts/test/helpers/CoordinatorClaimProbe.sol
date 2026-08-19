// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @dev Test-only claim surface used by the coordinator's local execution-client campaign.
contract CoordinatorClaimProbe {
    mapping(bytes32 quoteId => bool claimed) public claimed;

    event Claimed(bytes32 indexed quoteId, address indexed beneficiary, uint256 payout, uint256 fee);

    function claim(bytes32 quoteId, bytes32) external {
        require(!claimed[quoteId], "already claimed");
        claimed[quoteId] = true;
        emit Claimed(quoteId, msg.sender, 1, 0);
    }
}
