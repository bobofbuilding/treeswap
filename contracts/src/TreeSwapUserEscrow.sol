// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {TreeSwapSignatureChecker} from "./TreeSwapSignatureChecker.sol";

interface IBitEscrowToken {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @notice Locks user-funded BIT for an exact BIT-to-Lightning swap.
/// @dev The solver signs a direction-specific EIP-712 quote before the user
///      deposits. Anyone may relay the Lightning preimage, but the BIT payout
///      can only reach the solver beneficiary fixed in that signed quote.
contract TreeSwapUserEscrow {
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

    struct SolverQuote {
        bytes32 quoteId;
        address user;
        address solver;
        address solverBeneficiary;
        uint96 amount;
        uint96 fee;
        uint64 lightningAmountSats;
        bytes32 paymentHash;
        bytes32 invoiceDigest;
        uint256 solverNonce;
        uint64 quoteExpiresAt;
        uint64 lastSafeClaimAt;
        uint64 refundAfter;
    }

    struct Swap {
        address user;
        address solver;
        address solverBeneficiary;
        uint96 amount;
        uint96 fee;
        uint64 lightningAmountSats;
        uint64 lastSafeClaimAt;
        uint64 refundAfter;
        bytes32 paymentHash;
        bytes32 invoiceDigest;
        uint256 solverNonce;
        SwapState state;
    }

    error InvalidAddress();
    error InvalidAmount();
    error InvalidPaymentHash();
    error InvalidInvoiceDigest();
    error InvalidRiskConfig();
    error InvalidUser();
    error InvalidSignature();
    error InvalidDeadlineOrder();
    error QuoteExpired();
    error ClaimWindowClosed();
    error PriceOutsideBand();
    error SwapAmountExceedsCap();
    error EpochVolumeExceedsCap();
    error FeeExceedsCap();
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

    bytes32 public constant BIT_TO_LIGHTNING_QUOTE_TYPEHASH = keccak256(
        "BitToLightningQuote(bytes32 quoteId,address user,address solver,address solverBeneficiary,uint96 amount,uint96 fee,uint64 lightningAmountSats,bytes32 paymentHash,bytes32 invoiceDigest,uint256 solverNonce,uint64 quoteExpiresAt,uint64 lastSafeClaimAt,uint64 refundAfter)"
    );

    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("TreeSwap User BIT Escrow");
    bytes32 private constant VERSION_HASH = keccak256("1");

    IBitEscrowToken public immutable BIT;
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

    mapping(bytes32 quoteId => Swap swap) public swaps;
    mapping(bytes32 paymentHash => bool used) public paymentHashUsed;
    mapping(address solver => mapping(uint256 nonce => bool used)) public solverNonceUsed;
    mapping(address solver => mapping(uint256 epoch => uint256 volume)) public solverEpochVolume;

    uint256 public totalLocked;
    uint256 private unlocked = 1;

    event Opened(
        bytes32 indexed quoteId,
        bytes32 indexed paymentHash,
        address indexed user,
        address solver,
        address solverBeneficiary,
        uint256 amount,
        uint256 fee,
        uint256 lightningAmountSats,
        bytes32 invoiceDigest,
        uint256 solverNonce,
        uint256 quoteExpiresAt,
        uint256 lastSafeClaimAt,
        uint256 refundAfter
    );
    event Claimed(bytes32 indexed quoteId, address indexed solverBeneficiary, uint256 payout, uint256 fee);
    event Refunded(bytes32 indexed quoteId, address indexed user, uint256 amount);

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

        BIT = IBitEscrowToken(bit);
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

    /// @notice Opens one full-fill escrow from the exact signed solver quote.
    /// @dev The user must submit the transaction; a relay cannot pull BIT from
    ///      an approved wallet or change any signed destination or amount.
    function open(SolverQuote calldata quote, bytes calldata solverSignature) external nonReentrant {
        _validateQuote(quote, solverSignature);

        uint256 epoch = block.timestamp / epochDuration;
        uint256 nextEpochVolume = solverEpochVolume[quote.solver][epoch] + quote.amount;
        if (nextEpochVolume > maxEpochVolume) revert EpochVolumeExceedsCap();

        uint256 beforeBalance = BIT.balanceOf(address(this));
        _safeTransferFrom(msg.sender, address(this), quote.amount);
        uint256 afterBalance = BIT.balanceOf(address(this));
        if (afterBalance - beforeBalance != quote.amount) revert UnexpectedTokenBalanceDelta();

        totalLocked += quote.amount;
        solverEpochVolume[quote.solver][epoch] = nextEpochVolume;
        paymentHashUsed[quote.paymentHash] = true;
        solverNonceUsed[quote.solver][quote.solverNonce] = true;
        _storeSwap(quote);
        _emitOpened(quote);
    }

    function _storeSwap(SolverQuote calldata quote) internal {
        swaps[quote.quoteId] = Swap({
            user: quote.user,
            solver: quote.solver,
            solverBeneficiary: quote.solverBeneficiary,
            amount: quote.amount,
            fee: quote.fee,
            lightningAmountSats: quote.lightningAmountSats,
            lastSafeClaimAt: quote.lastSafeClaimAt,
            refundAfter: quote.refundAfter,
            paymentHash: quote.paymentHash,
            invoiceDigest: quote.invoiceDigest,
            solverNonce: quote.solverNonce,
            state: SwapState.LOCKED
        });
    }

    function _emitOpened(SolverQuote calldata quote) internal {
        emit Opened(
            quote.quoteId,
            quote.paymentHash,
            quote.user,
            quote.solver,
            quote.solverBeneficiary,
            quote.amount,
            quote.fee,
            quote.lightningAmountSats,
            quote.invoiceDigest,
            quote.solverNonce,
            quote.quoteExpiresAt,
            quote.lastSafeClaimAt,
            quote.refundAfter
        );
    }

    /// @notice Pays only the solver beneficiary bound before Lightning payment.
    function claim(bytes32 quoteId, bytes32 preimage) external nonReentrant {
        Swap storage swap = swaps[quoteId];
        if (swap.state != SwapState.LOCKED) revert SwapNotLocked();
        if (block.timestamp >= swap.refundAfter) revert ClaimWindowClosed();
        if (sha256(abi.encodePacked(preimage)) != swap.paymentHash) revert IncorrectPreimage();

        uint256 amount = swap.amount;
        uint256 fee = swap.fee;
        address beneficiary = swap.solverBeneficiary;
        swap.state = SwapState.CLAIMED;
        totalLocked -= amount;

        _safeTransferExact(beneficiary, amount - fee);
        if (fee != 0) _safeTransferExact(feeCollector, fee);
        emit Claimed(quoteId, beneficiary, amount - fee, fee);
    }

    /// @notice Returns the complete escrow to the original user after timeout.
    ///         No execution fee is charged.
    function refund(bytes32 quoteId) external nonReentrant {
        Swap storage swap = swaps[quoteId];
        if (swap.state != SwapState.LOCKED) revert SwapNotLocked();
        if (block.timestamp < swap.refundAfter) revert RefundNotReady();

        uint256 amount = swap.amount;
        address user = swap.user;
        swap.state = SwapState.REFUNDED;
        totalLocked -= amount;
        _safeTransferExact(user, amount);
        emit Refunded(quoteId, user, amount);
    }

    function domainSeparator() public view returns (bytes32) {
        return block.chainid == initialChainId ? initialDomainSeparator : _buildDomainSeparator();
    }

    function hashSolverQuote(SolverQuote calldata quote) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                BIT_TO_LIGHTNING_QUOTE_TYPEHASH,
                quote.quoteId,
                quote.user,
                quote.solver,
                quote.solverBeneficiary,
                quote.amount,
                quote.fee,
                quote.lightningAmountSats,
                quote.paymentHash,
                quote.invoiceDigest,
                quote.solverNonce,
                quote.quoteExpiresAt,
                quote.lastSafeClaimAt,
                quote.refundAfter
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    function swapState(bytes32 quoteId) external view returns (SwapState) {
        return swaps[quoteId].state;
    }

    function swapRefundAfter(bytes32 quoteId) external view returns (uint64) {
        return swaps[quoteId].refundAfter;
    }

    function _validateQuote(SolverQuote calldata quote, bytes calldata solverSignature) internal view {
        if (msg.sender != quote.user) revert InvalidUser();
        if (quote.quoteId == bytes32(0)) revert InvalidAmount();
        if (
            quote.user == address(0) || quote.solver == address(0) || quote.solverBeneficiary == address(0)
                || quote.solverBeneficiary == address(this)
        ) revert InvalidAddress();
        if (quote.paymentHash == bytes32(0)) revert InvalidPaymentHash();
        if (quote.invoiceDigest == bytes32(0)) revert InvalidInvoiceDigest();
        if (quote.amount == 0 || quote.fee >= quote.amount || quote.lightningAmountSats == 0) revert InvalidAmount();
        if (quote.amount > maxSwapAmount) revert SwapAmountExceedsCap();
        if (uint256(quote.fee) > _feeCap(quote.amount)) revert FeeExceedsCap();
        if (block.timestamp >= quote.quoteExpiresAt) revert QuoteExpired();
        if (
            quote.quoteExpiresAt >= quote.lastSafeClaimAt
                || uint256(quote.lastSafeClaimAt) < block.timestamp + uint256(minSettlementWindow)
                || uint256(quote.refundAfter) < uint256(quote.lastSafeClaimAt) + uint256(minClaimBuffer)
                || uint256(quote.refundAfter) > block.timestamp + uint256(maxLockDuration)
        ) revert InvalidDeadlineOrder();
        if (swaps[quote.quoteId].state != SwapState.UNSET) revert SwapAlreadyExists();
        if (paymentHashUsed[quote.paymentHash]) revert PaymentHashAlreadyUsed();
        if (solverNonceUsed[quote.solver][quote.solverNonce]) revert NonceAlreadyUsed();

        _validatePriceBand(quote.amount - quote.fee, quote.lightningAmountSats);
        if (!quote.solver.isValidSignatureNow(hashSolverQuote(quote), solverSignature)) revert InvalidSignature();
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
        (bool ok, bytes memory data) =
            address(BIT).call(abi.encodeCall(IBitEscrowToken.transferFrom, (from, to, amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TokenTransferFailed();
    }

    function _safeTransferExact(address recipient, uint256 amount) internal {
        uint256 vaultBefore = BIT.balanceOf(address(this));
        uint256 recipientBefore = BIT.balanceOf(recipient);
        (bool ok, bytes memory data) = address(BIT).call(abi.encodeCall(IBitEscrowToken.transfer, (recipient, amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TokenTransferFailed();
        uint256 vaultAfter = BIT.balanceOf(address(this));
        uint256 recipientAfter = BIT.balanceOf(recipient);
        if (vaultBefore - vaultAfter != amount || recipientAfter - recipientBefore != amount) {
            revert UnexpectedTokenBalanceDelta();
        }
    }
}
