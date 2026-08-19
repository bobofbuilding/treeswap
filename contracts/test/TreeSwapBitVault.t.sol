// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {TreeSwapBitVault} from "../src/TreeSwapBitVault.sol";
import {Mock1271Wallet, MockBit, MockOpenGate, MockPaymentHashRegistry, TestBase} from "./helpers/TestBase.sol";

contract TreeSwapBitVaultTest is TestBase {
    MockBit internal bit;
    MockOpenGate internal gate;
    MockPaymentHashRegistry internal hashRegistry;
    TreeSwapBitVault internal vault;

    uint256 internal constant USER_PK = 0xA11CE;
    uint256 internal constant SOLVER_PK = 0x5107E2;
    address internal user;
    address internal solver;
    address internal constant BENEFICIARY = address(0xBEEF);
    address internal constant ATTACKER = address(0xBAD);
    address internal constant COLLECTOR = address(0xFEE);

    bytes32 internal constant PREIMAGE = keccak256("treeswap-preimage");
    bytes32 internal paymentHash;
    uint256 internal nextNonce;

    function setUp() public {
        user = vm.addr(USER_PK);
        solver = vm.addr(SOLVER_PK);
        bit = new MockBit();
        gate = new MockOpenGate();
        hashRegistry = new MockPaymentHashRegistry();
        vault = new TreeSwapBitVault(address(bit), COLLECTOR, address(gate), address(hashRegistry), _riskConfig());
        paymentHash = sha256(abi.encodePacked(PREIMAGE));
        bit.mint(solver, 10_000 ether);
        vm.prank(solver);
        bit.approve(address(vault), type(uint256).max);
    }

    function testDepositAndWithdrawOnlyAvailableInventory() public {
        _deposit(vault, 1_000 ether);
        vm.prank(solver);
        vault.withdraw(250 ether, solver);

        assertEq(vault.availableBalance(solver), 750 ether, "available mismatch");
        assertEq(vault.totalAvailable(), 750 ether, "total available mismatch");
        assertEq(bit.balanceOf(address(vault)), 750 ether, "vault balance mismatch");
    }

    function testReserveAndClaimPaysOnlyBoundBeneficiary() public {
        _deposit(vault, 1_000 ether);
        TreeSwapBitVault.SelectedQuote memory quote =
            _reserve(vault, keccak256("quote-1"), paymentHash, BENEFICIARY, 500 ether, 2 ether);

        vm.prank(ATTACKER);
        vault.claim(quote.quoteId, PREIMAGE);

        assertEq(bit.balanceOf(BENEFICIARY), 498 ether, "beneficiary payout mismatch");
        assertEq(bit.balanceOf(ATTACKER), 0, "relayer redirected payout");
        assertEq(bit.balanceOf(COLLECTOR), 2 ether, "fee mismatch");
        assertEq(vault.totalLocked(), 0, "locked balance remains");
    }

    function testSignedQuoteCannotChangeBeneficiary() public {
        _deposit(vault, 1_000 ether);
        TreeSwapBitVault.SelectedQuote memory quote =
            _quote(keccak256("quote-signed"), paymentHash, BENEFICIARY, 500 ether, 2 ether, nextNonce++);
        bytes memory signature = _signUser(vault, quote);
        quote.beneficiary = ATTACKER;
        bytes memory solverSignature = _signSolver(vault, quote);

        vm.expectRevert(TreeSwapBitVault.InvalidSignature.selector);
        vm.prank(user);
        vault.reserve(quote, signature, solverSignature);
    }

    function testQuoteSignatureCannotReplayOnAnotherVault() public {
        MockPaymentHashRegistry secondRegistry = new MockPaymentHashRegistry();
        TreeSwapBitVault secondVault =
            new TreeSwapBitVault(address(bit), COLLECTOR, address(gate), address(secondRegistry), _riskConfig());
        vm.prank(solver);
        bit.approve(address(secondVault), type(uint256).max);
        _deposit(secondVault, 1_000 ether);

        TreeSwapBitVault.SelectedQuote memory quote =
            _quote(keccak256("domain-replay"), paymentHash, BENEFICIARY, 500 ether, 0, nextNonce++);
        bytes memory wrongDomainUserSignature = _signUser(vault, quote);
        bytes memory wrongDomainSolverSignature = _signSolver(vault, quote);

        vm.expectRevert(TreeSwapBitVault.InvalidSignature.selector);
        vm.prank(user);
        secondVault.reserve(quote, wrongDomainUserSignature, wrongDomainSolverSignature);
    }

    function testQuoteSignatureCannotReplayOnAnotherChain() public {
        _deposit(vault, 1_000 ether);
        TreeSwapBitVault.SelectedQuote memory quote =
            _quote(keccak256("chain-replay"), paymentHash, BENEFICIARY, 500 ether, 0, nextNonce++);
        bytes memory wrongChainUserSignature = _signUser(vault, quote);
        bytes memory wrongChainSolverSignature = _signSolver(vault, quote);
        vm.chainId(block.chainid + 1);

        vm.expectRevert(TreeSwapBitVault.InvalidSignature.selector);
        vm.prank(user);
        vault.reserve(quote, wrongChainUserSignature, wrongChainSolverSignature);
    }

    function testMalformedSignatureCannotReserve() public {
        _deposit(vault, 1_000 ether);
        TreeSwapBitVault.SelectedQuote memory quote =
            _quote(keccak256("malformed-signature"), paymentHash, BENEFICIARY, 500 ether, 0, nextNonce++);
        bytes memory solverSignature = _signSolver(vault, quote);

        vm.expectRevert(TreeSwapBitVault.InvalidSignature.selector);
        vm.prank(user);
        vault.reserve(quote, hex"1234", solverSignature);
    }

    function testEip1271UserCanAuthorizeExactSelectedQuote() public {
        Mock1271Wallet wallet = new Mock1271Wallet(user);
        _deposit(vault, 1_000 ether);
        TreeSwapBitVault.SelectedQuote memory quote =
            _quote(keccak256("contract-user"), paymentHash, BENEFICIARY, 500 ether, 0, nextNonce++);
        quote.user = address(wallet);
        bytes memory signature = _signUser(vault, quote);
        bytes memory solverSignature = _signSolver(vault, quote);

        vm.prank(address(wallet));
        vault.reserve(quote, signature, solverSignature);
        assertEq(
            uint256(vault.swapState(quote.quoteId)), uint256(TreeSwapBitVault.SwapState.LOCKED), "1271 reserve failed"
        );
    }

    function testEip1271UserRejectsWrongOwnerSignature() public {
        Mock1271Wallet wallet = new Mock1271Wallet(ATTACKER);
        _deposit(vault, 1_000 ether);
        TreeSwapBitVault.SelectedQuote memory quote =
            _quote(keccak256("contract-user-wrong"), paymentHash, BENEFICIARY, 500 ether, 0, nextNonce++);
        quote.user = address(wallet);

        _expectReserveRevert(vault, quote, TreeSwapBitVault.InvalidSignature.selector);
    }

    function testEip1271SolverCanCommitPrefundedInventory() public {
        Mock1271Wallet wallet = new Mock1271Wallet(solver);
        bit.mint(address(wallet), 1_000 ether);
        vm.prank(address(wallet));
        bit.approve(address(vault), type(uint256).max);
        vm.prank(address(wallet));
        vault.deposit(1_000 ether);

        TreeSwapBitVault.SelectedQuote memory quote =
            _quote(keccak256("contract-solver"), paymentHash, BENEFICIARY, 500 ether, 0, nextNonce++);
        quote.solver = address(wallet);
        bytes memory userSignature = _signUser(vault, quote);
        bytes memory solverSignature = _signSolver(vault, quote);

        vm.prank(user);
        vault.reserve(quote, userSignature, solverSignature);
        assertEq(vault.availableBalance(address(wallet)), 500 ether, "1271 solver inventory not reserved");
    }

    function testOnlyNamedUserCanExerciseFirmQuote() public {
        _deposit(vault, 1_000 ether);
        TreeSwapBitVault.SelectedQuote memory quote =
            _quote(keccak256("user-exercise"), paymentHash, BENEFICIARY, 500 ether, 0, nextNonce++);
        bytes memory userSignature = _signUser(vault, quote);
        bytes memory solverSignature = _signSolver(vault, quote);

        vm.expectRevert(TreeSwapBitVault.InvalidUser.selector);
        vm.prank(ATTACKER);
        vault.reserve(quote, userSignature, solverSignature);
    }

    function testFirmQuoteCannotUseSolverInventoryWithoutSolverSignature() public {
        _deposit(vault, 1_000 ether);
        TreeSwapBitVault.SelectedQuote memory quote =
            _quote(keccak256("solver-commitment"), paymentHash, BENEFICIARY, 500 ether, 0, nextNonce++);
        bytes memory userSignature = _signUser(vault, quote);

        vm.expectRevert(TreeSwapBitVault.InvalidSignature.selector);
        vm.prank(user);
        vault.reserve(quote, userSignature, hex"1234");
    }

    function testOneActiveReservationPerUserAndSlotReopensAfterTerminalState() public {
        _deposit(vault, 1_000 ether);
        TreeSwapBitVault.SelectedQuote memory first =
            _reserve(vault, keccak256("active-1"), paymentHash, BENEFICIARY, 400 ether, 0);
        TreeSwapBitVault.SelectedQuote memory second = _quote(
            keccak256("active-2"),
            sha256(abi.encodePacked(bytes32("active-two"))),
            BENEFICIARY,
            400 ether,
            0,
            nextNonce++
        );

        _expectReserveRevert(vault, second, TreeSwapBitVault.TooManyActiveReservations.selector);
        vault.claim(first.quoteId, PREIMAGE);
        _submit(vault, second);
        assertEq(vault.activeUserReservations(user), 1, "active slot did not reopen");
    }

    function testGateHaltBlocksNewReservationsButNotExistingClaimOrWithdrawal() public {
        _deposit(vault, 1_000 ether);
        TreeSwapBitVault.SelectedQuote memory first =
            _reserve(vault, keccak256("before-halt"), paymentHash, BENEFICIARY, 400 ether, 0);
        gate.setOpen(false);

        TreeSwapBitVault.SelectedQuote memory second = _quote(
            keccak256("after-halt"),
            sha256(abi.encodePacked(bytes32("after-halt"))),
            BENEFICIARY,
            400 ether,
            0,
            nextNonce++
        );
        _expectReserveRevert(vault, second, TreeSwapBitVault.OpensPaused.selector);

        vault.claim(first.quoteId, PREIMAGE);
        vm.prank(solver);
        vault.withdraw(100 ether, solver);
        assertEq(bit.balanceOf(BENEFICIARY), 400 ether, "halt blocked claim");
    }

    function testGateHaltDoesNotBlockExistingRefund() public {
        _deposit(vault, 1_000 ether);
        TreeSwapBitVault.SelectedQuote memory quote =
            _reserve(vault, keccak256("refund-after-halt"), paymentHash, BENEFICIARY, 400 ether, 0);
        gate.setOpen(false);
        vm.warp(quote.refundAfter);
        vault.refund(quote.quoteId);
        assertEq(vault.availableBalance(solver), 1_000 ether, "halt blocked refund");
    }

    function testTokenPauseOrDecimalChangeFailsClosedForNewReservations() public {
        _deposit(vault, 1_000 ether);
        TreeSwapBitVault.SelectedQuote memory quote =
            _quote(keccak256("runtime-token-check"), paymentHash, BENEFICIARY, 400 ether, 0, nextNonce++);

        bit.setPaused(true);
        _expectReserveRevert(vault, quote, TreeSwapBitVault.UnexpectedTokenConfiguration.selector);
        bit.setPaused(false);
        bit.setDecimals(8);
        _expectReserveRevert(vault, quote, TreeSwapBitVault.UnexpectedTokenConfiguration.selector);
        bit.setDecimals(18);
        _submit(vault, quote);
    }

    function testTokenPauseAfterReserveCannotCorruptAndUnpauseRestoresClaim() public {
        _deposit(vault, 1_000 ether);
        TreeSwapBitVault.SelectedQuote memory quote =
            _reserve(vault, keccak256("pause-after-reserve"), paymentHash, BENEFICIARY, 400 ether, 0);
        bit.setPaused(true);
        vm.expectRevert(TreeSwapBitVault.TokenTransferFailed.selector);
        vault.claim(quote.quoteId, PREIMAGE);
        assertEq(
            uint256(vault.swapState(quote.quoteId)), uint256(TreeSwapBitVault.SwapState.LOCKED), "pause changed state"
        );

        bit.setPaused(false);
        vault.claim(quote.quoteId, PREIMAGE);
        assertEq(bit.balanceOf(BENEFICIARY), 400 ether, "unpause did not restore claim");
    }

    function testFeeOnTransferBehaviorFailsExactBalanceDelta() public {
        bit.setTransferFeeBps(100);
        vm.expectRevert(TreeSwapBitVault.UnexpectedTokenBalanceDelta.selector);
        vm.prank(solver);
        vault.deposit(500 ether);

        bit.setTransferFeeBps(0);
        _deposit(vault, 500 ether);
        TreeSwapBitVault.SelectedQuote memory quote =
            _reserve(vault, keccak256("fee-on-transfer"), paymentHash, BENEFICIARY, 400 ether, 0);
        bit.setTransferFeeBps(100);
        vm.expectRevert(TreeSwapBitVault.UnexpectedTokenBalanceDelta.selector);
        vault.claim(quote.quoteId, PREIMAGE);
        assertEq(
            uint256(vault.swapState(quote.quoteId)),
            uint256(TreeSwapBitVault.SwapState.LOCKED),
            "fee token changed state"
        );
    }

    function testUserNonceCannotBeReused() public {
        _deposit(vault, 1_000 ether);
        uint256 nonce = nextNonce++;
        TreeSwapBitVault.SelectedQuote memory first =
            _quote(keccak256("nonce-1"), paymentHash, BENEFICIARY, 400 ether, 0, nonce);
        _submit(vault, first);
        vault.claim(first.quoteId, PREIMAGE);

        TreeSwapBitVault.SelectedQuote memory second = _quote(
            keccak256("nonce-2"), sha256(abi.encodePacked(bytes32("second-preimage"))), BENEFICIARY, 400 ether, 0, nonce
        );

        _expectReserveRevert(vault, second, TreeSwapBitVault.NonceAlreadyUsed.selector);
    }

    function testPriceOutsideReferenceBandCannotReserve() public {
        _deposit(vault, 1_000 ether);
        TreeSwapBitVault.SelectedQuote memory quote =
            _quote(keccak256("bad-price"), paymentHash, BENEFICIARY, 500 ether, 0, nextNonce++);
        quote.lightningAmountSats = 30_000;

        _expectReserveRevert(vault, quote, TreeSwapBitVault.PriceOutsideBand.selector);
    }

    function testPerSwapAndEpochCapsLimitExposure() public {
        _deposit(vault, 2_000 ether);
        TreeSwapBitVault.SelectedQuote memory oversized =
            _quote(keccak256("oversized"), paymentHash, BENEFICIARY, 601 ether, 0, nextNonce++);
        _expectReserveRevert(vault, oversized, TreeSwapBitVault.SwapAmountExceedsCap.selector);

        bytes32 epochOnePreimage = bytes32("epoch-one");
        TreeSwapBitVault.SelectedQuote memory first = _reserve(
            vault, keccak256("epoch-1"), sha256(abi.encodePacked(epochOnePreimage)), BENEFICIARY, 500 ether, 0
        );
        vault.claim(first.quoteId, epochOnePreimage);
        TreeSwapBitVault.SelectedQuote memory overEpoch = _quote(
            keccak256("epoch-2"), sha256(abi.encodePacked(bytes32("epoch-two"))), BENEFICIARY, 500 ether, 0, nextNonce++
        );
        _expectReserveRevert(vault, overEpoch, TreeSwapBitVault.EpochVolumeExceedsCap.selector);
    }

    function testDeadlineOrderingIsEnforced() public {
        _deposit(vault, 1_000 ether);
        TreeSwapBitVault.SelectedQuote memory quote =
            _quote(keccak256("deadline"), paymentHash, BENEFICIARY, 500 ether, 0, nextNonce++);

        quote.lastSafeClaimAt = uint64(block.timestamp + vault.minSettlementWindow() - 1);
        _expectReserveRevert(vault, quote, TreeSwapBitVault.InvalidDeadlineOrder.selector);

        quote = _quote(keccak256("deadline-2"), paymentHash, BENEFICIARY, 500 ether, 0, nextNonce++);
        quote.refundAfter = quote.lastSafeClaimAt + uint64(vault.minClaimBuffer()) - 1;
        _expectReserveRevert(vault, quote, TreeSwapBitVault.InvalidDeadlineOrder.selector);

        quote = _quote(keccak256("deadline-3"), paymentHash, BENEFICIARY, 500 ether, 0, nextNonce++);
        vm.warp(quote.quoteExpiresAt);
        _expectReserveRevert(vault, quote, TreeSwapBitVault.QuoteExpired.selector);
    }

    function testClaimClosesWhenRefundOpens() public {
        _deposit(vault, 1_000 ether);
        TreeSwapBitVault.SelectedQuote memory quote =
            _reserve(vault, keccak256("cutoff"), paymentHash, BENEFICIARY, 500 ether, 0);

        vm.warp(quote.refundAfter);
        vm.expectRevert(TreeSwapBitVault.ClaimWindowClosed.selector);
        vault.claim(quote.quoteId, PREIMAGE);

        vault.refund(quote.quoteId);
        assertEq(vault.availableBalance(solver), 1_000 ether, "cutoff refund failed");
    }

    function testWrongPreimageCannotClaim() public {
        _deposit(vault, 1_000 ether);
        TreeSwapBitVault.SelectedQuote memory quote =
            _reserve(vault, keccak256("wrong-preimage"), paymentHash, BENEFICIARY, 500 ether, 0);

        vm.expectRevert(TreeSwapBitVault.IncorrectPreimage.selector);
        vault.claim(quote.quoteId, bytes32(uint256(123)));
    }

    function testExpiredSwapRefundsWithoutFee() public {
        _deposit(vault, 1_000 ether);
        TreeSwapBitVault.SelectedQuote memory quote =
            _reserve(vault, keccak256("refund"), paymentHash, BENEFICIARY, 500 ether, 2 ether);

        vm.warp(quote.refundAfter);
        vm.prank(ATTACKER);
        vault.refund(quote.quoteId);

        assertEq(vault.availableBalance(solver), 1_000 ether, "refund not returned to solver");
        assertEq(bit.balanceOf(COLLECTOR), 0, "refund charged fee");
        assertEq(vault.accountedBalance(), bit.balanceOf(address(vault)), "accounting mismatch");
    }

    function testPaymentHashCannotBeReused() public {
        _deposit(vault, 1_000 ether);
        TreeSwapBitVault.SelectedQuote memory first =
            _reserve(vault, keccak256("hash-1"), paymentHash, BENEFICIARY, 300 ether, 0);
        vault.claim(first.quoteId, PREIMAGE);

        TreeSwapBitVault.SelectedQuote memory second =
            _quote(keccak256("hash-2"), paymentHash, BENEFICIARY, 300 ether, 0, nextNonce++);
        _expectReserveRevert(vault, second, TreeSwapBitVault.PaymentHashAlreadyUsed.selector);
    }

    function testTerminalSwapCannotClaimAndRefund() public {
        _deposit(vault, 1_000 ether);
        TreeSwapBitVault.SelectedQuote memory quote =
            _reserve(vault, keccak256("terminal"), paymentHash, BENEFICIARY, 500 ether, 0);
        vault.claim(quote.quoteId, PREIMAGE);
        vm.warp(quote.refundAfter);

        vm.expectRevert(TreeSwapBitVault.SwapNotLocked.selector);
        vault.refund(quote.quoteId);
    }

    function testFeeCannotExceedImmutableCap() public {
        _deposit(vault, 1_000 ether);
        TreeSwapBitVault.SelectedQuote memory quote =
            _quote(keccak256("fee-cap"), paymentHash, BENEFICIARY, 500 ether, 6 ether, nextNonce++);
        _expectReserveRevert(vault, quote, TreeSwapBitVault.FeeExceedsCap.selector);
    }

    function testFuzzDepositWithdrawConserves(uint96 rawAmount) public {
        uint256 amount = 1 + (uint256(rawAmount) % 10_000 ether);
        _deposit(vault, amount);
        uint256 withdrawal = amount / 3;
        if (withdrawal != 0) {
            vm.prank(solver);
            vault.withdraw(withdrawal, solver);
        }

        assertEq(vault.accountedBalance(), bit.balanceOf(address(vault)), "fuzz accounting mismatch");
    }

    function testEverySelectedQuoteFieldChangesTheSignedDigest() public view {
        TreeSwapBitVault.SelectedQuote memory base =
            _quote(keccak256("all-fields"), paymentHash, BENEFICIARY, 500 ether, 2 ether, 77);
        bytes32 expected = vault.hashSelectedQuote(base);
        TreeSwapBitVault.SelectedQuote memory changed = base;

        changed.quoteId = keccak256("changed-id");
        _assertDigestChanged(changed, expected);
        changed = base;
        changed.user = ATTACKER;
        _assertDigestChanged(changed, expected);
        changed = base;
        changed.solver = ATTACKER;
        _assertDigestChanged(changed, expected);
        changed = base;
        changed.beneficiary = ATTACKER;
        _assertDigestChanged(changed, expected);
        changed = base;
        changed.amount += 1;
        _assertDigestChanged(changed, expected);
        changed = base;
        changed.fee += 1;
        _assertDigestChanged(changed, expected);
        changed = base;
        changed.lightningAmountSats += 1;
        _assertDigestChanged(changed, expected);
        changed = base;
        changed.paymentHash = keccak256("changed-payment");
        _assertDigestChanged(changed, expected);
        changed = base;
        changed.invoiceDigest = keccak256("changed-invoice");
        _assertDigestChanged(changed, expected);
        changed = base;
        changed.nonce += 1;
        _assertDigestChanged(changed, expected);
        changed = base;
        changed.quoteExpiresAt += 1;
        _assertDigestChanged(changed, expected);
        changed = base;
        changed.lastSafeClaimAt += 1;
        _assertDigestChanged(changed, expected);
        changed = base;
        changed.refundAfter += 1;
        _assertDigestChanged(changed, expected);
    }

    function _assertDigestChanged(TreeSwapBitVault.SelectedQuote memory quote, bytes32 expected) internal view {
        assertTrue(vault.hashSelectedQuote(quote) != expected, "selected quote field is missing from digest");
    }

    function _riskConfig() internal pure returns (TreeSwapBitVault.RiskConfig memory) {
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

    function _deposit(TreeSwapBitVault target, uint256 amount) internal {
        vm.prank(solver);
        target.deposit(amount);
    }

    function _quote(bytes32 quoteId, bytes32 hash, address beneficiary, uint96 amount, uint96 fee, uint256 nonce)
        internal
        view
        returns (TreeSwapBitVault.SelectedQuote memory)
    {
        return TreeSwapBitVault.SelectedQuote({
            quoteId: quoteId,
            user: user,
            solver: solver,
            beneficiary: beneficiary,
            amount: amount,
            fee: fee,
            lightningAmountSats: uint64((uint256(amount - fee) * 100) / 1 ether),
            paymentHash: hash,
            invoiceDigest: keccak256(abi.encode("invoice", quoteId)),
            nonce: nonce,
            quoteExpiresAt: uint64(block.timestamp + 5 minutes),
            lastSafeClaimAt: uint64(block.timestamp + 1 hours),
            refundAfter: uint64(block.timestamp + 1 hours + 15 minutes)
        });
    }

    function _signUser(TreeSwapBitVault target, TreeSwapBitVault.SelectedQuote memory quote)
        internal
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(USER_PK, target.hashSelectedQuote(quote));
        return abi.encodePacked(r, s, v);
    }

    function _signSolver(TreeSwapBitVault target, TreeSwapBitVault.SelectedQuote memory quote)
        internal
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SOLVER_PK, target.hashSelectedQuote(quote));
        return abi.encodePacked(r, s, v);
    }

    function _submit(TreeSwapBitVault target, TreeSwapBitVault.SelectedQuote memory quote) internal {
        bytes memory userSignature = _signUser(target, quote);
        bytes memory solverSignature = _signSolver(target, quote);
        vm.prank(quote.user);
        target.reserve(quote, userSignature, solverSignature);
    }

    function _expectReserveRevert(TreeSwapBitVault target, TreeSwapBitVault.SelectedQuote memory quote, bytes4 selector)
        internal
    {
        bytes memory userSignature = _signUser(target, quote);
        bytes memory solverSignature = _signSolver(target, quote);
        vm.expectRevert(selector);
        vm.prank(quote.user);
        target.reserve(quote, userSignature, solverSignature);
    }

    function _reserve(
        TreeSwapBitVault target,
        bytes32 quoteId,
        bytes32 hash,
        address beneficiary,
        uint96 amount,
        uint96 fee
    ) internal returns (TreeSwapBitVault.SelectedQuote memory quote) {
        quote = _quote(quoteId, hash, beneficiary, amount, fee, nextNonce++);
        _submit(target, quote);
    }
}
