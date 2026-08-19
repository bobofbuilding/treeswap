// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {TreeSwapBitVault} from "../../src/TreeSwapBitVault.sol";
import {MockBit, TestBase, Vm} from "../helpers/TestBase.sol";

contract VaultHandler {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    MockBit internal immutable bit;
    TreeSwapBitVault internal immutable vault;
    bytes32[] internal swapIds;
    bytes32[] internal preimages;
    uint256 internal sequence;

    constructor(MockBit bit_, TreeSwapBitVault vault_) {
        bit = bit_;
        vault = vault_;
        bit.approve(address(vault), type(uint256).max);
    }

    function deposit(uint96 rawAmount) external {
        uint256 amount = 1 + (uint256(rawAmount) % 1_000_000 ether);
        bit.mint(address(this), amount);
        vault.deposit(amount);
    }

    function withdraw(uint96 rawAmount) external {
        uint256 available = vault.availableBalance(address(this));
        if (available == 0) return;
        uint256 amount = 1 + (uint256(rawAmount) % available);
        vault.withdraw(amount, address(this));
    }

    function reserve(uint96 rawAmount, uint16 rawFeeBps, uint64 rawDelay) external {
        uint256 available = vault.availableBalance(address(this));
        if (available < 2) return;

        uint256 bounded = 2 + (uint256(rawAmount) % (available - 1));
        if (bounded > type(uint96).max) bounded = type(uint96).max;
        uint96 amount = uint96(bounded);
        uint16 feeBps = uint16(uint256(rawFeeBps) % 101);
        uint96 fee = uint96((uint256(amount) * feeBps) / 10_000);
        bytes32 preimage = keccak256(abi.encode(sequence, rawAmount, rawDelay));
        bytes32 hash = sha256(abi.encodePacked(preimage));
        bytes32 swapId = keccak256(abi.encode("treeswap", sequence++));
        uint64 delay = uint64(1 + (uint256(rawDelay) % 30 days));

        vault.reserve(swapId, hash, address(0xBEEF), amount, fee, uint64(block.timestamp) + delay);
        swapIds.push(swapId);
        preimages.push(preimage);
    }

    function claim(uint256 rawIndex) external {
        if (swapIds.length == 0) return;
        uint256 index = rawIndex % swapIds.length;
        bytes32 swapId = swapIds[index];
        (,,,,,, TreeSwapBitVault.SwapState state) = vault.swaps(swapId);
        if (state != TreeSwapBitVault.SwapState.LOCKED) return;
        vault.claim(swapId, preimages[index]);
    }

    function refund(uint256 rawIndex) external {
        if (swapIds.length == 0) return;
        bytes32 swapId = swapIds[rawIndex % swapIds.length];
        (,,,, uint64 refundAfter,, TreeSwapBitVault.SwapState state) = vault.swaps(swapId);
        if (state != TreeSwapBitVault.SwapState.LOCKED) return;
        vm.warp(refundAfter);
        vault.refund(swapId);
    }

    function knownSwaps() external view returns (uint256) {
        return swapIds.length;
    }
}

contract TreeSwapBitVaultInvariantTest is TestBase {
    struct FuzzSelector {
        address addr;
        bytes4[] selectors;
    }

    struct FuzzArtifactSelector {
        string artifact;
        bytes4[] selectors;
    }

    struct FuzzInterface {
        address addr;
        string[] artifacts;
    }

    MockBit internal bit;
    TreeSwapBitVault internal vault;
    VaultHandler internal handler;
    address[] internal targets;

    function setUp() public {
        bit = new MockBit();
        vault = new TreeSwapBitVault(address(bit), address(0xFEE), 100);
        handler = new VaultHandler(bit, vault);
        targets.push(address(handler));
    }

    function targetContracts() external view returns (address[] memory) {
        return targets;
    }

    function excludeContracts() external pure returns (address[] memory values) {}
    function targetSenders() external pure returns (address[] memory values) {}
    function excludeSenders() external pure returns (address[] memory values) {}
    function targetArtifacts() external pure returns (string[] memory values) {}
    function excludeArtifacts() external pure returns (string[] memory values) {}
    function targetSelectors() external pure returns (FuzzSelector[] memory values) {}
    function excludeSelectors() external pure returns (FuzzSelector[] memory values) {}
    function targetArtifactSelectors() external pure returns (FuzzArtifactSelector[] memory values) {}
    function targetInterfaces() external pure returns (FuzzInterface[] memory values) {}

    function invariantTokenBalanceEqualsAccountedLiabilities() public view {
        assertEq(
            bit.balanceOf(address(vault)),
            vault.totalAvailable() + vault.totalLocked(),
            "token balance diverged from liabilities"
        );
    }

    function invariantHandlerOwnsAllAvailableInventory() public view {
        assertEq(
            vault.availableBalance(address(handler)),
            vault.totalAvailable(),
            "available inventory escaped solver account"
        );
    }
}
