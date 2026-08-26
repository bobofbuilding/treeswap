import { createPublicKey, verify as verifySignature } from "node:crypto";
import {
  getAddress,
  id,
  keccak256,
  toUtf8Bytes,
  TypedDataEncoder,
  verifyTypedData,
} from "ethers";

export const SOLVER_CAPABILITY_CLAIM_TYPES = Object.freeze({
  SolverCapabilityClaims: Object.freeze([
    Object.freeze({ name: "capabilityId", type: "bytes32" }),
    Object.freeze({ name: "direction", type: "bytes32" }),
    Object.freeze({ name: "solver", type: "address" }),
    Object.freeze({ name: "lightningNodePubkeyDigest", type: "bytes32" }),
    Object.freeze({ name: "endpointPublicKeyDigest", type: "bytes32" }),
    Object.freeze({ name: "endpointOriginDigest", type: "bytes32" }),
    Object.freeze({ name: "availableBitWei", type: "uint256" }),
    Object.freeze({ name: "availableLightningSats", type: "uint64" }),
    Object.freeze({ name: "capacityEpoch", type: "uint64" }),
    Object.freeze({ name: "issuedAt", type: "uint64" }),
    Object.freeze({ name: "expiresAt", type: "uint64" }),
  ]),
});

export const SOLVER_CAPABILITY_TYPES = Object.freeze({
  SolverCapability: Object.freeze([
    ...SOLVER_CAPABILITY_CLAIM_TYPES.SolverCapabilityClaims,
    Object.freeze({ name: "proofChallenge", type: "bytes32" }),
  ]),
});

const BYTES32 = /^0x[0-9a-f]{64}$/;
const COMPRESSED_NODE_PUBKEY = /^(?:02|03)[0-9a-f]{64}$/;
const EVM_SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
const LND_ZBASE32_SIGNATURE = /^[ybndrfg8ejkmcpqxot1uwisza345h769]{104}$/;
const DIRECTIONS = new Set(["lightning-to-bit", "bit-to-lightning"]);
const UINT64_MAX = (1n << 64n) - 1n;
const UINT256_MAX = (1n << 256n) - 1n;
const VERIFIED_CAPABILITIES = new WeakSet();

function exactKeys(value, expected, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${name} fields are not exact`);
  }
}

function bytes32(value, name) {
  const raw = String(value ?? "");
  if (!BYTES32.test(raw)) throw new TypeError(`${name} must be lowercase bytes32`);
  return raw;
}

function uint(value, name, maximum) {
  try {
    const parsed = BigInt(value);
    if (parsed < 0n || parsed > maximum || String(value) !== parsed.toString()) throw new Error();
    return parsed;
  } catch {
    throw new TypeError(`${name} must be a canonical bounded unsigned integer`);
  }
}

function integer(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative safe integer`);
  return value;
}

function address(value, name) {
  try {
    return getAddress(value).toLowerCase();
  } catch {
    throw new TypeError(`${name} must be an Ethereum address`);
  }
}

function directionHash(direction) {
  if (!DIRECTIONS.has(direction)) throw new RangeError("solver capability direction is unsupported");
  return id(direction);
}

function normalizeOrigin(value) {
  const raw = String(value ?? "");
  if (raw.length === 0 || raw.length > 256) throw new TypeError("solver endpoint origin is invalid");
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new TypeError("solver endpoint origin is invalid");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/"
      || parsed.search || parsed.hash || parsed.origin !== raw) {
    throw new TypeError("solver endpoint must be one canonical credential-free HTTPS origin");
  }
  return raw;
}

function normalizeEndpointKey(pem) {
  const raw = String(pem ?? "");
  if (raw.length === 0 || raw.length > 512) throw new TypeError("solver endpoint public key is invalid");
  let key;
  try {
    key = createPublicKey(raw);
  } catch {
    throw new TypeError("solver endpoint public key is invalid");
  }
  if (key.asymmetricKeyType !== "ed25519") throw new TypeError("solver endpoint key must be Ed25519");
  return key;
}

function canonicalBase64(value, bytes, name) {
  const raw = String(value ?? "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) throw new TypeError(`${name} is not canonical base64`);
  const decoded = Buffer.from(raw, "base64");
  if (decoded.length !== bytes || decoded.toString("base64") !== raw) throw new TypeError(`${name} is invalid`);
  return decoded;
}

function normalizePolicy(raw) {
  exactKeys(raw, [
    "bitToLightningContract", "bitToLightningContractCodeHash", "chainId", "lightningToBitContract",
    "lightningToBitContractCodeHash", "maxCapabilityTtlSeconds", "maxCapacityObservationAgeSeconds",
    "maxClockSkewSeconds",
  ], "solver capability policy");
  const policy = Object.freeze({
    chainId: uint(raw.chainId, "policy.chainId", UINT256_MAX),
    lightningToBitContract: address(raw.lightningToBitContract, "policy.lightningToBitContract"),
    bitToLightningContract: address(raw.bitToLightningContract, "policy.bitToLightningContract"),
    lightningToBitContractCodeHash: bytes32(
      raw.lightningToBitContractCodeHash,
      "policy.lightningToBitContractCodeHash",
    ),
    bitToLightningContractCodeHash: bytes32(
      raw.bitToLightningContractCodeHash,
      "policy.bitToLightningContractCodeHash",
    ),
    maxCapabilityTtlSeconds: integer(raw.maxCapabilityTtlSeconds, "policy.maxCapabilityTtlSeconds"),
    maxCapacityObservationAgeSeconds: integer(
      raw.maxCapacityObservationAgeSeconds,
      "policy.maxCapacityObservationAgeSeconds",
    ),
    maxClockSkewSeconds: integer(raw.maxClockSkewSeconds, "policy.maxClockSkewSeconds"),
  });
  if (policy.maxCapabilityTtlSeconds === 0 || policy.maxCapabilityTtlSeconds > 3_600) {
    throw new RangeError("solver capability lifetime is outside policy");
  }
  if (policy.maxClockSkewSeconds > 60) throw new RangeError("solver capability clock skew is outside policy");
  if (policy.maxCapacityObservationAgeSeconds === 0 || policy.maxCapacityObservationAgeSeconds > 300) {
    throw new RangeError("solver capacity observation age is outside policy");
  }
  if (policy.lightningToBitContract === policy.bitToLightningContract) {
    throw new Error("solver capability contracts must be direction-specific");
  }
  return policy;
}

function normalizeDeclaration(raw) {
  exactKeys(raw, [
    "availableBitWei", "availableLightningSats", "capabilityId", "capacityEpoch", "direction",
    "endpointOriginDigest", "endpointPublicKeyDigest", "expiresAt", "issuedAt",
    "lightningNodePubkeyDigest", "proofChallenge", "solver",
  ], "solver capability declaration");
  const capabilityId = bytes32(raw.capabilityId, "declaration.capabilityId");
  if (capabilityId === `0x${"0".repeat(64)}`) throw new RangeError("solver capability identifier must be non-zero");
  return Object.freeze({
    capabilityId,
    direction: bytes32(raw.direction, "declaration.direction"),
    solver: address(raw.solver, "declaration.solver"),
    lightningNodePubkeyDigest: bytes32(raw.lightningNodePubkeyDigest, "declaration.lightningNodePubkeyDigest"),
    endpointPublicKeyDigest: bytes32(raw.endpointPublicKeyDigest, "declaration.endpointPublicKeyDigest"),
    endpointOriginDigest: bytes32(raw.endpointOriginDigest, "declaration.endpointOriginDigest"),
    availableBitWei: uint(raw.availableBitWei, "declaration.availableBitWei", UINT256_MAX),
    availableLightningSats: uint(raw.availableLightningSats, "declaration.availableLightningSats", UINT64_MAX),
    capacityEpoch: uint(raw.capacityEpoch, "declaration.capacityEpoch", BigInt(Number.MAX_SAFE_INTEGER)),
    issuedAt: integer(raw.issuedAt, "declaration.issuedAt"),
    expiresAt: integer(raw.expiresAt, "declaration.expiresAt"),
    proofChallenge: bytes32(raw.proofChallenge, "declaration.proofChallenge"),
  });
}

function claimsFromDeclaration(declaration) {
  const claims = { ...declaration };
  delete claims.proofChallenge;
  return claims;
}

export function solverCapabilityDomain({ chainId, verifyingContract }) {
  return Object.freeze({
    name: "TreeSwap Solver Capability",
    version: "1",
    chainId: uint(chainId, "chainId", UINT256_MAX),
    verifyingContract: address(verifyingContract, "verifyingContract"),
  });
}

export function solverCapabilityClaimsDigest(claims, { chainId, verifyingContract }) {
  const normalized = normalizeDeclaration({ ...claims, proofChallenge: `0x${"00".repeat(32)}` });
  return TypedDataEncoder.hash(
    solverCapabilityDomain({ chainId, verifyingContract }),
    SOLVER_CAPABILITY_CLAIM_TYPES,
    claimsFromDeclaration(normalized),
  );
}

export function solverCapabilityProofMessage(proofChallenge) {
  return Buffer.from(`TreeSwap solver capability v1\n${bytes32(proofChallenge, "proofChallenge")}\n`, "utf8");
}

export function solverEndpointPublicKeyDigest(publicKeyPem) {
  const key = normalizeEndpointKey(publicKeyPem);
  return keccak256(key.export({ format: "der", type: "spki" }));
}

export function solverEndpointOriginDigest(endpointOrigin) {
  return keccak256(toUtf8Bytes(normalizeOrigin(endpointOrigin)));
}

export function solverLightningNodePubkeyDigest(nodePubkey) {
  const raw = String(nodePubkey ?? "").toLowerCase();
  if (!COMPRESSED_NODE_PUBKEY.test(raw)) throw new TypeError("Lightning node pubkey must be compressed hex");
  return keccak256(`0x${raw}`);
}

export function verifiedSolverQuoteBinding(verification) {
  if (!verification || !VERIFIED_CAPABILITIES.has(verification)) {
    throw new TypeError("solver quote binding requires a locally verified capability");
  }
  return Object.freeze({
    chainId: verification.binding.chainId,
    direction: verification.binding.direction,
    solverId: verification.binding.solverId,
    capabilityDigest: verification.capabilityDigest,
    capacitySnapshotDigest: verification.capacitySnapshotDigest,
    endpointOrigin: verification.binding.endpointOrigin,
    endpointPublicKeyDigest: verification.binding.endpointPublicKeyDigest,
    settlementContract: verification.binding.settlementContract,
    settlementContractCodeHash: verification.binding.settlementContractCodeHash,
    capacityEpoch: verification.capacitySnapshot.capacityEpoch,
    availableBitWei: verification.capacitySnapshot.availableBitWei,
    availableLightningSats: verification.capacitySnapshot.availableLightningSats,
    expiresAt: verification.expiresAt,
  });
}

export function verifiedSolverEndpointTransportBinding(verification) {
  if (!verification || !VERIFIED_CAPABILITIES.has(verification)) {
    throw new TypeError("solver endpoint transport binding requires a locally verified capability");
  }
  return Object.freeze({
    ...verifiedSolverQuoteBinding(verification),
    endpointPublicKey: verification.binding.endpointPublicKey,
  });
}

export function verifiedSolverCapacityRecord(verification) {
  if (!verification || !VERIFIED_CAPABILITIES.has(verification)) {
    throw new TypeError("solver capacity record requires a locally verified capability");
  }
  return Object.freeze({
    ...verification.capacitySnapshot,
    solverId: verification.capacitySnapshot.solverId.toLowerCase(),
  });
}

export function verifiedSolverRecoveryAuthority(verification) {
  if (!verification || !VERIFIED_CAPABILITIES.has(verification)) {
    throw new TypeError("solver recovery authority requires a locally verified capability");
  }
  return Object.freeze({
    capabilityDigest: verification.capabilityDigest,
    capacityObservedAt: verification.capacitySnapshot.observedAt,
    direction: verification.binding.direction,
    endpointPublicKeyDigest: verification.binding.endpointPublicKeyDigest,
    expiresAt: verification.expiresAt,
    lightningNodePubkey: verification.binding.lightningNodePubkey,
    settlementContract: verification.binding.settlementContract,
    settlementContractCodeHash: verification.binding.settlementContractCodeHash,
    solverId: verification.binding.solverId,
  });
}

export async function verifySolverCapability({
  envelope,
  now,
  policy,
  verifyLightningNodeSignature,
  readVerifiedBitInventory,
  readVerifiedLightningCapacity,
}) {
  const reasons = [];
  let declaration;
  let boundPolicy;
  let endpointKey;
  let endpointOrigin;
  let endpointSignature;
  let lightningNodePubkey;
  let lightningSignature;
  let evmSignature;
  const observedAt = integer(now, "now");

  try {
    if (typeof verifyLightningNodeSignature !== "function") throw new TypeError("Lightning node verifier is required");
    if (typeof readVerifiedBitInventory !== "function") throw new TypeError("BIT inventory reader is required");
    if (typeof readVerifiedLightningCapacity !== "function") throw new TypeError("Lightning capacity reader is required");
    exactKeys(envelope, [
      "declaration", "endpointOrigin", "endpointPublicKey", "endpointSignature", "evmSignature",
      "lightningNodePubkey", "lightningSignature",
    ], "solver capability envelope");
    declaration = normalizeDeclaration(envelope.declaration);
    boundPolicy = normalizePolicy(policy);
    endpointKey = normalizeEndpointKey(envelope.endpointPublicKey);
    endpointOrigin = normalizeOrigin(envelope.endpointOrigin);
    endpointSignature = canonicalBase64(envelope.endpointSignature, 64, "endpoint signature");
    lightningNodePubkey = String(envelope.lightningNodePubkey ?? "").toLowerCase();
    if (!COMPRESSED_NODE_PUBKEY.test(lightningNodePubkey)) throw new TypeError("Lightning node pubkey must be compressed hex");
    lightningSignature = String(envelope.lightningSignature ?? "");
    if (!LND_ZBASE32_SIGNATURE.test(lightningSignature)) throw new TypeError("Lightning node signature is not canonical zbase32");
    evmSignature = String(envelope.evmSignature ?? "");
    if (!EVM_SIGNATURE.test(evmSignature)) throw new TypeError("solver EVM signature is not canonical");
  } catch (error) {
    return Object.freeze({
      valid: false,
      reasons: Object.freeze([String(error?.message ?? "solver capability envelope is invalid")]),
    });
  }

  const direction = declaration.direction === directionHash("lightning-to-bit")
    ? "lightning-to-bit"
    : declaration.direction === directionHash("bit-to-lightning") ? "bit-to-lightning" : null;
  if (!direction) reasons.push("solver capability direction hash is unsupported");
  if (declaration.capacityEpoch === 0n) reasons.push("solver capacity epoch must be positive");
  if (direction === "lightning-to-bit"
      && (declaration.availableBitWei === 0n || declaration.availableLightningSats === 0n)) {
    reasons.push("Lightning-to-BIT capability requires prefunded BIT and inbound Lightning capacity");
  }
  if (direction === "bit-to-lightning") {
    if (declaration.availableBitWei !== 0n) reasons.push("BIT-to-Lightning capability must not claim solver BIT inventory");
    if (declaration.availableLightningSats === 0n) reasons.push("BIT-to-Lightning capability requires outbound Lightning capacity");
  }
  if (declaration.issuedAt > observedAt + boundPolicy.maxClockSkewSeconds) {
    reasons.push("solver capability issuance is in the future");
  }
  if (declaration.expiresAt <= observedAt) reasons.push("solver capability expired");
  if (declaration.expiresAt <= declaration.issuedAt
      || declaration.expiresAt - declaration.issuedAt > boundPolicy.maxCapabilityTtlSeconds) {
    reasons.push("solver capability lifetime exceeds policy");
  }

  const verifyingContract = direction === "lightning-to-bit"
    ? boundPolicy.lightningToBitContract
    : direction === "bit-to-lightning" ? boundPolicy.bitToLightningContract : null;
  const settlementContractCodeHash = direction === "lightning-to-bit"
    ? boundPolicy.lightningToBitContractCodeHash
    : direction === "bit-to-lightning" ? boundPolicy.bitToLightningContractCodeHash : null;
  if (verifyingContract) {
    const claimsDigest = solverCapabilityClaimsDigest(claimsFromDeclaration(declaration), {
      chainId: boundPolicy.chainId,
      verifyingContract,
    });
    if (claimsDigest !== declaration.proofChallenge) reasons.push("solver capability proof challenge changed");
  }
  if (solverEndpointPublicKeyDigest(envelope.endpointPublicKey) !== declaration.endpointPublicKeyDigest) {
    reasons.push("solver endpoint public key changed");
  }
  if (solverEndpointOriginDigest(endpointOrigin) !== declaration.endpointOriginDigest) {
    reasons.push("solver endpoint origin changed");
  }
  if (solverLightningNodePubkeyDigest(lightningNodePubkey) !== declaration.lightningNodePubkeyDigest) {
    reasons.push("solver Lightning node pubkey changed");
  }

  const proofMessage = solverCapabilityProofMessage(declaration.proofChallenge);
  if (!verifySignature(null, proofMessage, endpointKey, endpointSignature)) {
    reasons.push("solver endpoint possession proof is invalid");
  }

  if (direction) {
    try {
      const recovered = verifyTypedData(
        solverCapabilityDomain({ chainId: boundPolicy.chainId, verifyingContract }),
        SOLVER_CAPABILITY_TYPES,
        declaration,
        evmSignature,
      );
      if (address(recovered, "recovered solver") !== declaration.solver) reasons.push("solver EVM signature is invalid");
    } catch {
      reasons.push("solver EVM signature is invalid");
    }
  }

  let lightningVerification = null;
  if (reasons.length === 0) {
    try {
      lightningVerification = await verifyLightningNodeSignature(Object.freeze({
        message: Buffer.from(proofMessage),
        signature: lightningSignature,
      }));
      exactKeys(lightningVerification, ["pubkey", "valid"], "Lightning verification result");
      const recoveredPubkey = String(lightningVerification.pubkey ?? "").toLowerCase();
      if (lightningVerification.valid !== true || !COMPRESSED_NODE_PUBKEY.test(recoveredPubkey)
          || recoveredPubkey !== lightningNodePubkey) {
        reasons.push("Lightning node possession proof is invalid");
      }
    } catch {
      reasons.push("Lightning node possession proof could not be verified");
    }
  }

  if (reasons.length !== 0) return Object.freeze({ valid: false, reasons: Object.freeze(reasons) });
  const capabilityDigest = TypedDataEncoder.hash(
    solverCapabilityDomain({ chainId: boundPolicy.chainId, verifyingContract }),
    SOLVER_CAPABILITY_TYPES,
    declaration,
  );
  let bitObservation;
  let lightningObservation;
  try {
    [bitObservation, lightningObservation] = await Promise.all([
      readVerifiedBitInventory(Object.freeze({
        capabilityDigest,
        direction,
        solverId: declaration.solver,
        verifyingContract,
      })),
      readVerifiedLightningCapacity(Object.freeze({
        capabilityDigest,
        capacityEpoch: declaration.capacityEpoch.toString(),
        direction,
        endpointOrigin,
        endpointPublicKey: endpointKey,
        lightningNodePubkey,
        solverId: declaration.solver,
      })),
    ]);
    exactKeys(bitObservation, ["availableBitWei", "observedAt", "solverId"], "BIT inventory observation");
    exactKeys(
      lightningObservation,
      ["availableLightningSats", "capacityEpoch", "nodePubkey", "observedAt"],
      "Lightning capacity observation",
    );
  } catch {
    return Object.freeze({
      valid: false,
      reasons: Object.freeze(["independent solver capacity could not be verified"]),
    });
  }
  let observedBitWei;
  let observedLightningSats;
  let bitObservedAt;
  let lightningObservedAt;
  try {
    observedBitWei = uint(bitObservation.availableBitWei, "observed BIT inventory", UINT256_MAX);
    observedLightningSats = uint(
      lightningObservation.availableLightningSats,
      "observed Lightning capacity",
      UINT64_MAX,
    );
    bitObservedAt = integer(bitObservation.observedAt, "BIT inventory observedAt");
    lightningObservedAt = integer(lightningObservation.observedAt, "Lightning capacity observedAt");
    if (address(bitObservation.solverId, "observed BIT solver") !== declaration.solver) {
      reasons.push("BIT inventory belongs to another solver");
    }
    if (String(lightningObservation.nodePubkey ?? "").toLowerCase() !== lightningNodePubkey) {
      reasons.push("Lightning capacity belongs to another node");
    }
    if (uint(lightningObservation.capacityEpoch, "observed capacity epoch", UINT64_MAX)
        !== declaration.capacityEpoch) {
      reasons.push("authenticated Lightning capacity epoch changed");
    }
  } catch {
    return Object.freeze({
      valid: false,
      reasons: Object.freeze(["independent solver capacity result is malformed"]),
    });
  }
  if (observedBitWei < declaration.availableBitWei) reasons.push("declared BIT inventory exceeds verified inventory");
  if (observedLightningSats < declaration.availableLightningSats) {
    reasons.push("declared Lightning capacity exceeds verified capacity");
  }
  for (const [label, observed] of [["BIT inventory", bitObservedAt], ["Lightning capacity", lightningObservedAt]]) {
    if (observed > observedAt + boundPolicy.maxClockSkewSeconds
        || observedAt - observed > boundPolicy.maxCapacityObservationAgeSeconds) {
      reasons.push(`${label} observation is stale or in the future`);
    }
  }
  if (reasons.length !== 0) return Object.freeze({ valid: false, reasons: Object.freeze(reasons) });
  const capacitySnapshot = Object.freeze({
    solverId: declaration.solver,
    capabilityDigest,
    capabilityVerified: true,
    capabilityExpiresAt: declaration.expiresAt,
    capacityEpoch: Number(declaration.capacityEpoch),
    availableBitWei: declaration.availableBitWei.toString(),
    availableLightningSats: declaration.availableLightningSats.toString(),
    observedAt: Math.min(bitObservedAt, lightningObservedAt),
  });
  const capacitySnapshotDigest = keccak256(toUtf8Bytes(JSON.stringify(capacitySnapshot)));
  const result = Object.freeze({
    valid: true,
    reasons: Object.freeze([]),
    capabilityDigest,
    capacitySnapshotDigest,
    binding: Object.freeze({
      chainId: boundPolicy.chainId.toString(),
      direction,
      endpointOrigin,
      endpointPublicKey: endpointKey.export({ format: "pem", type: "spki" }).toString(),
      endpointPublicKeyDigest: declaration.endpointPublicKeyDigest,
      lightningNodePubkey,
      settlementContract: verifyingContract,
      settlementContractCodeHash,
      solverId: declaration.solver,
    }),
    capacitySnapshot,
    expiresAt: declaration.expiresAt,
  });
  VERIFIED_CAPABILITIES.add(result);
  return result;
}
