// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {TreeSwapBitVault} from "../src/TreeSwapBitVault.sol";
import {MockBit, TestBase} from "./helpers/TestBase.sol";

contract TreeSwapBitVaultTest is TestBase {
    MockBit internal bit;
    TreeSwapBitVault internal vault;

    address internal constant SOLVER = address(0x5107E2);
    address internal constant BENEFICIARY = address(0xBEEF);
    address internal constant ATTACKER = address(0xBAD);
    address internal constant COLLECTOR = address(0xFEE);

    bytes32 internal constant PREIMAGE = keccak256("treeswap-preimage");
    bytes32 internal paymentHash;
    bytes32 internal constant SWAP_ID = keccak256("swap-1");

    function setUp() public {
        bit = new MockBit();
        vault = new TreeSwapBitVault(address(bit), COLLECTOR, 100);
        paymentHash = sha256(abi.encodePacked(PREIMAGE));
        bit.mint(SOLVER, 10_000 ether);
        vm.prank(SOLVER);
        bit.approve(address(vault), type(uint256).max);
    }

    function testDepositAndWithdrawOnlyAvailableInventory() public {
        _deposit(1_000 ether);
        vm.prank(SOLVER);
        vault.withdraw(250 ether, SOLVER);

        assertEq(vault.availableBalance(SOLVER), 750 ether, "available mismatch");
        assertEq(vault.totalAvailable(), 750 ether, "total available mismatch");
        assertEq(bit.balanceOf(address(vault)), 750 ether, "vault balance mismatch");
    }

    function testReserveAndClaimPaysOnlyBoundBeneficiary() public {
        _deposit(1_000 ether);
        _reserve(SWAP_ID, paymentHash, BENEFICIARY, 500 ether, 2 ether);

        vm.prank(ATTACKER);
        vault.claim(SWAP_ID, PREIMAGE);

        assertEq(bit.balanceOf(BENEFICIARY), 498 ether, "beneficiary payout mismatch");
        assertEq(bit.balanceOf(ATTACKER), 0, "relayer redirected payout");
        assertEq(bit.balanceOf(COLLECTOR), 2 ether, "fee mismatch");
        assertEq(vault.totalLocked(), 0, "locked balance remains");
    }

    function testWrongPreimageCannotClaim() public {
        _deposit(1_000 ether);
        _reserve(SWAP_ID, paymentHash, BENEFICIARY, 500 ether, 0);

        vm.expectRevert(TreeSwapBitVault.IncorrectPreimage.selector);
        vault.claim(SWAP_ID, bytes32(uint256(123)));
    }

    function testExpiredSwapRefundsWithoutFee() public {
        _deposit(1_000 ether);
        _reserve(SWAP_ID, paymentHash, BENEFICIARY, 500 ether, 2 ether);

        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(ATTACKER);
        vault.refund(SWAP_ID);

        assertEq(vault.availableBalance(SOLVER), 1_000 ether, "refund not returned to solver");
        assertEq(bit.balanceOf(COLLECTOR), 0, "refund charged fee");
        assertEq(vault.accountedBalance(), bit.balanceOf(address(vault)), "accounting mismatch");
    }

    function testPaymentHashCannotBeReused() public {
        _deposit(1_000 ether);
        _reserve(SWAP_ID, paymentHash, BENEFICIARY, 300 ether, 0);

        vm.expectRevert(TreeSwapBitVault.PaymentHashAlreadyUsed.selector);
        _reserve(keccak256("swap-2"), paymentHash, BENEFICIARY, 300 ether, 0);
    }

    function testTerminalSwapCannotClaimAndRefund() public {
        _deposit(1_000 ether);
        _reserve(SWAP_ID, paymentHash, BENEFICIARY, 500 ether, 0);
        vault.claim(SWAP_ID, PREIMAGE);
        vm.warp(block.timestamp + 1 days + 1);

        vm.expectRevert(TreeSwapBitVault.SwapNotLocked.selector);
        vault.refund(SWAP_ID);
    }

    function testFeeCannotExceedImmutableCap() public {
        _deposit(1_000 ether);

        vm.expectRevert(TreeSwapBitVault.FeeExceedsCap.selector);
        _reserve(SWAP_ID, paymentHash, BENEFICIARY, 500 ether, 6 ether);
    }

    function testFuzzDepositWithdrawConserves(uint96 rawAmount) public {
        uint256 amount = 1 + (uint256(rawAmount) % 10_000 ether);
        _deposit(amount);
        uint256 withdrawal = amount / 3;
        if (withdrawal != 0) {
            vm.prank(SOLVER);
            vault.withdraw(withdrawal, SOLVER);
        }

        assertEq(vault.accountedBalance(), bit.balanceOf(address(vault)), "fuzz accounting mismatch");
    }

    function _deposit(uint256 amount) internal {
        vm.prank(SOLVER);
        vault.deposit(amount);
    }

    function _reserve(
        bytes32 swapId,
        bytes32 hash,
        address beneficiary,
        uint96 amount,
        uint96 fee
    ) internal {
        vm.prank(SOLVER);
        vault.reserve(swapId, hash, beneficiary, amount, fee, uint64(block.timestamp + 1 days));
    }
}

