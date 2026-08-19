// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IERC20Minimal {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @notice Segregates solver-owned BIT inventory and locks exact amounts for
///         Lightning swaps. It is intentionally immutable and has no admin path.
/// @dev A solver reserves only its own available balance. The beneficiary,
///      payment hash, amount, fee, and refund time cannot change after reserve.
contract TreeSwapBitVault {
    enum SwapState {
        UNSET,
        LOCKED,
        CLAIMED,
        REFUNDED
    }

    struct Swap {
        address solver;
        address beneficiary;
        uint96 amount;
        uint96 fee;
        uint64 refundAfter;
        bytes32 paymentHash;
        SwapState state;
    }

    error InvalidAddress();
    error InvalidAmount();
    error InvalidPaymentHash();
    error InvalidRefundTime();
    error FeeExceedsCap();
    error InsufficientAvailable();
    error SwapAlreadyExists();
    error PaymentHashAlreadyUsed();
    error SwapNotLocked();
    error RefundNotReady();
    error IncorrectPreimage();
    error TokenTransferFailed();
    error UnexpectedTokenBalanceDelta();
    error Reentrancy();

    IERC20Minimal public immutable BIT;
    address public immutable feeCollector;
    uint16 public immutable maxFeeBps;
    uint16 public constant ABSOLUTE_MAX_FEE_BPS = 500;

    mapping(address solver => uint256 amount) public availableBalance;
    mapping(bytes32 swapId => Swap swap) public swaps;
    mapping(bytes32 paymentHash => bool used) public paymentHashUsed;

    uint256 public totalAvailable;
    uint256 public totalLocked;

    uint256 private unlocked = 1;

    event Deposited(address indexed solver, uint256 amount);
    event Withdrawn(address indexed solver, address indexed recipient, uint256 amount);
    event Reserved(
        bytes32 indexed swapId,
        bytes32 indexed paymentHash,
        address indexed solver,
        address beneficiary,
        uint256 amount,
        uint256 fee,
        uint256 refundAfter
    );
    event Claimed(bytes32 indexed swapId, address indexed beneficiary, uint256 payout, uint256 fee);
    event Refunded(bytes32 indexed swapId, address indexed solver, uint256 amount);

    modifier nonReentrant() {
        if (unlocked != 1) revert Reentrancy();
        unlocked = 2;
        _;
        unlocked = 1;
    }

    constructor(address bit, address collector, uint16 feeCapBps) {
        if (bit == address(0) || collector == address(0) || bit.code.length == 0) revert InvalidAddress();
        if (feeCapBps > ABSOLUTE_MAX_FEE_BPS) revert FeeExceedsCap();
        BIT = IERC20Minimal(bit);
        feeCollector = collector;
        maxFeeBps = feeCapBps;
    }

    /// @notice Adds BIT to the caller's segregated solver inventory.
    function deposit(uint256 amount) external nonReentrant {
        if (amount == 0) revert InvalidAmount();

        uint256 beforeBalance = BIT.balanceOf(address(this));
        _safeTransferFrom(msg.sender, address(this), amount);
        uint256 afterBalance = BIT.balanceOf(address(this));
        if (afterBalance - beforeBalance != amount) revert UnexpectedTokenBalanceDelta();

        availableBalance[msg.sender] += amount;
        totalAvailable += amount;
        emit Deposited(msg.sender, amount);
    }

    /// @notice Withdraws only the caller's unreserved BIT.
    function withdraw(uint256 amount, address recipient) external nonReentrant {
        if (recipient == address(0)) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();
        if (availableBalance[msg.sender] < amount) revert InsufficientAvailable();

        availableBalance[msg.sender] -= amount;
        totalAvailable -= amount;
        _safeTransferExact(recipient, amount);
        emit Withdrawn(msg.sender, recipient, amount);
    }

    /// @notice Locks caller-owned inventory for one full-fill Lightning swap.
    /// @dev The solver submits this after its signed quote is accepted. A user
    ///      must not authorize Lightning until this event is sufficiently final.
    function reserve(
        bytes32 swapId,
        bytes32 paymentHash,
        address beneficiary,
        uint96 amount,
        uint96 fee,
        uint64 refundAfter
    ) external nonReentrant {
        if (swapId == bytes32(0)) revert InvalidAmount();
        if (beneficiary == address(0)) revert InvalidAddress();
        if (paymentHash == bytes32(0)) revert InvalidPaymentHash();
        if (amount == 0 || fee >= amount) revert InvalidAmount();
        if (refundAfter <= block.timestamp) revert InvalidRefundTime();
        if (uint256(fee) > _feeCap(amount)) revert FeeExceedsCap();
        if (availableBalance[msg.sender] < amount) revert InsufficientAvailable();
        if (swaps[swapId].state != SwapState.UNSET) revert SwapAlreadyExists();
        if (paymentHashUsed[paymentHash]) revert PaymentHashAlreadyUsed();

        availableBalance[msg.sender] -= amount;
        totalAvailable -= amount;
        totalLocked += amount;
        paymentHashUsed[paymentHash] = true;
        swaps[swapId] = Swap({
            solver: msg.sender,
            beneficiary: beneficiary,
            amount: amount,
            fee: fee,
            refundAfter: refundAfter,
            paymentHash: paymentHash,
            state: SwapState.LOCKED
        });

        emit Reserved(swapId, paymentHash, msg.sender, beneficiary, amount, fee, refundAfter);
    }

    /// @notice Releases BIT to the pre-bound beneficiary. Anyone may relay the
    ///         preimage; a mempool copy cannot redirect the payout.
    function claim(bytes32 swapId, bytes32 preimage) external nonReentrant {
        Swap storage swap = swaps[swapId];
        if (swap.state != SwapState.LOCKED) revert SwapNotLocked();
        if (sha256(abi.encodePacked(preimage)) != swap.paymentHash) revert IncorrectPreimage();

        uint256 amount = swap.amount;
        uint256 fee = swap.fee;
        address beneficiary = swap.beneficiary;
        swap.state = SwapState.CLAIMED;
        totalLocked -= amount;

        _safeTransferExact(beneficiary, amount - fee);
        if (fee != 0) _safeTransferExact(feeCollector, fee);
        emit Claimed(swapId, beneficiary, amount - fee, fee);
    }

    /// @notice Returns an expired reservation to the original solver's
    ///         available inventory. No execution fee is charged.
    function refund(bytes32 swapId) external nonReentrant {
        Swap storage swap = swaps[swapId];
        if (swap.state != SwapState.LOCKED) revert SwapNotLocked();
        if (block.timestamp < swap.refundAfter) revert RefundNotReady();

        uint256 amount = swap.amount;
        address solver = swap.solver;
        swap.state = SwapState.REFUNDED;
        totalLocked -= amount;
        totalAvailable += amount;
        availableBalance[solver] += amount;
        emit Refunded(swapId, solver, amount);
    }

    function accountedBalance() external view returns (uint256) {
        return totalAvailable + totalLocked;
    }

    function _feeCap(uint256 amount) internal view returns (uint256) {
        return (amount / 10_000) * maxFeeBps + ((amount % 10_000) * maxFeeBps) / 10_000;
    }

    function _safeTransferFrom(address from, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = address(BIT).call(
            abi.encodeCall(IERC20Minimal.transferFrom, (from, to, amount))
        );
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TokenTransferFailed();
    }

    function _safeTransferExact(address recipient, uint256 amount) internal {
        uint256 beforeBalance = BIT.balanceOf(address(this));
        (bool ok, bytes memory data) = address(BIT).call(
            abi.encodeCall(IERC20Minimal.transfer, (recipient, amount))
        );
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TokenTransferFailed();
        uint256 afterBalance = BIT.balanceOf(address(this));
        if (beforeBalance - afterBalance != amount) revert UnexpectedTokenBalanceDelta();
    }
}
