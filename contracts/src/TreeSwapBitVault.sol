// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {TreeSwapSignatureChecker} from "./TreeSwapSignatureChecker.sol";

interface IERC20Minimal {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @notice Segregates solver-owned BIT inventory and locks exact amounts for
///         Lightning-to-BIT swaps. It is intentionally immutable and has no
///         administrator or upgrade path.
/// @dev Each reservation requires a user-signed EIP-712 quote. The signature
///      binds the solver, beneficiary, amounts, invoice digest, payment hash,
///      nonce, acceptance expiry, Lightning cutoff, and Ethereum refund time.
contract TreeSwapBitVault {
    using TreeSwapSignatureChecker for address;
    enum SwapState {
        UNSET,
        LOCKED,
        CLAIMED,
        REFUNDED
    }

    struct RiskConfig {
        uint16 maxFeeBps;
        uint16 maxPriceDeviationBps;
        uint32 referenceSatsPerBit;
        uint32 epochDuration;
        uint32 minSettlementWindow;
        uint32 minClaimBuffer;
        uint32 maxLockDuration;
        uint96 maxSwapAmount;
        uint96 maxEpochVolume;
    }

    struct SelectedQuote {
        bytes32 quoteId;
        address user;
        address solver;
        address beneficiary;
        uint96 amount;
        uint96 fee;
        uint64 lightningAmountSats;
        bytes32 paymentHash;
        bytes32 invoiceDigest;
        uint256 nonce;
        uint64 quoteExpiresAt;
        uint64 lastSafeClaimAt;
        uint64 refundAfter;
    }

    struct Swap {
        address user;
        address solver;
        address beneficiary;
        uint96 amount;
        uint96 fee;
        uint64 lightningAmountSats;
        uint64 lastSafeClaimAt;
        uint64 refundAfter;
        bytes32 paymentHash;
        bytes32 invoiceDigest;
        uint256 nonce;
        SwapState state;
    }

    error InvalidAddress();
    error InvalidAmount();
    error InvalidPaymentHash();
    error InvalidInvoiceDigest();
    error InvalidRiskConfig();
    error InvalidSolver();
    error InvalidSignature();
    error InvalidDeadlineOrder();
    error QuoteExpired();
    error ClaimWindowClosed();
    error PriceOutsideBand();
    error SwapAmountExceedsCap();
    error EpochVolumeExceedsCap();
    error FeeExceedsCap();
    error InsufficientAvailable();
    error SwapAlreadyExists();
    error PaymentHashAlreadyUsed();
    error NonceAlreadyUsed();
    error SwapNotLocked();
    error RefundNotReady();
    error IncorrectPreimage();
    error TokenTransferFailed();
    error UnexpectedTokenBalanceDelta();
    error Reentrancy();

    uint16 public constant ABSOLUTE_MAX_FEE_BPS = 500;
    uint16 public constant ABSOLUTE_MAX_PRICE_DEVIATION_BPS = 2_500;
    uint256 public constant BIT_SCALE = 1 ether;

    bytes32 public constant SELECTED_QUOTE_TYPEHASH = keccak256(
        "SelectedQuote(bytes32 quoteId,address user,address solver,address beneficiary,uint96 amount,uint96 fee,uint64 lightningAmountSats,bytes32 paymentHash,bytes32 invoiceDigest,uint256 nonce,uint64 quoteExpiresAt,uint64 lastSafeClaimAt,uint64 refundAfter)"
    );

    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("TreeSwap BIT Vault");
    bytes32 private constant VERSION_HASH = keccak256("1");

    IERC20Minimal public immutable BIT;
    address public immutable feeCollector;
    uint16 public immutable maxFeeBps;
    uint16 public immutable maxPriceDeviationBps;
    uint32 public immutable referenceSatsPerBit;
    uint32 public immutable epochDuration;
    uint32 public immutable minSettlementWindow;
    uint32 public immutable minClaimBuffer;
    uint32 public immutable maxLockDuration;
    uint96 public immutable maxSwapAmount;
    uint96 public immutable maxEpochVolume;

    uint256 private immutable initialChainId;
    bytes32 private immutable initialDomainSeparator;

    mapping(address solver => uint256 amount) public availableBalance;
    mapping(bytes32 quoteId => Swap swap) public swaps;
    mapping(bytes32 paymentHash => bool used) public paymentHashUsed;
    mapping(address user => mapping(uint256 nonce => bool used)) public nonceUsed;
    mapping(address solver => mapping(uint256 epoch => uint256 volume)) public solverEpochVolume;

    uint256 public totalAvailable;
    uint256 public totalLocked;

    uint256 private unlocked = 1;

    event Deposited(address indexed solver, uint256 amount);
    event Withdrawn(address indexed solver, address indexed recipient, uint256 amount);
    event Reserved(
        bytes32 indexed quoteId,
        bytes32 indexed paymentHash,
        address indexed solver,
        address user,
        address beneficiary,
        uint256 amount,
        uint256 fee,
        uint256 lightningAmountSats,
        bytes32 invoiceDigest,
        uint256 nonce,
        uint256 quoteExpiresAt,
        uint256 lastSafeClaimAt,
        uint256 refundAfter
    );
    event Claimed(bytes32 indexed quoteId, address indexed beneficiary, uint256 payout, uint256 fee);
    event Refunded(bytes32 indexed quoteId, address indexed solver, uint256 amount);

    modifier nonReentrant() {
        if (unlocked != 1) revert Reentrancy();
        unlocked = 2;
        _;
        unlocked = 1;
    }

    constructor(address bit, address collector, RiskConfig memory config) {
        if (bit == address(0) || collector == address(0) || bit.code.length == 0) revert InvalidAddress();
        if (
            config.maxFeeBps > ABSOLUTE_MAX_FEE_BPS || config.maxPriceDeviationBps > ABSOLUTE_MAX_PRICE_DEVIATION_BPS
                || config.referenceSatsPerBit == 0 || config.epochDuration == 0 || config.minSettlementWindow == 0
                || config.minClaimBuffer == 0
                || uint256(config.maxLockDuration)
                    < uint256(config.minSettlementWindow) + uint256(config.minClaimBuffer) || config.maxSwapAmount == 0
                || config.maxEpochVolume < config.maxSwapAmount
        ) revert InvalidRiskConfig();

        BIT = IERC20Minimal(bit);
        feeCollector = collector;
        maxFeeBps = config.maxFeeBps;
        maxPriceDeviationBps = config.maxPriceDeviationBps;
        referenceSatsPerBit = config.referenceSatsPerBit;
        epochDuration = config.epochDuration;
        minSettlementWindow = config.minSettlementWindow;
        minClaimBuffer = config.minClaimBuffer;
        maxLockDuration = config.maxLockDuration;
        maxSwapAmount = config.maxSwapAmount;
        maxEpochVolume = config.maxEpochVolume;
        initialChainId = block.chainid;
        initialDomainSeparator = _buildDomainSeparator();
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

    /// @notice Locks solver-owned inventory for one user-accepted, full-fill quote.
    /// @dev The user signature is EIP-712 domain-separated by chain and vault.
    ///      A relay cannot change any quote field, and every nonce is single-use.
    function reserve(SelectedQuote calldata quote, bytes calldata userSignature) external nonReentrant {
        _validateQuote(quote, userSignature);

        uint256 epoch = block.timestamp / epochDuration;
        uint256 nextEpochVolume = solverEpochVolume[msg.sender][epoch] + quote.amount;
        if (nextEpochVolume > maxEpochVolume) revert EpochVolumeExceedsCap();

        availableBalance[msg.sender] -= quote.amount;
        totalAvailable -= quote.amount;
        totalLocked += quote.amount;
        solverEpochVolume[msg.sender][epoch] = nextEpochVolume;
        paymentHashUsed[quote.paymentHash] = true;
        nonceUsed[quote.user][quote.nonce] = true;
        _storeSwap(quote);
        _emitReserved(quote);
    }

    function _storeSwap(SelectedQuote calldata quote) internal {
        swaps[quote.quoteId] = Swap({
            user: quote.user,
            solver: quote.solver,
            beneficiary: quote.beneficiary,
            amount: quote.amount,
            fee: quote.fee,
            lightningAmountSats: quote.lightningAmountSats,
            lastSafeClaimAt: quote.lastSafeClaimAt,
            refundAfter: quote.refundAfter,
            paymentHash: quote.paymentHash,
            invoiceDigest: quote.invoiceDigest,
            nonce: quote.nonce,
            state: SwapState.LOCKED
        });
    }

    function _emitReserved(SelectedQuote calldata quote) internal {
        emit Reserved(
            quote.quoteId,
            quote.paymentHash,
            quote.solver,
            quote.user,
            quote.beneficiary,
            quote.amount,
            quote.fee,
            quote.lightningAmountSats,
            quote.invoiceDigest,
            quote.nonce,
            quote.quoteExpiresAt,
            quote.lastSafeClaimAt,
            quote.refundAfter
        );
    }

    /// @notice Releases BIT only to the beneficiary bound in the accepted quote.
    /// @dev Anyone may relay the preimage, but claims close before refunds open.
    function claim(bytes32 quoteId, bytes32 preimage) external nonReentrant {
        Swap storage swap = swaps[quoteId];
        if (swap.state != SwapState.LOCKED) revert SwapNotLocked();
        if (block.timestamp >= swap.refundAfter) revert ClaimWindowClosed();
        if (sha256(abi.encodePacked(preimage)) != swap.paymentHash) revert IncorrectPreimage();

        uint256 amount = swap.amount;
        uint256 fee = swap.fee;
        address beneficiary = swap.beneficiary;
        swap.state = SwapState.CLAIMED;
        totalLocked -= amount;

        _safeTransferExact(beneficiary, amount - fee);
        if (fee != 0) _safeTransferExact(feeCollector, fee);
        emit Claimed(quoteId, beneficiary, amount - fee, fee);
    }

    /// @notice Returns an expired reservation to the original solver inventory.
    ///         No execution fee is charged.
    function refund(bytes32 quoteId) external nonReentrant {
        Swap storage swap = swaps[quoteId];
        if (swap.state != SwapState.LOCKED) revert SwapNotLocked();
        if (block.timestamp < swap.refundAfter) revert RefundNotReady();

        uint256 amount = swap.amount;
        address solver = swap.solver;
        swap.state = SwapState.REFUNDED;
        totalLocked -= amount;
        totalAvailable += amount;
        availableBalance[solver] += amount;
        emit Refunded(quoteId, solver, amount);
    }

    function domainSeparator() public view returns (bytes32) {
        return block.chainid == initialChainId ? initialDomainSeparator : _buildDomainSeparator();
    }

    function hashSelectedQuote(SelectedQuote calldata quote) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                SELECTED_QUOTE_TYPEHASH,
                quote.quoteId,
                quote.user,
                quote.solver,
                quote.beneficiary,
                quote.amount,
                quote.fee,
                quote.lightningAmountSats,
                quote.paymentHash,
                quote.invoiceDigest,
                quote.nonce,
                quote.quoteExpiresAt,
                quote.lastSafeClaimAt,
                quote.refundAfter
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    function currentEpoch() external view returns (uint256) {
        return block.timestamp / epochDuration;
    }

    function swapState(bytes32 quoteId) external view returns (SwapState) {
        return swaps[quoteId].state;
    }

    function swapRefundAfter(bytes32 quoteId) external view returns (uint64) {
        return swaps[quoteId].refundAfter;
    }

    function accountedBalance() external view returns (uint256) {
        return totalAvailable + totalLocked;
    }

    function _validateQuote(SelectedQuote calldata quote, bytes calldata userSignature) internal view {
        if (quote.quoteId == bytes32(0)) revert InvalidAmount();
        if (quote.user == address(0) || quote.beneficiary == address(0)) revert InvalidAddress();
        if (quote.solver != msg.sender) revert InvalidSolver();
        if (quote.paymentHash == bytes32(0)) revert InvalidPaymentHash();
        if (quote.invoiceDigest == bytes32(0)) revert InvalidInvoiceDigest();
        if (quote.amount == 0 || quote.fee >= quote.amount || quote.lightningAmountSats == 0) {
            revert InvalidAmount();
        }
        if (quote.amount > maxSwapAmount) revert SwapAmountExceedsCap();
        if (uint256(quote.fee) > _feeCap(quote.amount)) revert FeeExceedsCap();
        if (block.timestamp >= quote.quoteExpiresAt) revert QuoteExpired();
        if (
            quote.quoteExpiresAt >= quote.lastSafeClaimAt
                || uint256(quote.lastSafeClaimAt) < block.timestamp + uint256(minSettlementWindow)
                || uint256(quote.refundAfter) < uint256(quote.lastSafeClaimAt) + uint256(minClaimBuffer)
                || uint256(quote.refundAfter) > block.timestamp + uint256(maxLockDuration)
        ) revert InvalidDeadlineOrder();
        if (availableBalance[msg.sender] < quote.amount) revert InsufficientAvailable();
        if (swaps[quote.quoteId].state != SwapState.UNSET) revert SwapAlreadyExists();
        if (paymentHashUsed[quote.paymentHash]) revert PaymentHashAlreadyUsed();
        if (nonceUsed[quote.user][quote.nonce]) revert NonceAlreadyUsed();

        _validatePriceBand(quote.amount - quote.fee, quote.lightningAmountSats);
        if (!quote.user.isValidSignatureNow(hashSelectedQuote(quote), userSignature)) revert InvalidSignature();
    }

    function _validatePriceBand(uint256 netBitAmount, uint256 lightningAmountSats) internal view {
        uint256 quotedSatsScaled = lightningAmountSats * BIT_SCALE * 10_000;
        uint256 referenceScaled = netBitAmount * referenceSatsPerBit;
        uint256 lowerBound = referenceScaled * (10_000 - maxPriceDeviationBps);
        uint256 upperBound = referenceScaled * (10_000 + maxPriceDeviationBps);
        if (quotedSatsScaled < lowerBound || quotedSatsScaled > upperBound) revert PriceOutsideBand();
    }

    function _buildDomainSeparator() internal view returns (bytes32) {
        return keccak256(abi.encode(EIP712_DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    }

    function _feeCap(uint256 amount) internal view returns (uint256) {
        return (amount / 10_000) * maxFeeBps + ((amount % 10_000) * maxFeeBps) / 10_000;
    }

    function _safeTransferFrom(address from, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = address(BIT).call(abi.encodeCall(IERC20Minimal.transferFrom, (from, to, amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TokenTransferFailed();
    }

    function _safeTransferExact(address recipient, uint256 amount) internal {
        uint256 beforeBalance = BIT.balanceOf(address(this));
        (bool ok, bytes memory data) = address(BIT).call(abi.encodeCall(IERC20Minimal.transfer, (recipient, amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TokenTransferFailed();
        uint256 afterBalance = BIT.balanceOf(address(this));
        if (beforeBalance - afterBalance != amount) revert UnexpectedTokenBalanceDelta();
    }
}
