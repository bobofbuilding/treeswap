// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {TreeSwapOpenGate} from "../src/TreeSwapOpenGate.sol";
import {TestBase} from "./helpers/TestBase.sol";

contract TreeSwapOpenGateTest is TestBase {
    address internal constant CONTROLLER = address(0xC011EC7);
    address internal constant GUARDIAN = address(0x6A4D1A);
    address internal constant ATTACKER = address(0xBAD);
    uint32 internal constant DELAY = 1 days;
    uint32 internal constant MAX_DURATION = 2 days;

    TreeSwapOpenGate internal gate;

    function setUp() public {
        gate = new TreeSwapOpenGate(CONTROLLER, GUARDIAN, DELAY, MAX_DURATION);
    }

    function testStartsClosedAndOnlyOpensExactAttestationAfterDelay() public {
        bytes32 digest = keccak256("reviewed BIT state");
        uint64 validUntil = uint64(block.timestamp + DELAY + 1 days);
        assertTrue(!gate.isOpen(), "gate should deploy closed");

        vm.prank(CONTROLLER);
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
        vm.prank(CONTROLLER);
        gate.scheduleOpen(digest, validUntil);
        vm.warp(block.timestamp + DELAY);
        gate.executeOpen(digest);
        assertTrue(gate.isOpen(), "setup did not open gate");

        vm.prank(GUARDIAN);
        gate.halt(keccak256("BIT upgraded"));
        assertTrue(!gate.isOpen(), "guardian halt failed");

        vm.expectRevert(TreeSwapOpenGate.InvalidAttestation.selector);
        gate.executeOpen(digest);
    }

    function testCannotStageZeroExpiredOrOverlongAttestation() public {
        vm.expectRevert(TreeSwapOpenGate.InvalidAttestation.selector);
        vm.prank(CONTROLLER);
        gate.scheduleOpen(bytes32(0), uint64(block.timestamp + DELAY + 1 days));

        vm.expectRevert(TreeSwapOpenGate.InvalidAttestation.selector);
        vm.prank(CONTROLLER);
        gate.scheduleOpen(keccak256("too long"), uint64(block.timestamp + DELAY + MAX_DURATION + 1));
    }
}
