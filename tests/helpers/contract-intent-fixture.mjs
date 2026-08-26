import {
  Interface,
  SigningKey,
  TypedDataEncoder,
  computeAddress,
  id,
  keccak256,
} from "ethers";
import {
  TREE_SWAP_BIT_TO_LIGHTNING_QUOTE_TYPES,
  TREE_SWAP_SELECTED_QUOTE_TYPES,
  validateContractIntentBinding,
} from "../../lib/contract-intent-schema.mjs";

const USER_KEY = `0x${"11".repeat(32)}`;
const SOLVER_KEY = `0x${"22".repeat(32)}`;
export const TEST_CONTRACT_USER = computeAddress(USER_KEY).toLowerCase();
export const TEST_CONTRACT_SOLVER = computeAddress(SOLVER_KEY).toLowerCase();
const BIT_VAULT = new Interface([
  "function reserve((bytes32 quoteId,address user,address solver,address beneficiary,uint96 amount,uint96 fee,uint64 lightningAmountSats,bytes32 paymentHash,bytes32 invoiceDigest,uint256 nonce,uint64 quoteExpiresAt,uint64 lastSafeClaimAt,uint64 refundAfter) quote,bytes userSignature,bytes solverSignature)",
]);
const USER_ESCROW = new Interface([
  "function open((bytes32 quoteId,address user,address solver,address solverBeneficiary,uint96 amount,uint96 fee,uint64 lightningAmountSats,bytes32 paymentHash,bytes32 invoiceDigest,uint256 solverNonce,uint64 quoteExpiresAt,uint64 lastSafeClaimAt,uint64 refundAfter) quote,bytes solverSignature)",
]);

function signed(privateKey, digest) {
  return new SigningKey(privateKey).sign(digest).serialized.toLowerCase();
}

export function testContractIntentBinding(settlement, overrides = {}) {
  const userPrivateKey = overrides.userPrivateKey ?? USER_KEY;
  const solverPrivateKey = overrides.solverPrivateKey ?? SOLVER_KEY;
  const user = computeAddress(userPrivateKey).toLowerCase();
  const solver = computeAddress(solverPrivateKey).toLowerCase();
  const direction = overrides.direction ?? settlement.direction;
  const lightningToBit = direction === "lightning-to-bit";
  const authorizedAt = overrides.authorizedAt ?? settlement.createdAt;
  const quoteExpiresAt = overrides.quoteExpiresAt ?? authorizedAt + 300;
  const lastSafeClaimAt = overrides.lastSafeClaimAt ?? authorizedAt + 3_600;
  const refundAfter = overrides.refundAfter ?? authorizedAt + 7_200;
  const domain = {
    name: lightningToBit ? "TreeSwap BIT Vault" : "TreeSwap User BIT Escrow",
    version: "1",
    chainId: overrides.chainId ?? "1",
    verifyingContract: overrides.verifyingContract
      ?? (lightningToBit ? "0x1000000000000000000000000000000000000001" : "0x2000000000000000000000000000000000000002"),
  };
  const bitAmount = overrides.bitAmount ?? "1000000";
  const feeBitAmount = overrides.feeBitAmount ?? (BigInt(bitAmount) > 100n ? "100" : "0");
  const common = {
    quoteId: overrides.quoteId ?? id(`${settlement.settlementId}:contract-quote`).toLowerCase(),
    user,
    solver,
    amount: bitAmount,
    fee: feeBitAmount,
    lightningAmountSats: settlement.amountSats,
    paymentHash: settlement.paymentHash,
    invoiceDigest: settlement.invoiceDigest,
    quoteExpiresAt,
    lastSafeClaimAt,
    refundAfter,
  };
  const message = lightningToBit
    ? { ...common, beneficiary: user, nonce: settlement.intentNonce }
    : { ...common, solverBeneficiary: solver, solverNonce: overrides.solverNonce ?? "19" };
  const types = lightningToBit ? TREE_SWAP_SELECTED_QUOTE_TYPES : TREE_SWAP_BIT_TO_LIGHTNING_QUOTE_TYPES;
  const primaryType = lightningToBit ? "SelectedQuote" : "BitToLightningQuote";
  const digest = TypedDataEncoder.hash(domain, types, message);
  const solverSignature = signed(solverPrivateKey, digest);
  const userSignature = lightningToBit ? signed(userPrivateKey, digest) : null;
  const data = lightningToBit
    ? BIT_VAULT.encodeFunctionData("reserve", [message, userSignature, solverSignature]).toLowerCase()
    : USER_ESCROW.encodeFunctionData("open", [message, solverSignature]).toLowerCase();
  const binding = {
    authorizedAt,
    direction,
    domain,
    expiresAt: quoteExpiresAt,
    message,
    primaryType,
    selectedOfferId: settlement.selectedOfferId,
    settlementContractCodeHash: overrides.settlementContractCodeHash
      ?? id(`${settlement.settlementId}:contract-code`).toLowerCase(),
    settlementId: settlement.settlementId,
    solverSignature,
    transaction: {
      chainId: String(domain.chainId),
      data,
      dataDigest: keccak256(data),
      from: user,
      to: domain.verifyingContract,
      value: "0x0",
    },
    userAuthorizationDigest: settlement.intentDigest,
    userSignature,
  };
  validateContractIntentBinding(binding);
  return Object.freeze(binding);
}

export function bindTestContractIntent(store, settlement, overrides = {}) {
  const binding = testContractIntentBinding(settlement, overrides);
  return store.bindContractIntent({
    binding,
    boundAt: overrides.boundAt ?? binding.authorizedAt,
  });
}

export function testContractIntentDigest(settlement, overrides = {}) {
  return validateContractIntentBinding(testContractIntentBinding(settlement, overrides)).contractIntentDigest;
}

export function testContractQuoteId(settlement, overrides = {}) {
  return validateContractIntentBinding(testContractIntentBinding(settlement, overrides)).quoteId;
}
