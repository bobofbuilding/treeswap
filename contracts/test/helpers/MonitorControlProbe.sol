// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Test-only contract caller for exercising TreeSwapOpenGate roles.
contract MonitorControlProbe {
    error Unauthorized();
    error ExecutionFailed();

    address public immutable owner;

    constructor(address owner_) {
        owner = owner_;
    }

    function execute(address target, bytes calldata data) external returns (bytes memory result) {
        if (msg.sender != owner) revert Unauthorized();
        (bool success, bytes memory returned) = target.call(data);
        if (!success) revert ExecutionFailed();
        return returned;
    }
}
