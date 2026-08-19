// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {TreeSwapBitVault} from "../src/TreeSwapBitVault.sol";
import {TreeSwapPaymentHashRegistry} from "../src/TreeSwapPaymentHashRegistry.sol";
import {TreeSwapUserEscrow} from "../src/TreeSwapUserEscrow.sol";
import {MockBit, MockOpenGate, TestBase} from "./helpers/TestBase.sol";

contract TreeSwapCrossDirectionTest is TestBase {
    uint256 internal constant USER_PK = 0xA11CE;
    uint256 internal constant SOLVER_PK = 0x5107E2;
    bytes32 internal constant PREIMAGE = keccak256("cross-direction-preimage");

    MockBit internal bit;
    MockOpenGate internal gate;
    TreeSwapPaymentHashRegistry internal registry;
    TreeSwapBitVault internal vault;
    TreeSwapUserEscrow internal userEscrow;
    address internal user;
    address internal solver;

    function setUp() public {
        user = vm.addr(USER_PK);
        solver = vm.addr(SOLVER_PK);
        bit = new MockBit();
        gate = new MockOpenGate();
        registry = new TreeSwapPaymentHashRegistry(address(this));
        vault = new TreeSwapBitVault(address(bit), address(0xFEE), address(gate), address(registry), _vaultRisk());
        userEscrow = new TreeSwapUserEscrow(address(bit), address(0xFEE), address(gate), address(registry), _userRisk());
        registry.registerEscrow(address(vault));
        registry.registerEscrow(address(userEscrow));
        registry.seal();

        bit.mint(solver, 1_000 ether);
        vm.prank(solver);
        bit.approve(address(vault), type(uint256).max);
        vm.prank(solver);
        vault.deposit(1_000 ether);
        bit.mint(user, 1_000 ether);
        vm.prank(user);
        bit.approve(address(userEscrow), type(uint256).max);
    }

    function testActualEscrowsRejectHashAfterVaultConsumesIt() public {
        bytes32 paymentHash = sha256(abi.encodePacked(PREIMAGE));
        TreeSwapBitVault.SelectedQuote memory vaultQuote = _vaultQuote(paymentHash, 1);
        (bytes memory userSignature, bytes memory solverSignature) = _vaultSignatures(vaultQuote);
        vm.prank(user);
        vault.reserve(vaultQuote, userSignature, solverSignature);

        TreeSwapUserEscrow.SolverQuote memory reverseQuote = _userQuote(paymentHash, 2);
        bytes memory reverseSignature = _userEscrowSignature(reverseQuote);
        vm.expectRevert(TreeSwapPaymentHashRegistry.PaymentHashAlreadyUsed.selector);
        vm.prank(user);
        userEscrow.open(reverseQuote, reverseSignature);
    }

    function testActualEscrowsRejectHashAfterUserEscrowConsumesIt() public {
        bytes32 paymentHash = sha256(abi.encodePacked(PREIMAGE));
        TreeSwapUserEscrow.SolverQuote memory reverseQuote = _userQuote(paymentHash, 1);
        bytes memory reverseSignature = _userEscrowSignature(reverseQuote);
        vm.prank(user);
        userEscrow.open(reverseQuote, reverseSignature);

        TreeSwapBitVault.SelectedQuote memory vaultQuote = _vaultQuote(paymentHash, 2);
        (bytes memory userSignature, bytes memory solverSignature) = _vaultSignatures(vaultQuote);
        vm.expectRevert(TreeSwapPaymentHashRegistry.PaymentHashAlreadyUsed.selector);
        vm.prank(user);
        vault.reserve(vaultQuote, userSignature, solverSignature);
    }

    function _vaultQuote(bytes32 paymentHash, uint256 nonce)
        internal
        view
        returns (TreeSwapBitVault.SelectedQuote memory)
    {
        return TreeSwapBitVault.SelectedQuote({
            quoteId: keccak256(abi.encode("vault", nonce)),
            user: user,
            solver: solver,
            beneficiary: user,
            amount: 500 ether,
            fee: 0,
            lightningAmountSats: 50_000,
            paymentHash: paymentHash,
            invoiceDigest: keccak256(abi.encode("vault-invoice", nonce)),
            nonce: nonce,
            quoteExpiresAt: uint64(block.timestamp + 5 minutes),
            lastSafeClaimAt: uint64(block.timestamp + 1 hours),
            refundAfter: uint64(block.timestamp + 1 hours + 15 minutes)
        });
    }

    function _userQuote(bytes32 paymentHash, uint256 nonce)
        internal
        view
        returns (TreeSwapUserEscrow.SolverQuote memory)
    {
        return TreeSwapUserEscrow.SolverQuote({
            quoteId: keccak256(abi.encode("user", nonce)),
            user: user,
            solver: solver,
            solverBeneficiary: solver,
            amount: 500 ether,
            fee: 0,
            lightningAmountSats: 50_000,
            paymentHash: paymentHash,
            invoiceDigest: keccak256(abi.encode("user-invoice", nonce)),
            solverNonce: nonce,
            quoteExpiresAt: uint64(block.timestamp + 5 minutes),
            lastSafeClaimAt: uint64(block.timestamp + 1 hours),
            refundAfter: uint64(block.timestamp + 1 hours + 15 minutes)
        });
    }

    function _vaultSignatures(TreeSwapBitVault.SelectedQuote memory quote)
        internal
        returns (bytes memory userSignature, bytes memory solverSignature)
    {
        bytes32 digest = vault.hashSelectedQuote(quote);
        (uint8 userV, bytes32 userR, bytes32 userS) = vm.sign(USER_PK, digest);
        (uint8 solverV, bytes32 solverR, bytes32 solverS) = vm.sign(SOLVER_PK, digest);
        return (abi.encodePacked(userR, userS, userV), abi.encodePacked(solverR, solverS, solverV));
    }

    function _userEscrowSignature(TreeSwapUserEscrow.SolverQuote memory quote) internal returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SOLVER_PK, userEscrow.hashSolverQuote(quote));
        return abi.encodePacked(r, s, v);
    }

    function _vaultRisk() internal pure returns (TreeSwapBitVault.RiskConfig memory) {
        return TreeSwapBitVault.RiskConfig({
            maxFeeBps: 100,
            maxPriceDeviationBps: 1_000,
            referenceSatsPerBit: 100,
            epochDuration: 1 days,
            minSettlementWindow: 30 minutes,
            minClaimBuffer: 15 minutes,
            maxLockDuration: 2 days,
            maxSwapAmount: 600 ether,
            maxEpochVolume: 900 ether
        });
    }

    function _userRisk() internal pure returns (TreeSwapUserEscrow.RiskConfig memory) {
        return TreeSwapUserEscrow.RiskConfig({
            maxFeeBps: 100,
            maxPriceDeviationBps: 1_000,
            referenceSatsPerBit: 100,
            epochDuration: 1 days,
            minSettlementWindow: 30 minutes,
            minClaimBuffer: 15 minutes,
            maxLockDuration: 2 days,
            maxSwapAmount: 600 ether,
            maxEpochVolume: 900 ether
        });
    }
}
