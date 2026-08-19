// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {TreeSwapUserEscrow} from "../../src/TreeSwapUserEscrow.sol";
import {MockBit, MockOpenGate, MockPaymentHashRegistry, TestBase, Vm} from "../helpers/TestBase.sol";

contract UserEscrowHandler {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 internal constant SOLVER_PK = 0x5107E2;

    MockBit internal immutable bit;
    TreeSwapUserEscrow internal immutable escrow;
    address internal immutable solver;
    bytes32[] internal quoteIds;
    bytes32[] internal preimages;
    uint96[] internal amounts;
    uint256 internal sequence;

    uint256 public totalOpened;
    uint256 public totalClaimed;
    uint256 public totalRefunded;
    uint256 public maxObservedEpochVolume;

    constructor(MockBit bit_, TreeSwapUserEscrow escrow_) {
        bit = bit_;
        escrow = escrow_;
        solver = vm.addr(SOLVER_PK);
        bit.approve(address(escrow), type(uint256).max);
    }

    function open(uint96 rawAmount, uint16 rawFeeBps, uint64 rawDelay) external {
        (TreeSwapUserEscrow.SolverQuote memory quote, bytes32 preimage) = _buildQuote(rawAmount, rawFeeBps, rawDelay);
        if (quote.amount == 0) return;
        bit.mint(address(this), quote.amount);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SOLVER_PK, escrow.hashSolverQuote(quote));
        escrow.open(quote, abi.encodePacked(r, s, v));

        quoteIds.push(quote.quoteId);
        preimages.push(preimage);
        amounts.push(quote.amount);
        totalOpened += quote.amount;
        uint256 observed = escrow.solverEpochVolume(solver, block.timestamp / escrow.epochDuration());
        if (observed > maxObservedEpochVolume) maxObservedEpochVolume = observed;
    }

    function _buildQuote(uint96 rawAmount, uint16 rawFeeBps, uint64 rawDelay)
        internal
        returns (TreeSwapUserEscrow.SolverQuote memory quote, bytes32 preimage)
    {
        uint256 epoch = block.timestamp / escrow.epochDuration();
        uint256 epochRemaining = escrow.maxEpochVolume() - escrow.solverEpochVolume(solver, epoch);
        uint256 limit = _min(escrow.maxSwapAmount(), epochRemaining);
        if (limit < 1 ether) return (quote, preimage);

        quote.amount = uint96(1 ether + (uint256(rawAmount) % (limit - 1 ether + 1)));
        uint16 feeBps = uint16(uint256(rawFeeBps) % (uint256(escrow.maxFeeBps()) + 1));
        quote.fee = uint96((uint256(quote.amount) * feeBps) / 10_000);
        quote.solverNonce = sequence++;
        preimage = keccak256(abi.encode("reverse", quote.solverNonce, rawAmount, rawDelay));
        quote.quoteId = keccak256(abi.encode("reverse-quote", quote.solverNonce));
        quote.user = address(this);
        quote.solver = solver;
        quote.solverBeneficiary = address(0xBEEF);
        quote.lightningAmountSats = uint64((uint256(quote.amount - quote.fee) * escrow.referenceSatsPerBit()) / 1 ether);
        quote.paymentHash = sha256(abi.encodePacked(preimage));
        quote.invoiceDigest = keccak256(abi.encode("invoice", quote.quoteId));
        quote.quoteExpiresAt = uint64(block.timestamp + 5 minutes);
        uint64 settlementDelay = uint64(escrow.minSettlementWindow()) + uint64(uint256(rawDelay) % 30 minutes);
        quote.lastSafeClaimAt = uint64(block.timestamp) + settlementDelay;
        quote.refundAfter = quote.lastSafeClaimAt + uint64(escrow.minClaimBuffer());
    }

    function claim(uint256 rawIndex) external {
        if (quoteIds.length == 0) return;
        uint256 index = rawIndex % quoteIds.length;
        bytes32 quoteId = quoteIds[index];
        if (escrow.swapState(quoteId) != TreeSwapUserEscrow.SwapState.LOCKED) return;
        if (block.timestamp >= escrow.swapRefundAfter(quoteId)) return;
        escrow.claim(quoteId, preimages[index]);
        totalClaimed += amounts[index];
    }

    function refund(uint256 rawIndex) external {
        if (quoteIds.length == 0) return;
        uint256 index = rawIndex % quoteIds.length;
        bytes32 quoteId = quoteIds[index];
        if (escrow.swapState(quoteId) != TreeSwapUserEscrow.SwapState.LOCKED) return;
        uint64 refundAfter = escrow.swapRefundAfter(quoteId);
        if (block.timestamp < refundAfter) vm.warp(refundAfter);
        escrow.refund(quoteId);
        totalRefunded += amounts[index];
    }

    function mutateSignedQuote(uint8 rawField, uint96 rawAmount, uint64 rawDelay) external {
        (TreeSwapUserEscrow.SolverQuote memory quote,) = _buildQuote(rawAmount, 0, rawDelay);
        if (quote.amount == 0) return;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SOLVER_PK, escrow.hashSolverQuote(quote));
        _mutateQuote(quote, rawField % 13);
        bit.mint(address(this), quote.amount);

        (bool accepted,) =
            address(escrow).call(abi.encodeCall(TreeSwapUserEscrow.open, (quote, abi.encodePacked(r, s, v))));
        require(!accepted, "mutated solver quote was accepted");
    }

    function _mutateQuote(TreeSwapUserEscrow.SolverQuote memory quote, uint8 field) internal pure {
        if (field == 0) quote.quoteId = keccak256("changed reverse quote");
        else if (field == 1) quote.user = address(0xA77A);
        else if (field == 2) quote.solver = address(0x5017E2);
        else if (field == 3) quote.solverBeneficiary = address(0xA77A);
        else if (field == 4) quote.amount += 1;
        else if (field == 5) quote.fee += 1;
        else if (field == 6) quote.lightningAmountSats += 1;
        else if (field == 7) quote.paymentHash = keccak256("changed reverse payment");
        else if (field == 8) quote.invoiceDigest = keccak256("changed reverse invoice");
        else if (field == 9) quote.solverNonce += 1;
        else if (field == 10) quote.quoteExpiresAt += 1;
        else if (field == 11) quote.lastSafeClaimAt += 1;
        else quote.refundAfter += 1;
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }
}

contract TreeSwapUserEscrowInvariantTest is TestBase {
    struct FuzzSelector {
        address addr;
        bytes4[] selectors;
    }

    struct FuzzArtifactSelector {
        string artifact;
        bytes4[] selectors;
    }

    struct FuzzInterface {
        address addr;
        string[] artifacts;
    }

    MockBit internal bit;
    TreeSwapUserEscrow internal escrow;
    UserEscrowHandler internal handler;
    address[] internal targets;

    function setUp() public {
        bit = new MockBit();
        MockOpenGate gate = new MockOpenGate();
        MockPaymentHashRegistry registry = new MockPaymentHashRegistry();
        escrow = new TreeSwapUserEscrow(
            address(bit),
            address(0xFEE),
            address(gate),
            address(registry),
            TreeSwapUserEscrow.RiskConfig({
                maxFeeBps: 100,
                maxPriceDeviationBps: 1_000,
                referenceSatsPerBit: 100,
                epochDuration: 1 days,
                minSettlementWindow: 30 minutes,
                minClaimBuffer: 15 minutes,
                maxLockDuration: 2 days,
                maxSwapAmount: 1_000 ether,
                maxEpochVolume: 5_000 ether
            })
        );
        handler = new UserEscrowHandler(bit, escrow);
        targets.push(address(handler));
    }

    function targetContracts() external view returns (address[] memory) {
        return targets;
    }
    function excludeContracts() external pure returns (address[] memory values) {}
    function targetSenders() external pure returns (address[] memory values) {}
    function excludeSenders() external pure returns (address[] memory values) {}
    function targetArtifacts() external pure returns (string[] memory values) {}
    function excludeArtifacts() external pure returns (string[] memory values) {}
    function targetSelectors() external pure returns (FuzzSelector[] memory values) {}
    function excludeSelectors() external pure returns (FuzzSelector[] memory values) {}
    function targetArtifactSelectors() external pure returns (FuzzArtifactSelector[] memory values) {}
    function targetInterfaces() external pure returns (FuzzInterface[] memory values) {}

    function invariantTokenBalanceEqualsLockedLiabilities() public view {
        assertEq(bit.balanceOf(address(escrow)), escrow.totalLocked(), "reverse escrow balance diverged");
    }

    function invariantEveryDepositIsClaimedRefundedOrLocked() public view {
        assertEq(
            handler.totalOpened(),
            handler.totalClaimed() + handler.totalRefunded() + escrow.totalLocked(),
            "reverse escrow value escaped terminal accounting"
        );
    }

    function invariantEpochExposureNeverExceedsImmutableCap() public view {
        assertTrue(handler.maxObservedEpochVolume() <= escrow.maxEpochVolume(), "reverse epoch cap exceeded");
    }
}
