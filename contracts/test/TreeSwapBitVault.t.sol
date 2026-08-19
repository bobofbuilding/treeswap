// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {TreeSwapBitVault} from "../src/TreeSwapBitVault.sol";
import {MockBit, TestBase} from "./helpers/TestBase.sol";

contract TreeSwapBitVaultTest is TestBase {
    MockBit internal bit;
    TreeSwapBitVault internal vault;

    uint256 internal constant USER_PK = 0xA11CE;
    address internal user;
    address internal constant SOLVER = address(0x5107E2);
    address internal constant BENEFICIARY = address(0xBEEF);
    address internal constant ATTACKER = address(0xBAD);
    address internal constant COLLECTOR = address(0xFEE);

    bytes32 internal constant PREIMAGE = keccak256("treeswap-preimage");
    bytes32 internal paymentHash;
    uint256 internal nextNonce;

    function setUp() public {
        user = vm.addr(USER_PK);
        bit = new MockBit();
        vault = new TreeSwapBitVault(address(bit), COLLECTOR, _riskConfig());
        paymentHash = sha256(abi.encodePacked(PREIMAGE));
        bit.mint(SOLVER, 10_000 ether);
        vm.prank(SOLVER);
        bit.approve(address(vault), type(uint256).max);
    }

    function testDepositAndWithdrawOnlyAvailableInventory() public {
        _deposit(vault, 1_000 ether);
        vm.prank(SOLVER);
        vault.withdraw(250 ether, SOLVER);

        assertEq(vault.availableBalance(SOLVER), 750 ether, "available mismatch");
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
        bytes memory signature = _sign(vault, quote);
        quote.beneficiary = ATTACKER;

        vm.expectRevert(TreeSwapBitVault.InvalidSignature.selector);
        vm.prank(SOLVER);
        vault.reserve(quote, signature);
    }

    function testQuoteSignatureCannotReplayOnAnotherVault() public {
        TreeSwapBitVault secondVault = new TreeSwapBitVault(address(bit), COLLECTOR, _riskConfig());
        vm.prank(SOLVER);
        bit.approve(address(secondVault), type(uint256).max);
        _deposit(secondVault, 1_000 ether);

        TreeSwapBitVault.SelectedQuote memory quote =
            _quote(keccak256("domain-replay"), paymentHash, BENEFICIARY, 500 ether, 0, nextNonce++);
        bytes memory wrongDomainSignature = _sign(vault, quote);

        vm.expectRevert(TreeSwapBitVault.InvalidSignature.selector);
        vm.prank(SOLVER);
        secondVault.reserve(quote, wrongDomainSignature);
    }

    function testQuoteSignatureCannotReplayOnAnotherChain() public {
        _deposit(vault, 1_000 ether);
        TreeSwapBitVault.SelectedQuote memory quote =
            _quote(keccak256("chain-replay"), paymentHash, BENEFICIARY, 500 ether, 0, nextNonce++);
        bytes memory wrongChainSignature = _sign(vault, quote);
        vm.chainId(block.chainid + 1);

        vm.expectRevert(TreeSwapBitVault.InvalidSignature.selector);
        vm.prank(SOLVER);
        vault.reserve(quote, wrongChainSignature);
    }

    function testMalformedSignatureCannotReserve() public {
        _deposit(vault, 1_000 ether);
        TreeSwapBitVault.SelectedQuote memory quote =
            _quote(keccak256("malformed-signature"), paymentHash, BENEFICIARY, 500 ether, 0, nextNonce++);

        vm.expectRevert(TreeSwapBitVault.InvalidSignature.selector);
        vm.prank(SOLVER);
        vault.reserve(quote, hex"1234");
    }

    function testUserNonceCannotBeReused() public {
        _deposit(vault, 1_000 ether);
        uint256 nonce = nextNonce++;
        TreeSwapBitVault.SelectedQuote memory first =
            _quote(keccak256("nonce-1"), paymentHash, BENEFICIARY, 400 ether, 0, nonce);
        _submit(vault, first);

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

        _reserve(vault, keccak256("epoch-1"), sha256(abi.encodePacked(bytes32("epoch-one"))), BENEFICIARY, 500 ether, 0);
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
        assertEq(vault.availableBalance(SOLVER), 1_000 ether, "cutoff refund failed");
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

        assertEq(vault.availableBalance(SOLVER), 1_000 ether, "refund not returned to solver");
        assertEq(bit.balanceOf(COLLECTOR), 0, "refund charged fee");
        assertEq(vault.accountedBalance(), bit.balanceOf(address(vault)), "accounting mismatch");
    }

    function testPaymentHashCannotBeReused() public {
        _deposit(vault, 1_000 ether);
        _reserve(vault, keccak256("hash-1"), paymentHash, BENEFICIARY, 300 ether, 0);

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
            vm.prank(SOLVER);
            vault.withdraw(withdrawal, SOLVER);
        }

        assertEq(vault.accountedBalance(), bit.balanceOf(address(vault)), "fuzz accounting mismatch");
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
        vm.prank(SOLVER);
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
            solver: SOLVER,
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

    function _sign(TreeSwapBitVault target, TreeSwapBitVault.SelectedQuote memory quote)
        internal
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(USER_PK, target.hashSelectedQuote(quote));
        return abi.encodePacked(r, s, v);
    }

    function _submit(TreeSwapBitVault target, TreeSwapBitVault.SelectedQuote memory quote) internal {
        bytes memory signature = _sign(target, quote);
        vm.prank(SOLVER);
        target.reserve(quote, signature);
    }

    function _expectReserveRevert(TreeSwapBitVault target, TreeSwapBitVault.SelectedQuote memory quote, bytes4 selector)
        internal
    {
        bytes memory signature = _sign(target, quote);
        vm.expectRevert(selector);
        vm.prank(SOLVER);
        target.reserve(quote, signature);
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
