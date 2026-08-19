// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {TreeSwapOpenGate} from "../src/TreeSwapOpenGate.sol";
import {TestBase} from "./helpers/TestBase.sol";

contract GovernanceTarget {}

contract TreeSwapOpenGateTest is TestBase {
    address internal constant ATTACKER = address(0xBAD);
    uint32 internal constant DELAY = 1 days;
    uint32 internal constant MAX_DURATION = 2 days;

    TreeSwapOpenGate internal gate;
    address internal controller;
    address internal guardian;

    function setUp() public {
        controller = address(new GovernanceTarget());
        guardian = address(new GovernanceTarget());
        gate = new TreeSwapOpenGate(controller, guardian, DELAY, MAX_DURATION);
    }

    function testStartsClosedAndOnlyOpensExactAttestationAfterDelay() public {
        bytes32 digest = keccak256("reviewed BIT state");
        uint64 validUntil = uint64(block.timestamp + DELAY + 1 days);
        assertTrue(!gate.isOpen(), "gate should deploy closed");

        vm.prank(controller);
        gate.scheduleOpen(digest, validUntil);
        vm.expectRevert(TreeSwapOpenGate.TimelockActive.selector);
        gate.executeOpen(digest);

        vm.warp(block.timestamp + DELAY);
        gate.executeOpen(digest);
        assertTrue(gate.isOpen(), "delayed attestation did not open gate");
        assertEq(uint256(gate.openUntil()), uint256(validUntil), "wrong automatic expiry");

        vm.warp(validUntil);
        assertTrue(!gate.isOpen(), "stale attestation remained open");
    }

    function testUnauthorizedAccountsCannotOpenOrHalt() public {
        bytes32 digest = keccak256("risk snapshot");
        uint64 validUntil = uint64(block.timestamp + DELAY + 1 days);

        vm.expectRevert(TreeSwapOpenGate.Unauthorized.selector);
        vm.prank(ATTACKER);
        gate.scheduleOpen(digest, validUntil);

        vm.expectRevert(TreeSwapOpenGate.Unauthorized.selector);
        vm.prank(ATTACKER);
        gate.halt(keccak256("fake alarm"));
    }

    function testGuardianHaltsImmediatelyAndCancelsPendingReopen() public {
        bytes32 digest = keccak256("risk snapshot");
        uint64 validUntil = uint64(block.timestamp + DELAY + 1 days);
        vm.prank(controller);
        gate.scheduleOpen(digest, validUntil);
        vm.warp(block.timestamp + DELAY);
        gate.executeOpen(digest);
        assertTrue(gate.isOpen(), "setup did not open gate");

        vm.prank(guardian);
        gate.halt(keccak256("BIT upgraded"));
        assertTrue(!gate.isOpen(), "guardian halt failed");

        vm.expectRevert(TreeSwapOpenGate.InvalidAttestation.selector);
        gate.executeOpen(digest);
    }

    function testCannotStageZeroExpiredOrOverlongAttestation() public {
        vm.expectRevert(TreeSwapOpenGate.InvalidAttestation.selector);
        vm.prank(controller);
        gate.scheduleOpen(bytes32(0), uint64(block.timestamp + DELAY + 1 days));

        vm.expectRevert(TreeSwapOpenGate.InvalidAttestation.selector);
        vm.prank(controller);
        gate.scheduleOpen(keccak256("too long"), uint64(block.timestamp + DELAY + MAX_DURATION + 1));
    }

    function testRejectsEOAsSharedRolesAndUnsafeTiming() public {
        vm.expectRevert(TreeSwapOpenGate.InvalidAddress.selector);
        new TreeSwapOpenGate(ATTACKER, guardian, DELAY, MAX_DURATION);

        vm.expectRevert(TreeSwapOpenGate.InvalidAddress.selector);
        new TreeSwapOpenGate(controller, controller, DELAY, MAX_DURATION);

        vm.expectRevert(TreeSwapOpenGate.InvalidConfig.selector);
        new TreeSwapOpenGate(controller, guardian, DELAY - 1, MAX_DURATION);

        uint32 unsafeOpenDuration = gate.MAX_OPEN_DURATION_LIMIT() + 1;
        vm.expectRevert(TreeSwapOpenGate.InvalidConfig.selector);
        new TreeSwapOpenGate(controller, guardian, DELAY, unsafeOpenDuration);
    }
}
