import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { id, Wallet } from "ethers";
import { CoordinatorStore } from "../lib/coordinator-store.mjs";
import {
  SOLVER_CAPABILITY_TYPES,
  solverCapabilityClaimsDigest,
  solverCapabilityDomain,
  solverCapabilityProofMessage,
  solverEndpointOriginDigest,
  solverEndpointPublicKeyDigest,
  solverLightningNodePubkeyDigest,
  verifiedSolverQuoteBinding,
  verifySolverCapability,
} from "../lib/solver-capability.mjs";

const NOW = 2_000_000_000;
const LIGHTNING_TO_BIT = "0x1111111111111111111111111111111111111111";
const BIT_TO_LIGHTNING = "0x2222222222222222222222222222222222222222";
const LIGHTNING_TO_BIT_CODE_HASH = id("lightning-to-bit-runtime");
const BIT_TO_LIGHTNING_CODE_HASH = id("bit-to-lightning-runtime");
const NODE_PUBKEY = `02${"33".repeat(32)}`;
const OTHER_NODE_PUBKEY = `03${"44".repeat(32)}`;
const LND_SIGNATURE = "y".repeat(104);
const solver = new Wallet(`0x${"55".repeat(32)}`);
const endpointKeys = generateKeyPairSync("ed25519");
const endpointPublicKey = endpointKeys.publicKey.export({ format: "pem", type: "spki" }).toString();
const endpointOrigin = "https://solver.example";
const policy = {
  chainId: "1",
  lightningToBitContract: LIGHTNING_TO_BIT,
  bitToLightningContract: BIT_TO_LIGHTNING,
  lightningToBitContractCodeHash: LIGHTNING_TO_BIT_CODE_HASH,
  bitToLightningContractCodeHash: BIT_TO_LIGHTNING_CODE_HASH,
  maxCapabilityTtlSeconds: 120,
  maxCapacityObservationAgeSeconds: 30,
  maxClockSkewSeconds: 5,
};

async function envelope(overrides = {}, verifyingContract = LIGHTNING_TO_BIT) {
  const claims = {
    capabilityId: id("solver-capability:one"),
    direction: id("lightning-to-bit"),
    solver: solver.address,
    lightningNodePubkeyDigest: solverLightningNodePubkeyDigest(NODE_PUBKEY),
    endpointPublicKeyDigest: solverEndpointPublicKeyDigest(endpointPublicKey),
    endpointOriginDigest: solverEndpointOriginDigest(endpointOrigin),
    availableBitWei: String(100n * 10n ** 18n),
    availableLightningSats: "250000",
    capacityEpoch: "7",
    issuedAt: NOW,
    expiresAt: NOW + 60,
    ...overrides.declaration,
  };
  const declaration = {
    ...claims,
    proofChallenge: solverCapabilityClaimsDigest(claims, {
      chainId: policy.chainId,
      verifyingContract,
    }),
  };
  const proofMessage = solverCapabilityProofMessage(declaration.proofChallenge);
  const base = {
    declaration,
    endpointOrigin,
    endpointPublicKey,
    endpointSignature: sign(null, proofMessage, endpointKeys.privateKey).toString("base64"),
    evmSignature: await solver.signTypedData(
      solverCapabilityDomain({ chainId: policy.chainId, verifyingContract }),
      SOLVER_CAPABILITY_TYPES,
      declaration,
    ),
    lightningNodePubkey: NODE_PUBKEY,
    lightningSignature: LND_SIGNATURE,
  };
  return { ...base, ...overrides, declaration: overrides.declarationEnvelope ?? declaration };
}

function verifier({ valid = true, pubkey = NODE_PUBKEY, calls = null } = {}) {
  return async ({ message, signature }) => {
    calls?.push({ message: Buffer.from(message), signature });
    return { valid, pubkey };
  };
}

function readers({
  availableBitWei = String(100n * 10n ** 18n),
  availableLightningSats = "250000",
  capacityEpoch = "7",
  bitObservedAt = NOW,
  lightningObservedAt = NOW,
  nodePubkey = NODE_PUBKEY,
  solverId = solver.address,
} = {}) {
  return {
    readVerifiedBitInventory: async () => ({ availableBitWei, observedAt: bitObservedAt, solverId }),
    readVerifiedLightningCapacity: async () => ({
      availableLightningSats,
      capacityEpoch,
      nodePubkey,
      observedAt: lightningObservedAt,
    }),
  };
}

test("binds one short-lived EVM, Lightning-node, and HTTPS endpoint capability", async () => {
  const calls = [];
  const capability = await envelope();
  const result = await verifySolverCapability({
    envelope: capability,
    now: NOW + 1,
    policy,
    verifyLightningNodeSignature: verifier({ calls }),
    ...readers(),
  });
  assert.equal(result.valid, true);
  assert.equal(result.binding.direction, "lightning-to-bit");
  assert.equal(result.binding.solverId, solver.address.toLowerCase());
  assert.equal(result.binding.lightningNodePubkey, NODE_PUBKEY);
  assert.equal(result.binding.endpointOrigin, endpointOrigin);
  assert.equal(result.binding.settlementContractCodeHash, LIGHTNING_TO_BIT_CODE_HASH);
  assert.match(result.capacitySnapshotDigest, /^0x[0-9a-f]{64}$/);
  assert.deepEqual(verifiedSolverQuoteBinding(result), {
    chainId: "1",
    direction: "lightning-to-bit",
    solverId: solver.address.toLowerCase(),
    capabilityDigest: result.capabilityDigest,
    capacitySnapshotDigest: result.capacitySnapshotDigest,
    endpointOrigin,
    endpointPublicKeyDigest: solverEndpointPublicKeyDigest(endpointPublicKey),
    settlementContract: LIGHTNING_TO_BIT,
    settlementContractCodeHash: LIGHTNING_TO_BIT_CODE_HASH,
    capacityEpoch: 7,
    availableBitWei: String(100n * 10n ** 18n),
    availableLightningSats: "250000",
    expiresAt: NOW + 60,
  });
  assert.throws(
    () => verifiedSolverQuoteBinding({ ...result }),
    /locally verified capability/,
  );
  assert.deepEqual(result.capacitySnapshot, {
    solverId: solver.address.toLowerCase(),
    capabilityDigest: result.capabilityDigest,
    capabilityVerified: true,
    capabilityExpiresAt: NOW + 60,
    capacityEpoch: 7,
    availableBitWei: String(100n * 10n ** 18n),
    availableLightningSats: "250000",
    observedAt: NOW,
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].message, solverCapabilityProofMessage(capability.declaration.proofChallenge));
});

test("rejects mutation of every identity binding", async () => {
  const valid = await envelope();
  const changedOrigin = await verifySolverCapability({
    envelope: { ...valid, endpointOrigin: "https://other.example" },
    now: NOW,
    policy,
    verifyLightningNodeSignature: verifier(),
    ...readers(),
  });
  assert.match(changedOrigin.reasons.join("; "), /endpoint origin changed/);

  const changedNode = await verifySolverCapability({
    envelope: { ...valid, lightningNodePubkey: OTHER_NODE_PUBKEY },
    now: NOW,
    policy,
    verifyLightningNodeSignature: verifier({ pubkey: OTHER_NODE_PUBKEY }),
    ...readers({ nodePubkey: OTHER_NODE_PUBKEY }),
  });
  assert.match(changedNode.reasons.join("; "), /Lightning node pubkey changed/);

  const otherEndpoint = generateKeyPairSync("ed25519").publicKey.export({ format: "pem", type: "spki" }).toString();
  const changedEndpoint = await verifySolverCapability({
    envelope: { ...valid, endpointPublicKey: otherEndpoint },
    now: NOW,
    policy,
    verifyLightningNodeSignature: verifier(),
    ...readers(),
  });
  assert.match(changedEndpoint.reasons.join("; "), /endpoint public key changed|endpoint possession proof is invalid/);
});

test("requires independent node recovery and never trusts a supplied verification flag", async () => {
  const valid = await envelope();
  let calls = 0;
  const failed = await verifySolverCapability({
    envelope: valid,
    now: NOW,
    policy,
    verifyLightningNodeSignature: async () => {
      calls += 1;
      return { valid: false, pubkey: NODE_PUBKEY };
    },
    ...readers(),
  });
  assert.equal(calls, 1);
  assert.match(failed.reasons.join("; "), /Lightning node possession proof is invalid/);

  const wrongNode = await verifySolverCapability({
    envelope: valid,
    now: NOW,
    policy,
    verifyLightningNodeSignature: verifier({ pubkey: OTHER_NODE_PUBKEY }),
    ...readers(),
  });
  assert.match(wrongNode.reasons.join("; "), /Lightning node possession proof is invalid/);
});

test("fails before external verification for stale, malformed, or incorrectly signed declarations", async () => {
  let calls = 0;
  const countVerifier = async () => {
    calls += 1;
    return { valid: true, pubkey: NODE_PUBKEY };
  };
  const stale = await envelope({ declaration: { issuedAt: NOW - 121, expiresAt: NOW - 1 } });
  const staleResult = await verifySolverCapability({
    envelope: stale,
    now: NOW,
    policy,
    verifyLightningNodeSignature: countVerifier,
    ...readers(),
  });
  assert.match(staleResult.reasons.join("; "), /expired/);

  const invalidEvm = await envelope();
  invalidEvm.evmSignature = `0x${"00".repeat(65)}`;
  const evmResult = await verifySolverCapability({
    envelope: invalidEvm,
    now: NOW,
    policy,
    verifyLightningNodeSignature: countVerifier,
    ...readers(),
  });
  assert.match(evmResult.reasons.join("; "), /EVM signature is invalid/);

  const extra = await envelope();
  extra.lightningProofVerified = true;
  const extraResult = await verifySolverCapability({
    envelope: extra,
    now: NOW,
    policy,
    verifyLightningNodeSignature: countVerifier,
    ...readers(),
  });
  assert.match(extraResult.reasons.join("; "), /fields are not exact/);
  assert.equal(calls, 0);
});

test("rejects unusable identifiers and epochs before they reach durable state", async () => {
  let calls = 0;
  const countVerifier = async () => {
    calls += 1;
    return { valid: true, pubkey: NODE_PUBKEY };
  };
  for (const declaration of [
    { capabilityId: `0x${"0".repeat(64)}` },
    { capacityEpoch: String(BigInt(Number.MAX_SAFE_INTEGER) + 1n) },
  ]) {
    const invalid = await envelope();
    invalid.declaration = { ...invalid.declaration, ...declaration };
    const result = await verifySolverCapability({
      envelope: invalid,
      now: NOW,
      policy,
      verifyLightningNodeSignature: countVerifier,
      ...readers(),
    });
    assert.equal(result.valid, false);
  }
  assert.equal(calls, 0);
});

test("pins direction to the configured escrow and rejects cross-direction replay", async () => {
  const capability = await envelope();
  const wrongContractPolicy = { ...policy, lightningToBitContract: "0x6666666666666666666666666666666666666666" };
  const result = await verifySolverCapability({
    envelope: capability,
    now: NOW,
    policy: wrongContractPolicy,
    verifyLightningNodeSignature: verifier(),
    ...readers(),
  });
  assert.match(result.reasons.join("; "), /EVM signature is invalid/);
});

test("requires direction-specific inventory instead of a misleading two-sided claim", async () => {
  const valid = await envelope({
    declaration: {
      direction: id("bit-to-lightning"),
      availableBitWei: "0",
      availableLightningSats: "250000",
    },
  }, BIT_TO_LIGHTNING);
  const accepted = await verifySolverCapability({
    envelope: valid,
    now: NOW,
    policy,
    verifyLightningNodeSignature: verifier(),
    ...readers({ availableBitWei: "0" }),
  });
  assert.equal(accepted.valid, true);
  assert.equal(accepted.binding.direction, "bit-to-lightning");

  const misleading = await envelope({
    declaration: {
      direction: id("bit-to-lightning"),
      availableBitWei: "1",
      availableLightningSats: "250000",
    },
  }, BIT_TO_LIGHTNING);
  const rejected = await verifySolverCapability({
    envelope: misleading,
    now: NOW,
    policy,
    verifyLightningNodeSignature: verifier(),
    ...readers({ availableBitWei: "1" }),
  });
  assert.match(rejected.reasons.join("; "), /must not claim solver BIT inventory/);
});

test("does not turn signed self-reported inventory into verified capacity", async () => {
  const capability = await envelope();
  const excessiveBit = await verifySolverCapability({
    envelope: capability,
    now: NOW,
    policy,
    verifyLightningNodeSignature: verifier(),
    ...readers({ availableBitWei: String(99n * 10n ** 18n) }),
  });
  assert.match(excessiveBit.reasons.join("; "), /BIT inventory exceeds verified inventory/);

  const excessiveLightning = await verifySolverCapability({
    envelope: capability,
    now: NOW,
    policy,
    verifyLightningNodeSignature: verifier(),
    ...readers({ availableLightningSats: "249999" }),
  });
  assert.match(excessiveLightning.reasons.join("; "), /Lightning capacity exceeds verified capacity/);

  const stale = await verifySolverCapability({
    envelope: capability,
    now: NOW + 31,
    policy,
    verifyLightningNodeSignature: verifier(),
    ...readers(),
  });
  assert.match(stale.reasons.join("; "), /observation is stale/);

  const malformed = await verifySolverCapability({
    envelope: capability,
    now: NOW,
    policy,
    verifyLightningNodeSignature: verifier(),
    readVerifiedBitInventory: async () => ({ availableBitWei: "1" }),
    readVerifiedLightningCapacity: async () => null,
  });
  assert.equal(malformed.valid, false);
  assert.match(malformed.reasons.join("; "), /capacity could not be verified/);
});

test("feeds only fully verified capacity into the durable monotonic store", async () => {
  const first = await verifySolverCapability({
    envelope: await envelope(),
    now: NOW,
    policy,
    verifyLightningNodeSignature: verifier(),
    ...readers(),
  });
  assert.equal(first.valid, true);
  const store = await CoordinatorStore.open(":memory:", { allowMemory: true });
  try {
    assert.equal(store.recordSolverCapacity(first.capacitySnapshot).capacityEpoch, 7);
    const rebound = await verifySolverCapability({
      envelope: await envelope({ declaration: { capabilityId: id("solver-capability:rebound") } }),
      now: NOW,
      policy,
      verifyLightningNodeSignature: verifier(),
      ...readers(),
    });
    assert.equal(rebound.valid, true);
    assert.notEqual(rebound.capabilityDigest, first.capabilityDigest);
    assert.throws(
      () => store.recordSolverCapacity(rebound.capacitySnapshot),
      /capacity epoch was already bound to another snapshot/,
    );
  } finally {
    store.close();
  }
});
