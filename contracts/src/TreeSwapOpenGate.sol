// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Fail-closed, time-limited authorization for new TreeSwap exposure.
/// @dev The immutable controller should be a timelocked multisig. The guardian
///      may halt immediately, but neither role can block escrow exits.
contract TreeSwapOpenGate {
    struct PendingOpen {
        bytes32 riskDigest;
        uint64 executeAfter;
        uint64 validUntil;
    }

    error InvalidAddress();
    error InvalidConfig();
    error Unauthorized();
    error InvalidAttestation();
    error TimelockActive();

    address public immutable controller;
    address public immutable guardian;
    uint32 public immutable resumeDelay;
    uint32 public immutable maxOpenDuration;

    bool public emergencyHalted = true;
    uint64 public openUntil;
    bytes32 public activeRiskDigest;
    PendingOpen public pendingOpen;

    event OpenScheduled(bytes32 indexed riskDigest, uint64 executeAfter, uint64 validUntil);
    event Opened(bytes32 indexed riskDigest, uint64 validUntil);
    event Halted(address indexed caller, bytes32 indexed reason);

    constructor(address controller_, address guardian_, uint32 resumeDelay_, uint32 maxOpenDuration_) {
        if (controller_ == address(0) || guardian_ == address(0)) revert InvalidAddress();
        if (resumeDelay_ == 0 || maxOpenDuration_ == 0) revert InvalidConfig();
        controller = controller_;
        guardian = guardian_;
        resumeDelay = resumeDelay_;
        maxOpenDuration = maxOpenDuration_;
    }

    function isOpen() external view returns (bool) {
        return !emergencyHalted && block.timestamp < openUntil;
    }

    /// @notice Stages a reviewed, time-limited risk snapshot. Scheduling never
    ///         reopens the gate and cannot bypass the immutable delay.
    function scheduleOpen(bytes32 riskDigest, uint64 validUntil) external {
        if (msg.sender != controller) revert Unauthorized();
        uint256 executeAfter = block.timestamp + resumeDelay;
        if (
            riskDigest == bytes32(0) || validUntil <= executeAfter
                || uint256(validUntil) > executeAfter + maxOpenDuration
        ) revert InvalidAttestation();

        pendingOpen = PendingOpen({riskDigest: riskDigest, executeAfter: uint64(executeAfter), validUntil: validUntil});
        emit OpenScheduled(riskDigest, uint64(executeAfter), validUntil);
    }

    /// @notice Anyone can execute the exact staged attestation after its delay.
    function executeOpen(bytes32 riskDigest) external {
        PendingOpen memory pending = pendingOpen;
        if (pending.riskDigest == bytes32(0) || pending.riskDigest != riskDigest) revert InvalidAttestation();
        if (block.timestamp < pending.executeAfter) revert TimelockActive();
        if (block.timestamp >= pending.validUntil) revert InvalidAttestation();

        delete pendingOpen;
        activeRiskDigest = riskDigest;
        openUntil = pending.validUntil;
        emergencyHalted = false;
        emit Opened(riskDigest, pending.validUntil);
    }

    /// @notice Halts new exposure immediately and invalidates a staged reopen.
    function halt(bytes32 reason) external {
        if (msg.sender != controller && msg.sender != guardian) revert Unauthorized();
        emergencyHalted = true;
        openUntil = 0;
        activeRiskDigest = bytes32(0);
        delete pendingOpen;
        emit Halted(msg.sender, reason);
    }
}
