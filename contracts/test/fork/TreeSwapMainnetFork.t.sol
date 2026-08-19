// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {TreeSwapBitVault} from "../../src/TreeSwapBitVault.sol";
import {TreeSwapPaymentHashRegistry} from "../../src/TreeSwapPaymentHashRegistry.sol";
import {TreeSwapUserEscrow} from "../../src/TreeSwapUserEscrow.sol";
import {Mock1271Wallet, MockOpenGate, TestBase} from "../helpers/TestBase.sol";

interface ILiveBit {
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function decimals() external view returns (uint8);
    function pause() external;
    function paused() external view returns (bool);
    function symbol() external view returns (string memory);
    function transfer(address recipient, uint256 amount) external returns (bool);
    function unpause() external;
}

contract IncompatibleBitImplementation {
    function decimals() external pure returns (uint8) {
        return 8;
    }

    function paused() external pure returns (bool) {
        return false;
    }
}

/// @notice Explicit, credentialed mainnet-fork evidence. Normal unit-test runs
///         skip this file when MAINNET_RPC_URL is absent; `npm run test:fork`
///         refuses to run without that credential.
contract TreeSwapMainnetForkTest is TestBase {
    address internal constant BIT_PROXY = 0x57A447E4d5e18A9423408C365963A73F08B9d18C;
    address internal constant BIT_IMPLEMENTATION = 0xa27b118c0770939295f052aE1b003366E5eF806F;
    address internal constant BIT_ADMIN = 0x2CB5C7bd24480C9D450eD07eb49F4525ee41083a;
    address internal constant BIT_HOLDER = 0xFE0056580828C46B6A43243E386ea2234ad8f1Ca;
    address internal constant COLLECTOR = address(0xFEE);
    address internal constant BENEFICIARY = address(0xBEEF);
    uint256 internal constant FORK_BLOCK = 25_788_856;
    bytes32 internal constant IMPLEMENTATION_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    bytes32 internal constant PROXY_CODE_HASH = 0xf5648c6316e00873ef8427290251866b3675668407ecf526bf3f467578ff9adc;
    bytes32 internal constant IMPLEMENTATION_CODE_HASH =
        0x506816a3d5cf9e4f486659231f21540e9985d7fbc8438dbb385accd2e532b120;

    uint256 internal constant USER_PK = 0xA11CE;
    uint256 internal constant SOLVER_PK = 0x5107E2;

    bool internal forkReady;
    ILiveBit internal bit;
    MockOpenGate internal gate;
    TreeSwapPaymentHashRegistry internal registry;
    TreeSwapBitVault internal vault;
    TreeSwapUserEscrow internal userEscrow;
    Mock1271Wallet internal solverWallet;
    address internal user;
    address internal solver;
    uint256 internal nextNonce;

    function setUp() public {
        string memory rpcUrl = vm.envOr("MAINNET_RPC_URL", string(""));
        if (bytes(rpcUrl).length == 0) return;

        vm.createSelectFork(rpcUrl, FORK_BLOCK);
        forkReady = true;
        bit = ILiveBit(BIT_PROXY);
        gate = new MockOpenGate();
        registry = new TreeSwapPaymentHashRegistry(address(this));
        vault = new TreeSwapBitVault(BIT_PROXY, COLLECTOR, address(gate), address(registry), _vaultRisk());
        userEscrow = new TreeSwapUserEscrow(BIT_PROXY, COLLECTOR, address(gate), address(registry), _userRisk());
        registry.registerEscrow(address(vault));
        registry.registerEscrow(address(userEscrow));
        registry.seal();

        user = vm.addr(USER_PK);
        solver = vm.addr(SOLVER_PK);
        solverWallet = new Mock1271Wallet(solver);

        vm.prank(BIT_HOLDER);
        bit.transfer(address(solverWallet), 1_000 ether);
        vm.prank(BIT_HOLDER);
        bit.transfer(user, 1_000 ether);
        vm.prank(address(solverWallet));
        bit.approve(address(vault), type(uint256).max);
        vm.prank(user);
        bit.approve(address(userEscrow), type(uint256).max);
    }

    function testForkSnapshotMatchesPinnedBitState() public {
        if (!forkReady) return;

        assertEq(BIT_PROXY.codehash, PROXY_CODE_HASH, "proxy runtime changed");
        assertEq(BIT_IMPLEMENTATION.codehash, IMPLEMENTATION_CODE_HASH, "implementation runtime changed");
        bytes32 implementationWord = vm.load(BIT_PROXY, IMPLEMENTATION_SLOT);
        assertEq(address(uint160(uint256(implementationWord))), BIT_IMPLEMENTATION, "implementation slot changed");
        assertEq(uint256(bit.decimals()), 18, "BIT decimals changed");
        assertTrue(keccak256(bytes(bit.symbol())) == keccak256("BIT"), "BIT symbol changed");
        assertTrue(!bit.paused(), "BIT unexpectedly paused");
    }

    function testForkLiveBitVaultDepositReserveClaimAndRefund() public {
        if (!forkReady) return;

        _depositVault(1_000 ether);
        bytes32 claimPreimage = keccak256("fork-vault-claim");
        TreeSwapBitVault.SelectedQuote memory claimQuote =
            _vaultQuote(sha256(abi.encodePacked(claimPreimage)), 400 ether, 2 ether);
        _reserveVault(claimQuote);
        vault.claim(claimQuote.quoteId, claimPreimage);

        assertEq(bit.balanceOf(BENEFICIARY), 398 ether, "live BIT beneficiary delta mismatch");
        assertEq(bit.balanceOf(COLLECTOR), 2 ether, "live BIT fee delta mismatch");

        bytes32 refundPreimage = keccak256("fork-vault-refund");
        TreeSwapBitVault.SelectedQuote memory refundQuote =
            _vaultQuote(sha256(abi.encodePacked(refundPreimage)), 300 ether, 1 ether);
        _reserveVault(refundQuote);
        vm.warp(refundQuote.refundAfter);
        vault.refund(refundQuote.quoteId);

        assertEq(vault.availableBalance(address(solverWallet)), 600 ether, "solver refund inventory mismatch");
        assertEq(vault.totalLocked(), 0, "vault retained a live BIT liability");
        assertEq(bit.balanceOf(address(vault)), 600 ether, "vault accounting diverged from live BIT");
    }

    function testForkLiveBitUserEscrowClaimAndRefund() public {
        if (!forkReady) return;

        bytes32 claimPreimage = keccak256("fork-user-claim");
        TreeSwapUserEscrow.SolverQuote memory claimQuote =
            _userQuote(sha256(abi.encodePacked(claimPreimage)), 400 ether, 2 ether);
        _openUserEscrow(claimQuote);
        userEscrow.claim(claimQuote.quoteId, claimPreimage);

        assertEq(bit.balanceOf(solver), 398 ether, "live BIT solver delta mismatch");
        assertEq(bit.balanceOf(COLLECTOR), 2 ether, "live BIT reverse fee mismatch");

        uint256 userBeforeRefund = bit.balanceOf(user);
        bytes32 refundPreimage = keccak256("fork-user-refund");
        TreeSwapUserEscrow.SolverQuote memory refundQuote =
            _userQuote(sha256(abi.encodePacked(refundPreimage)), 300 ether, 1 ether);
        _openUserEscrow(refundQuote);
        vm.warp(refundQuote.refundAfter);
        userEscrow.refund(refundQuote.quoteId);

        assertEq(bit.balanceOf(user), userBeforeRefund, "user did not receive exact refund");
        assertEq(userEscrow.totalLocked(), 0, "user escrow retained a live BIT liability");
    }

    function testForkActualPauseBlocksExposureButExistingExitStaysAvailable() public {
        if (!forkReady) return;

        _depositVault(1_000 ether);
        bytes32 preimage = keccak256("fork-pause");
        TreeSwapBitVault.SelectedQuote memory locked = _vaultQuote(sha256(abi.encodePacked(preimage)), 400 ether, 0);
        _reserveVault(locked);

        vm.prank(BIT_ADMIN);
        bit.pause();
        assertTrue(bit.paused(), "admin pause failed on fork");

        TreeSwapBitVault.SelectedQuote memory blocked =
            _vaultQuote(sha256(abi.encodePacked(keccak256("fork-blocked"))), 300 ether, 0);
        (bytes memory blockedUserSignature, bytes memory blockedSolverSignature) = _vaultSignatures(blocked);
        vm.expectRevert(TreeSwapBitVault.UnexpectedTokenConfiguration.selector);
        vm.prank(user);
        vault.reserve(blocked, blockedUserSignature, blockedSolverSignature);

        vault.claim(locked.quoteId, preimage);
        assertEq(bit.balanceOf(BENEFICIARY), 400 ether, "BIT v1 pause unexpectedly blocked transfer exit");

        vm.prank(BIT_ADMIN);
        bit.unpause();
        assertTrue(!bit.paused(), "admin unpause failed on fork");
    }

    function testForkImplementationChangeFailsClosedForNewExposure() public {
        if (!forkReady) return;

        _depositVault(1_000 ether);
        IncompatibleBitImplementation replacement = new IncompatibleBitImplementation();
        vm.store(BIT_PROXY, IMPLEMENTATION_SLOT, bytes32(uint256(uint160(address(replacement)))));

        TreeSwapBitVault.SelectedQuote memory quote =
            _vaultQuote(sha256(abi.encodePacked(keccak256("fork-upgrade"))), 400 ether, 0);
        (bytes memory userSignature, bytes memory solverSignature) = _vaultSignatures(quote);
        vm.expectRevert(TreeSwapBitVault.UnexpectedTokenConfiguration.selector);
        vm.prank(user);
        vault.reserve(quote, userSignature, solverSignature);
    }

    function testForkSharedRegistryRejectsCrossDirectionPaymentHashReuse() public {
        if (!forkReady) return;

        _depositVault(1_000 ether);
        bytes32 paymentHash = sha256(abi.encodePacked(keccak256("fork-cross-direction")));
        TreeSwapBitVault.SelectedQuote memory vaultQuote = _vaultQuote(paymentHash, 400 ether, 0);
        _reserveVault(vaultQuote);

        TreeSwapUserEscrow.SolverQuote memory reverseQuote = _userQuote(paymentHash, 300 ether, 0);
        bytes memory signature = _solverSignature(reverseQuote);
        vm.expectRevert(TreeSwapPaymentHashRegistry.PaymentHashAlreadyUsed.selector);
        vm.prank(user);
        userEscrow.open(reverseQuote, signature);
    }

    function _depositVault(uint256 amount) internal {
        vm.prank(address(solverWallet));
        vault.deposit(amount);
    }

    function _vaultQuote(bytes32 paymentHash, uint96 amount, uint96 fee)
        internal
        returns (TreeSwapBitVault.SelectedQuote memory)
    {
        uint256 nonce = ++nextNonce;
        return TreeSwapBitVault.SelectedQuote({
            quoteId: keccak256(abi.encode("fork-vault", nonce)),
            user: user,
            solver: address(solverWallet),
            beneficiary: BENEFICIARY,
            amount: amount,
            fee: fee,
            lightningAmountSats: uint64((uint256(amount - fee) * 100) / 1 ether),
            paymentHash: paymentHash,
            invoiceDigest: keccak256(abi.encode("fork-vault-invoice", nonce)),
            nonce: nonce,
            quoteExpiresAt: uint64(block.timestamp + 5 minutes),
            lastSafeClaimAt: uint64(block.timestamp + 1 hours),
            refundAfter: uint64(block.timestamp + 1 hours + 15 minutes)
        });
    }

    function _reserveVault(TreeSwapBitVault.SelectedQuote memory quote) internal {
        (bytes memory userSignature, bytes memory solverSignature) = _vaultSignatures(quote);
        vm.prank(user);
        vault.reserve(quote, userSignature, solverSignature);
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

    function _userQuote(bytes32 paymentHash, uint96 amount, uint96 fee)
        internal
        returns (TreeSwapUserEscrow.SolverQuote memory)
    {
        uint256 nonce = ++nextNonce;
        return TreeSwapUserEscrow.SolverQuote({
            quoteId: keccak256(abi.encode("fork-user", nonce)),
            user: user,
            solver: solver,
            solverBeneficiary: solver,
            amount: amount,
            fee: fee,
            lightningAmountSats: uint64((uint256(amount - fee) * 100) / 1 ether),
            paymentHash: paymentHash,
            invoiceDigest: keccak256(abi.encode("fork-user-invoice", nonce)),
            solverNonce: nonce,
            quoteExpiresAt: uint64(block.timestamp + 5 minutes),
            lastSafeClaimAt: uint64(block.timestamp + 1 hours),
            refundAfter: uint64(block.timestamp + 1 hours + 15 minutes)
        });
    }

    function _openUserEscrow(TreeSwapUserEscrow.SolverQuote memory quote) internal {
        bytes memory signature = _solverSignature(quote);
        vm.prank(user);
        userEscrow.open(quote, signature);
    }

    function _solverSignature(TreeSwapUserEscrow.SolverQuote memory quote) internal returns (bytes memory) {
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
            maxEpochVolume: 1_200 ether
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
            maxEpochVolume: 1_200 ether
        });
    }
}
