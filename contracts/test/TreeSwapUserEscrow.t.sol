// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {TreeSwapUserEscrow} from "../src/TreeSwapUserEscrow.sol";
import {Mock1271Wallet, MockBit, MockOpenGate, MockPaymentHashRegistry, TestBase} from "./helpers/TestBase.sol";

contract TreeSwapUserEscrowTest is TestBase {
    MockBit internal bit;
    MockOpenGate internal gate;
    MockPaymentHashRegistry internal hashRegistry;
    TreeSwapUserEscrow internal escrow;

    uint256 internal constant SOLVER_PK = 0x5107E2;
    address internal solver;
    address internal constant USER = address(0xA11CE);
    address internal constant BENEFICIARY = address(0xBEEF);
    address internal constant ATTACKER = address(0xBAD);
    address internal constant COLLECTOR = address(0xFEE);

    bytes32 internal constant PREIMAGE = keccak256("treeswap-reverse-preimage");
    bytes32 internal paymentHash;
    uint256 internal nextNonce;

    function setUp() public {
        solver = vm.addr(SOLVER_PK);
        bit = new MockBit();
        gate = new MockOpenGate();
        hashRegistry = new MockPaymentHashRegistry();
        escrow = new TreeSwapUserEscrow(address(bit), COLLECTOR, address(gate), address(hashRegistry), _riskConfig());
        paymentHash = sha256(abi.encodePacked(PREIMAGE));
        bit.mint(USER, 10_000 ether);
        vm.prank(USER);
        bit.approve(address(escrow), type(uint256).max);
    }

    function testOpenAndClaimPaysOnlySignedSolverBeneficiary() public {
        TreeSwapUserEscrow.SolverQuote memory quote =
            _open(keccak256("reverse-1"), paymentHash, BENEFICIARY, 500 ether, 2 ether);

        vm.prank(ATTACKER);
        escrow.claim(quote.quoteId, PREIMAGE);

        assertEq(bit.balanceOf(BENEFICIARY), 498 ether, "solver beneficiary payout mismatch");
        assertEq(bit.balanceOf(ATTACKER), 0, "relayer redirected payout");
        assertEq(bit.balanceOf(COLLECTOR), 2 ether, "fee mismatch");
        assertEq(escrow.totalLocked(), 0, "locked balance remains");
    }

    function testSignedQuoteCannotChangeSolverBeneficiary() public {
        TreeSwapUserEscrow.SolverQuote memory quote =
            _quote(keccak256("reverse-bound"), paymentHash, BENEFICIARY, 500 ether, 0, nextNonce++);
        bytes memory signature = _sign(quote);
        quote.solverBeneficiary = ATTACKER;

        vm.expectRevert(TreeSwapUserEscrow.InvalidSignature.selector);
        vm.prank(USER);
        escrow.open(quote, signature);
    }

    function testOnlyBoundUserCanOpenSignedQuote() public {
        TreeSwapUserEscrow.SolverQuote memory quote =
            _quote(keccak256("reverse-user"), paymentHash, BENEFICIARY, 500 ether, 0, nextNonce++);
        bytes memory signature = _sign(quote);

        vm.expectRevert(TreeSwapUserEscrow.InvalidUser.selector);
        vm.prank(ATTACKER);
        escrow.open(quote, signature);
    }

    function testEip1271SolverCanSignFirmQuote() public {
        Mock1271Wallet wallet = new Mock1271Wallet(solver);
        solver = address(wallet);
        TreeSwapUserEscrow.SolverQuote memory quote =
            _quote(keccak256("contract-solver"), paymentHash, BENEFICIARY, 500 ether, 0, nextNonce++);
        _submit(quote);

        assertEq(
            uint256(escrow.swapState(quote.quoteId)), uint256(TreeSwapUserEscrow.SwapState.LOCKED), "1271 open failed"
        );
    }

    function testEip1271SolverRejectsWrongOwnerSignature() public {
        Mock1271Wallet wallet = new Mock1271Wallet(ATTACKER);
        solver = address(wallet);
        TreeSwapUserEscrow.SolverQuote memory quote =
            _quote(keccak256("contract-solver-wrong"), paymentHash, BENEFICIARY, 500 ether, 0, nextNonce++);

        _expectOpenRevert(quote, TreeSwapUserEscrow.InvalidSignature.selector);
    }

    function testExpiredSwapRefundsCompleteAmountWithoutFee() public {
        TreeSwapUserEscrow.SolverQuote memory quote =
            _open(keccak256("reverse-refund"), paymentHash, BENEFICIARY, 500 ether, 2 ether);
        uint256 userAfterOpen = bit.balanceOf(USER);

        vm.warp(quote.refundAfter);
        vm.prank(ATTACKER);
        escrow.refund(quote.quoteId);

        assertEq(bit.balanceOf(USER), userAfterOpen + 500 ether, "user refund mismatch");
        assertEq(bit.balanceOf(COLLECTOR), 0, "refund charged fee");
        assertEq(escrow.totalLocked(), 0, "refund left liabilities");
    }

    function testBitFeeCannotExceedImmutableCap() public {
        TreeSwapUserEscrow.SolverQuote memory quote =
            _quote(keccak256("reverse-fee-cap"), paymentHash, BENEFICIARY, 500 ether, 6 ether, nextNonce++);
        _expectOpenRevert(quote, TreeSwapUserEscrow.FeeExceedsCap.selector);
    }

    function testPaymentHashAndSolverNonceAreSingleUse() public {
        uint256 nonce = nextNonce++;
        TreeSwapUserEscrow.SolverQuote memory first =
            _quote(keccak256("reverse-replay-1"), paymentHash, BENEFICIARY, 300 ether, 0, nonce);
        _submit(first);

        TreeSwapUserEscrow.SolverQuote memory reusedHash =
            _quote(keccak256("reverse-replay-2"), paymentHash, BENEFICIARY, 300 ether, 0, nextNonce++);
        _expectOpenRevert(reusedHash, TreeSwapUserEscrow.PaymentHashAlreadyUsed.selector);

        TreeSwapUserEscrow.SolverQuote memory reusedNonce = _quote(
            keccak256("reverse-replay-3"),
            sha256(abi.encodePacked(bytes32("new-hash"))),
            BENEFICIARY,
            300 ether,
            0,
            nonce
        );
        _expectOpenRevert(reusedNonce, TreeSwapUserEscrow.NonceAlreadyUsed.selector);
    }

    function testClaimAndRefundAreMutuallyExclusiveAtBoundary() public {
        TreeSwapUserEscrow.SolverQuote memory quote =
            _open(keccak256("reverse-terminal"), paymentHash, BENEFICIARY, 500 ether, 0);
        vm.warp(quote.refundAfter);

        vm.expectRevert(TreeSwapUserEscrow.ClaimWindowClosed.selector);
        escrow.claim(quote.quoteId, PREIMAGE);
        escrow.refund(quote.quoteId);

        vm.expectRevert(TreeSwapUserEscrow.SwapNotLocked.selector);
        escrow.claim(quote.quoteId, PREIMAGE);
    }

    function testDirectionSpecificSignatureCannotReplayOnInventoryVaultShape() public {
        TreeSwapUserEscrow.SolverQuote memory quote =
            _quote(keccak256("reverse-domain"), paymentHash, BENEFICIARY, 500 ether, 0, nextNonce++);
        bytes32 reverseDigest = escrow.hashSolverQuote(quote);
        assertTrue(
            reverseDigest
                != keccak256(
                    abi.encodePacked(
                        "TreeSwap BIT Vault",
                        quote.quoteId,
                        quote.user,
                        quote.solver,
                        quote.solverBeneficiary,
                        quote.amount,
                        quote.lightningAmountSats
                    )
                ),
            "direction digest unexpectedly collided"
        );
    }

    function testGateHaltBlocksNewOpensButNotExistingClaim() public {
        TreeSwapUserEscrow.SolverQuote memory first =
            _open(keccak256("reverse-before-halt"), paymentHash, BENEFICIARY, 400 ether, 0);
        gate.setOpen(false);

        TreeSwapUserEscrow.SolverQuote memory second = _quote(
            keccak256("reverse-after-halt"),
            sha256(abi.encodePacked(bytes32("reverse-after-halt"))),
            BENEFICIARY,
            400 ether,
            0,
            nextNonce++
        );
        _expectOpenRevert(second, TreeSwapUserEscrow.OpensPaused.selector);
        escrow.claim(first.quoteId, PREIMAGE);
        assertEq(bit.balanceOf(BENEFICIARY), 400 ether, "halt blocked reverse claim");
    }

    function testGateHaltDoesNotBlockExistingUserRefund() public {
        TreeSwapUserEscrow.SolverQuote memory quote =
            _open(keccak256("reverse-refund-halt"), paymentHash, BENEFICIARY, 400 ether, 0);
        gate.setOpen(false);
        vm.warp(quote.refundAfter);
        escrow.refund(quote.quoteId);
        assertEq(bit.balanceOf(USER), 10_000 ether, "halt blocked reverse refund");
    }

    function testTokenPauseOrDecimalChangeFailsClosedForNewOpens() public {
        TreeSwapUserEscrow.SolverQuote memory quote =
            _quote(keccak256("reverse-runtime-token"), paymentHash, BENEFICIARY, 400 ether, 0, nextNonce++);
        bit.setPaused(true);
        _expectOpenRevert(quote, TreeSwapUserEscrow.UnexpectedTokenConfiguration.selector);
        bit.setPaused(false);
        bit.setDecimals(8);
        _expectOpenRevert(quote, TreeSwapUserEscrow.UnexpectedTokenConfiguration.selector);
        bit.setDecimals(18);
        _submit(quote);
    }

    function testTokenPauseAfterOpenCannotCorruptAndUnpauseRestoresClaim() public {
        TreeSwapUserEscrow.SolverQuote memory quote =
            _open(keccak256("reverse-pause-after-open"), paymentHash, BENEFICIARY, 400 ether, 0);
        bit.setPaused(true);
        vm.expectRevert(TreeSwapUserEscrow.TokenTransferFailed.selector);
        escrow.claim(quote.quoteId, PREIMAGE);
        assertEq(
            uint256(escrow.swapState(quote.quoteId)),
            uint256(TreeSwapUserEscrow.SwapState.LOCKED),
            "pause changed state"
        );

        bit.setPaused(false);
        escrow.claim(quote.quoteId, PREIMAGE);
        assertEq(bit.balanceOf(BENEFICIARY), 400 ether, "unpause did not restore reverse claim");
    }

    function testFeeOnTransferBehaviorFailsExactBalanceDelta() public {
        bit.setTransferFeeBps(100);
        TreeSwapUserEscrow.SolverQuote memory quote =
            _quote(keccak256("reverse-fee-on-transfer"), paymentHash, BENEFICIARY, 400 ether, 0, nextNonce++);
        _expectOpenRevert(quote, TreeSwapUserEscrow.UnexpectedTokenBalanceDelta.selector);

        bit.setTransferFeeBps(0);
        quote = _open(keccak256("reverse-fee-on-claim"), paymentHash, BENEFICIARY, 400 ether, 0);
        bit.setTransferFeeBps(100);
        vm.expectRevert(TreeSwapUserEscrow.UnexpectedTokenBalanceDelta.selector);
        escrow.claim(quote.quoteId, PREIMAGE);
        assertEq(
            uint256(escrow.swapState(quote.quoteId)),
            uint256(TreeSwapUserEscrow.SwapState.LOCKED),
            "fee token changed state"
        );
    }

    function testEverySolverQuoteFieldChangesTheSignedDigest() public view {
        TreeSwapUserEscrow.SolverQuote memory base =
            _quote(keccak256("reverse-all-fields"), paymentHash, BENEFICIARY, 500 ether, 2 ether, 77);
        bytes32 expected = escrow.hashSolverQuote(base);
        TreeSwapUserEscrow.SolverQuote memory changed = base;

        changed.quoteId = keccak256("changed-id");
        _assertDigestChanged(changed, expected);
        changed = base;
        changed.user = ATTACKER;
        _assertDigestChanged(changed, expected);
        changed = base;
        changed.solver = ATTACKER;
        _assertDigestChanged(changed, expected);
        changed = base;
        changed.solverBeneficiary = ATTACKER;
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
        changed.solverNonce += 1;
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

    function _assertDigestChanged(TreeSwapUserEscrow.SolverQuote memory quote, bytes32 expected) internal view {
        assertTrue(escrow.hashSolverQuote(quote) != expected, "solver quote field is missing from digest");
    }

    function _riskConfig() internal pure returns (TreeSwapUserEscrow.RiskConfig memory) {
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

    function _quote(bytes32 quoteId, bytes32 hash, address beneficiary, uint96 amount, uint96 fee, uint256 nonce)
        internal
        view
        returns (TreeSwapUserEscrow.SolverQuote memory)
    {
        return TreeSwapUserEscrow.SolverQuote({
            quoteId: quoteId,
            user: USER,
            solver: solver,
            solverBeneficiary: beneficiary,
            amount: amount,
            fee: fee,
            lightningAmountSats: uint64((uint256(amount - fee) * 100) / 1 ether),
            paymentHash: hash,
            invoiceDigest: keccak256(abi.encode("invoice", quoteId)),
            solverNonce: nonce,
            quoteExpiresAt: uint64(block.timestamp + 5 minutes),
            lastSafeClaimAt: uint64(block.timestamp + 1 hours),
            refundAfter: uint64(block.timestamp + 1 hours + 15 minutes)
        });
    }

    function _sign(TreeSwapUserEscrow.SolverQuote memory quote) internal returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SOLVER_PK, escrow.hashSolverQuote(quote));
        return abi.encodePacked(r, s, v);
    }

    function _submit(TreeSwapUserEscrow.SolverQuote memory quote) internal {
        bytes memory signature = _sign(quote);
        vm.prank(USER);
        escrow.open(quote, signature);
    }

    function _expectOpenRevert(TreeSwapUserEscrow.SolverQuote memory quote, bytes4 selector) internal {
        bytes memory signature = _sign(quote);
        vm.expectRevert(selector);
        vm.prank(USER);
        escrow.open(quote, signature);
    }

    function _open(bytes32 quoteId, bytes32 hash, address beneficiary, uint96 amount, uint96 fee)
        internal
        returns (TreeSwapUserEscrow.SolverQuote memory quote)
    {
        quote = _quote(quoteId, hash, beneficiary, amount, fee, nextNonce++);
        _submit(quote);
    }
}
