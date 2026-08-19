// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Makes Lightning payment hashes single-use across both TreeSwap
///         direction-specific escrows.
/// @dev The deployment registrar installs exactly two reviewed escrows and then
///      irreversibly seals the allowlist before either escrow can consume a hash.
contract TreeSwapPaymentHashRegistry {
    error InvalidAddress();
    error Unauthorized();
    error RegistrySealed();
    error RegistryNotSealed();
    error InvalidEscrowCount();
    error PaymentHashAlreadyUsed();

    address public immutable registrar;
    bool public isSealed;
    uint8 public escrowCount;

    mapping(address escrow => bool approved) public approvedEscrow;
    mapping(bytes32 paymentHash => bool used) public paymentHashUsed;

    event EscrowRegistered(address indexed escrow);
    event RegistrySealedEvent();
    event PaymentHashConsumed(bytes32 indexed paymentHash, address indexed escrow);

    constructor(address registrar_) {
        if (registrar_ == address(0)) revert InvalidAddress();
        registrar = registrar_;
    }

    function registerEscrow(address escrow) external {
        if (msg.sender != registrar) revert Unauthorized();
        if (isSealed) revert RegistrySealed();
        if (escrow == address(0) || escrow.code.length == 0 || approvedEscrow[escrow]) revert InvalidAddress();
        if (escrowCount >= 2) revert InvalidEscrowCount();
        approvedEscrow[escrow] = true;
        escrowCount += 1;
        emit EscrowRegistered(escrow);
    }

    function seal() external {
        if (msg.sender != registrar) revert Unauthorized();
        if (isSealed) revert RegistrySealed();
        if (escrowCount != 2) revert InvalidEscrowCount();
        isSealed = true;
        emit RegistrySealedEvent();
    }

    function consumePaymentHash(bytes32 paymentHash) external {
        if (!isSealed) revert RegistryNotSealed();
        if (!approvedEscrow[msg.sender]) revert Unauthorized();
        if (paymentHash == bytes32(0) || paymentHashUsed[paymentHash]) revert PaymentHashAlreadyUsed();
        paymentHashUsed[paymentHash] = true;
        emit PaymentHashConsumed(paymentHash, msg.sender);
    }
}
