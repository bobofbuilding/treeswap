import { generateKeyPairSync, sign } from "node:crypto";
import { id, Wallet } from "ethers";
import {
  SOLVER_CAPABILITY_TYPES,
  solverCapabilityClaimsDigest,
  solverCapabilityDomain,
  solverCapabilityProofMessage,
  solverEndpointOriginDigest,
  solverEndpointPublicKeyDigest,
  solverLightningNodePubkeyDigest,
  verifySolverCapability,
} from "../../lib/solver-capability.mjs";

const DEFAULT_SOLVER_PRIVATE_KEY = `0x${"91".repeat(32)}`;
const DEFAULT_NODE_PUBKEY = `02${"92".repeat(32)}`;
const DEFAULT_LND_SIGNATURE = "y".repeat(104);

export async function createVerifiedSolverCapabilityFixture({
  now,
  chainId,
  lightningToBitContract,
  lightningToBitContractCodeHash,
  bitToLightningContract,
  bitToLightningContractCodeHash,
  direction = "lightning-to-bit",
  availableBitWei = direction === "lightning-to-bit" ? String(100n * 10n ** 18n) : "0",
  availableLightningSats = "250000",
  capacityEpoch = "7",
  observedAt = now,
  issuedAt = now - 1,
  expiresAt = now + 60,
  maxCapabilityTtlSeconds = 120,
  maxCapacityObservationAgeSeconds = 30,
  maxClockSkewSeconds = 5,
  solverPrivateKey = DEFAULT_SOLVER_PRIVATE_KEY,
  nodePubkey = DEFAULT_NODE_PUBKEY,
  endpointOrigin = "https://solver.example",
} = {}) {
  if (!Number.isSafeInteger(now) || now <= 0) throw new TypeError("fixture now is invalid");
  const solver = new Wallet(solverPrivateKey);
  const endpointKeys = generateKeyPairSync("ed25519");
  const endpointPublicKey = endpointKeys.publicKey.export({ format: "pem", type: "spki" }).toString();
  const verifyingContract = direction === "lightning-to-bit"
    ? lightningToBitContract
    : bitToLightningContract;
  const claims = {
    capabilityId: id(`solver-capability:${direction}:${solver.address}:${now}`),
    direction: id(direction),
    solver: solver.address,
    lightningNodePubkeyDigest: solverLightningNodePubkeyDigest(nodePubkey),
    endpointPublicKeyDigest: solverEndpointPublicKeyDigest(endpointPublicKey),
    endpointOriginDigest: solverEndpointOriginDigest(endpointOrigin),
    availableBitWei,
    availableLightningSats,
    capacityEpoch,
    issuedAt,
    expiresAt,
  };
  const declaration = {
    ...claims,
    proofChallenge: solverCapabilityClaimsDigest(claims, { chainId, verifyingContract }),
  };
  const proofMessage = solverCapabilityProofMessage(declaration.proofChallenge);
  const policy = {
    chainId,
    lightningToBitContract,
    lightningToBitContractCodeHash,
    bitToLightningContract,
    bitToLightningContractCodeHash,
    maxCapabilityTtlSeconds,
    maxCapacityObservationAgeSeconds,
    maxClockSkewSeconds,
  };
  const verification = await verifySolverCapability({
    envelope: {
      declaration,
      endpointOrigin,
      endpointPublicKey,
      endpointSignature: sign(null, proofMessage, endpointKeys.privateKey).toString("base64"),
      evmSignature: await solver.signTypedData(
        solverCapabilityDomain({ chainId, verifyingContract }),
        SOLVER_CAPABILITY_TYPES,
        declaration,
      ),
      lightningNodePubkey: nodePubkey,
      lightningSignature: DEFAULT_LND_SIGNATURE,
    },
    now,
    policy,
    verifyLightningNodeSignature: async () => ({ valid: true, pubkey: nodePubkey }),
    readVerifiedBitInventory: async () => ({
      availableBitWei,
      observedAt,
      solverId: solver.address,
    }),
    readVerifiedLightningCapacity: async () => ({
      availableLightningSats,
      capacityEpoch,
      nodePubkey,
      observedAt,
    }),
  });
  if (verification.valid !== true) {
    throw new Error(`solver capability fixture failed verification: ${verification.reasons.join("; ")}`);
  }
  return Object.freeze({ verification, solver });
}
