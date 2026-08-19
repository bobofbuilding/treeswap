// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {TreeSwapPaymentHashRegistry} from "../src/TreeSwapPaymentHashRegistry.sol";
import {TestBase} from "./helpers/TestBase.sol";

contract HashConsumer {
    function consume(TreeSwapPaymentHashRegistry registry, bytes32 paymentHash) external {
        registry.consumePaymentHash(paymentHash);
    }
}

contract TreeSwapPaymentHashRegistryTest is TestBase {
    TreeSwapPaymentHashRegistry internal registry;
    HashConsumer internal vault;
    HashConsumer internal userEscrow;
    HashConsumer internal attacker;

    function setUp() public {
        registry = new TreeSwapPaymentHashRegistry(address(this));
        vault = new HashConsumer();
        userEscrow = new HashConsumer();
        attacker = new HashConsumer();
    }

    function testSamePaymentHashCannotCrossDirectionEscrows() public {
        registry.registerEscrow(address(vault));
        registry.registerEscrow(address(userEscrow));
        registry.seal();
        bytes32 paymentHash = keccak256("shared-payment-hash");

        vault.consume(registry, paymentHash);
        vm.expectRevert(TreeSwapPaymentHashRegistry.PaymentHashAlreadyUsed.selector);
        userEscrow.consume(registry, paymentHash);
    }

    function testCannotConsumeBeforeExactTwoEscrowsAreSealed() public {
        registry.registerEscrow(address(vault));
        vm.expectRevert(TreeSwapPaymentHashRegistry.InvalidEscrowCount.selector);
        registry.seal();

        vm.expectRevert(TreeSwapPaymentHashRegistry.RegistryNotSealed.selector);
        vault.consume(registry, keccak256("too-early"));
    }

    function testUnapprovedCallerCannotConsumeAfterSeal() public {
        registry.registerEscrow(address(vault));
        registry.registerEscrow(address(userEscrow));
        registry.seal();

        vm.expectRevert(TreeSwapPaymentHashRegistry.Unauthorized.selector);
        attacker.consume(registry, keccak256("unauthorized"));
    }

    function testSealedRegistryCannotChangeEscrowAllowlist() public {
        registry.registerEscrow(address(vault));
        registry.registerEscrow(address(userEscrow));
        registry.seal();

        vm.expectRevert(TreeSwapPaymentHashRegistry.RegistrySealed.selector);
        registry.registerEscrow(address(attacker));
    }
}
