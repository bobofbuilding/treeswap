import { Interface, Wallet, id, keccak256 } from "ethers";
import {
  TREE_SWAP_BIT_TO_LIGHTNING_QUOTE_TYPES,
  TREE_SWAP_SELECTED_QUOTE_TYPES,
} from "../../lib/contract-intent-schema.mjs";

const BIT_VAULT = new Interface([
  "function reserve((bytes32 quoteId,address user,address solver,address beneficiary,uint96 amount,uint96 fee,uint64 lightningAmountSats,bytes32 paymentHash,bytes32 invoiceDigest,uint256 nonce,uint64 quoteExpiresAt,uint64 lastSafeClaimAt,uint64 refundAfter) quote,bytes userSignature,bytes solverSignature)",
]);
const USER_ESCROW = new Interface([
  "function open((bytes32 quoteId,address user,address solver,address solverBeneficiary,uint96 amount,uint96 fee,uint64 lightningAmountSats,bytes32 paymentHash,bytes32 invoiceDigest,uint256 solverNonce,uint64 quoteExpiresAt,uint64 lastSafeClaimAt,uint64 refundAfter) quote,bytes solverSignature)",
]);

export async function bindSmokeContractIntent({
  store,
  settlement,
  quoteId,
  chainId = "31337",
  verifyingContract = "0x1000000000000000000000000000000000000001",
  settlementContractCodeHash = id("treeswap-smoke-contract-code").toLowerCase(),
  userWallet = Wallet.createRandom(),
  solverWallet = Wallet.createRandom(),
  authorizedAt = settlement.createdAt,
}) {
  const lightningToBit = settlement.direction === "lightning-to-bit";
  const domain = {
    name: lightningToBit ? "TreeSwap BIT Vault" : "TreeSwap User BIT Escrow",
    version: "1",
    chainId,
    verifyingContract,
  };
  const common = {
    quoteId,
    user: userWallet.address,
    solver: solverWallet.address,
    amount: "100000000000000000",
    fee: "1000000000000000",
    lightningAmountSats: settlement.amountSats,
    paymentHash: settlement.paymentHash,
    invoiceDigest: settlement.invoiceDigest,
    quoteExpiresAt: authorizedAt + 300,
    lastSafeClaimAt: authorizedAt + 900,
    refundAfter: authorizedAt + 1_800,
  };
  const message = lightningToBit
    ? { ...common, beneficiary: userWallet.address, nonce: settlement.intentNonce }
    : { ...common, solverBeneficiary: solverWallet.address, solverNonce: "1" };
  const types = lightningToBit
    ? TREE_SWAP_SELECTED_QUOTE_TYPES
    : TREE_SWAP_BIT_TO_LIGHTNING_QUOTE_TYPES;
  const solverSignature = await solverWallet.signTypedData(domain, types, message);
  const userSignature = lightningToBit
    ? await userWallet.signTypedData(domain, types, message)
    : null;
  const data = lightningToBit
    ? BIT_VAULT.encodeFunctionData("reserve", [message, userSignature, solverSignature]).toLowerCase()
    : USER_ESCROW.encodeFunctionData("open", [message, solverSignature]).toLowerCase();
  const binding = {
    authorizedAt,
    direction: settlement.direction,
    domain,
    expiresAt: common.quoteExpiresAt,
    message,
    primaryType: lightningToBit ? "SelectedQuote" : "BitToLightningQuote",
    selectedOfferId: settlement.selectedOfferId,
    settlementContractCodeHash,
    settlementId: settlement.settlementId,
    solverSignature,
    transaction: {
      chainId: String(chainId),
      data,
      dataDigest: keccak256(data),
      from: userWallet.address,
      to: verifyingContract,
      value: "0x0",
    },
    userAuthorizationDigest: settlement.intentDigest,
    userSignature,
  };
  return store.bindContractIntent({ binding, boundAt: authorizedAt });
}
