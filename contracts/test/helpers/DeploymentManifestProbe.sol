// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Test-only 2-of-3-style contract wallet surface for deployment observation.
contract DeploymentManifestWalletProbe {
    error InvalidConfiguration();
    error Unauthorized();
    error ExecutionFailed();

    address[] private owners;
    mapping(address owner => bool approved) private isOwner;
    uint256 private immutable threshold;

    constructor(address[] memory owners_, uint256 threshold_) {
        if (owners_.length < 3 || threshold_ < 2 || threshold_ > owners_.length) revert InvalidConfiguration();
        for (uint256 index = 0; index < owners_.length; index++) {
            address owner = owners_[index];
            if (owner == address(0) || isOwner[owner]) revert InvalidConfiguration();
            isOwner[owner] = true;
            owners.push(owner);
        }
        threshold = threshold_;
    }

    function getOwners() external view returns (address[] memory) {
        return owners;
    }

    function getThreshold() external view returns (uint256) {
        return threshold;
    }

    /// @dev This single-owner executor is deliberately test-only; it is not a multisig implementation.
    function execute(address target, bytes calldata data) external returns (bytes memory result) {
        if (!isOwner[msg.sender]) revert Unauthorized();
        (bool success, bytes memory returned) = target.call(data);
        if (!success) revert ExecutionFailed();
        return returned;
    }
}

/// @notice Test-only token implementation exposing the BIT runtime fields TreeSwap observes.
contract DeploymentManifestBitImplementation {
    error AlreadyInitialized();

    uint8 public decimals;
    bool public paused;
    bool private initialized;

    function initialize() external {
        if (initialized) revert AlreadyInitialized();
        initialized = true;
        decimals = 18;
    }

    function symbol() external pure returns (string memory) {
        return "BIT";
    }
}

/// @notice Test-only EIP-1967 proxy for reconstructing the external-token boundary.
contract DeploymentManifestBitProxy {
    error InvalidImplementation();
    error InitializationFailed();

    bytes32 private constant IMPLEMENTATION_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    constructor(address implementation_) {
        if (implementation_ == address(0) || implementation_.code.length == 0) revert InvalidImplementation();
        assembly {
            sstore(IMPLEMENTATION_SLOT, implementation_)
        }
        (bool success,) =
            implementation_.delegatecall(abi.encodeCall(DeploymentManifestBitImplementation.initialize, ()));
        if (!success) revert InitializationFailed();
    }

    fallback() external payable {
        assembly {
            let implementation := sload(IMPLEMENTATION_SLOT)
            calldatacopy(0, 0, calldatasize())
            let success := delegatecall(gas(), implementation, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch success
            case 0 { revert(0, returndatasize()) }
            default { return(0, returndatasize()) }
        }
    }
}
