// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {TreeSwapBitVault} from "../../src/TreeSwapBitVault.sol";
import {MockBit, MockOpenGate, MockPaymentHashRegistry, TestBase, Vm} from "../helpers/TestBase.sol";

contract VaultHandler {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 internal constant USER_PK = 0xA11CE;
    uint256 internal constant SOLVER_PK = 0x5107E2;

    MockBit internal immutable bit;
    TreeSwapBitVault internal immutable vault;
    address internal immutable user;
    address public immutable solver;
    bytes32[] internal quoteIds;
    bytes32[] internal preimages;
    uint256 internal sequence;
    uint256 public maxObservedEpochVolume;

    constructor(MockBit bit_, TreeSwapBitVault vault_) {
        bit = bit_;
        vault = vault_;
        user = vm.addr(USER_PK);
        solver = vm.addr(SOLVER_PK);
        vm.prank(solver);
        bit.approve(address(vault), type(uint256).max);
    }

    function deposit(uint96 rawAmount) external {
        uint256 amount = 1 + (uint256(rawAmount) % 1_000_000 ether);
        bit.mint(solver, amount);
        vm.prank(solver);
        vault.deposit(amount);
    }

    function withdraw(uint96 rawAmount) external {
        uint256 available = vault.availableBalance(solver);
        if (available == 0) return;
        uint256 amount = 1 + (uint256(rawAmount) % available);
        vm.prank(solver);
        vault.withdraw(amount, address(this));
    }

    function reserve(uint96 rawAmount, uint16 rawFeeBps, uint64 rawDelay) external {
        uint96 amount = _boundedReservationAmount(rawAmount);
        if (amount == 0) return;
        uint16 feeBps = uint16(uint256(rawFeeBps) % (uint256(vault.maxFeeBps()) + 1));
        uint96 fee = uint96((uint256(amount) * feeBps) / 10_000);
        uint256 nonce = sequence++;
        bytes32 preimage = keccak256(abi.encode(nonce, rawAmount, rawDelay));
        bytes32 hash = sha256(abi.encodePacked(preimage));
        bytes32 quoteId = keccak256(abi.encode("treeswap", nonce));
        uint64 settlementDelay = uint64(vault.minSettlementWindow()) + uint64(uint256(rawDelay) % 30 minutes);

        TreeSwapBitVault.SelectedQuote memory quote = TreeSwapBitVault.SelectedQuote({
            quoteId: quoteId,
            user: user,
            solver: solver,
            beneficiary: address(0xBEEF),
            amount: amount,
            fee: fee,
            lightningAmountSats: uint64((uint256(amount - fee) * vault.referenceSatsPerBit()) / 1 ether),
            paymentHash: hash,
            invoiceDigest: keccak256(abi.encode("invoice", quoteId)),
            nonce: nonce,
            quoteExpiresAt: uint64(block.timestamp + 5 minutes),
            lastSafeClaimAt: uint64(block.timestamp) + settlementDelay,
            refundAfter: uint64(block.timestamp) + settlementDelay + uint64(vault.minClaimBuffer())
        });
        _signAndReserve(quote);
        quoteIds.push(quoteId);
        preimages.push(preimage);
        _recordEpochVolume();
    }

    function claim(uint256 rawIndex) external {
        if (quoteIds.length == 0) return;
        uint256 index = rawIndex % quoteIds.length;
        bytes32 quoteId = quoteIds[index];
        if (vault.swapState(quoteId) != TreeSwapBitVault.SwapState.LOCKED) return;
        if (block.timestamp >= vault.swapRefundAfter(quoteId)) return;
        vault.claim(quoteId, preimages[index]);
    }

    function refund(uint256 rawIndex) external {
        if (quoteIds.length == 0) return;
        bytes32 quoteId = quoteIds[rawIndex % quoteIds.length];
        if (vault.swapState(quoteId) != TreeSwapBitVault.SwapState.LOCKED) return;
        uint64 refundAfter = vault.swapRefundAfter(quoteId);
        if (block.timestamp < refundAfter) vm.warp(refundAfter);
        vault.refund(quoteId);
    }

    function knownSwaps() external view returns (uint256) {
        return quoteIds.length;
    }

    function _boundedReservationAmount(uint96 rawAmount) internal view returns (uint96) {
        uint256 epoch = block.timestamp / vault.epochDuration();
        uint256 epochRemaining = vault.maxEpochVolume() - vault.solverEpochVolume(solver, epoch);
        uint256 limit = _min(vault.availableBalance(solver), _min(vault.maxSwapAmount(), epochRemaining));
        if (limit < 1 ether) return 0;
        return uint96(1 ether + (uint256(rawAmount) % (limit - 1 ether + 1)));
    }

    function _signAndReserve(TreeSwapBitVault.SelectedQuote memory quote) internal {
        bytes32 digest = vault.hashSelectedQuote(quote);
        (uint8 userV, bytes32 userR, bytes32 userS) = vm.sign(USER_PK, digest);
        (uint8 solverV, bytes32 solverR, bytes32 solverS) = vm.sign(SOLVER_PK, digest);
        vm.prank(user);
        vault.reserve(quote, abi.encodePacked(userR, userS, userV), abi.encodePacked(solverR, solverS, solverV));
    }

    function _recordEpochVolume() internal {
        uint256 observed = vault.solverEpochVolume(solver, block.timestamp / vault.epochDuration());
        if (observed > maxObservedEpochVolume) maxObservedEpochVolume = observed;
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
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
    MockOpenGate internal gate;
    MockPaymentHashRegistry internal hashRegistry;
    TreeSwapBitVault internal vault;
    VaultHandler internal handler;
    address[] internal targets;

    function setUp() public {
        bit = new MockBit();
        gate = new MockOpenGate();
        hashRegistry = new MockPaymentHashRegistry();
        vault = new TreeSwapBitVault(
            address(bit),
            address(0xFEE),
            address(gate),
            address(hashRegistry),
            TreeSwapBitVault.RiskConfig({
                maxFeeBps: 100,
                maxPriceDeviationBps: 1_000,
                referenceSatsPerBit: 100,
                epochDuration: 1 days,
                minSettlementWindow: 30 minutes,
                minClaimBuffer: 15 minutes,
                maxLockDuration: 2 days,
                maxSwapAmount: 1_000 ether,
                maxEpochVolume: 5_000 ether
            })
        );
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
            vault.availableBalance(handler.solver()),
            vault.totalAvailable(),
            "available inventory escaped solver account"
        );
    }

    function invariantEpochExposureNeverExceedsImmutableCap() public view {
        assertTrue(handler.maxObservedEpochVolume() <= vault.maxEpochVolume(), "epoch volume exceeded immutable cap");
    }
}
