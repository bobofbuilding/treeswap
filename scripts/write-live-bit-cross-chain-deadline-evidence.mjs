#!/usr/bin/env node

import { constants } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute } from "node:path";
import { coordinatorCommitmentDigest } from "../lib/coordinator-store.mjs";
import {
  liveBitCrossChainDeadlinePolicy,
  liveBitCrossChainDeadlineSchemas,
} from "../lib/live-bit-cross-chain-deadline-evidence.mjs";
import {
  crossChainDeadlinePolicy,
  crossChainDeadlineSchemas,
} from "../lib/cross-chain-deadline-evidence.mjs";

const MAX_EVIDENCE_BYTES = 1_000_000;
const HASH = /^0x[0-9a-f]{64}$/;

function exactObject(value, keys, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${name} fields are not exact`);
  }
}

function verifyDigest(value, name) {
  const digest = String(value?.evidenceDigest ?? "").toLowerCase();
  if (!HASH.test(digest)) throw new TypeError(`${name} digest is invalid`);
  const commitment = { ...value };
  delete commitment.evidenceDigest;
  if (coordinatorCommitmentDigest(commitment) !== digest) throw new Error(`${name} digest does not match its content`);
}

function verifyLimitations(value, expected, name) {
  exactObject(value, Object.keys(expected), name);
  for (const [key, required] of Object.entries(expected)) {
    if (value[key] !== required) throw new Error(`${name}.${key} does not match the required boundary`);
  }
}

function integer(value, name, { positive = false } = {}) {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0)) throw new TypeError(`${name} is invalid`);
  return value;
}

function truth(value, name) {
  if (value !== true) throw new Error(`${name} must be true`);
}

function verifySchedule(value, direction, name) {
  exactObject(value, [
    "bitcoinHeight",
    "claimBufferSeconds",
    "cltvCutoffAt",
    "cltvSafeHeight",
    "derivedAt",
    "direction",
    "ethereumFinalAt",
    "invoiceCutoffAt",
    "invoiceExpiresAt",
    "lastSafeClaimAt",
    "policyVersion",
    "quoteExpiresAt",
    "refundAfter",
  ], name);
  for (const key of [
    "bitcoinHeight",
    "claimBufferSeconds",
    "derivedAt",
    "ethereumFinalAt",
    "invoiceCutoffAt",
    "invoiceExpiresAt",
    "lastSafeClaimAt",
    "quoteExpiresAt",
    "refundAfter",
  ]) integer(value[key], `${name}.${key}`);
  if (value.direction !== direction || value.policyVersion !== crossChainDeadlinePolicy.version) {
    throw new Error(`${name} identity is invalid`);
  }
  if (direction === "bit-to-lightning") {
    if (value.cltvCutoffAt !== null || value.cltvSafeHeight !== null) {
      throw new Error(`${name} standard-invoice CLTV boundary is invalid`);
    }
  } else {
    integer(value.cltvCutoffAt, `${name}.cltvCutoffAt`, { positive: true });
    integer(value.cltvSafeHeight, `${name}.cltvSafeHeight`, { positive: true });
  }
  const requiredClaimBuffer = crossChainDeadlinePolicy.claimRelaySeconds
    + crossChainDeadlinePolicy.ethereumConfirmations * crossChainDeadlinePolicy.maximumEthereumBlockSeconds
    + crossChainDeadlinePolicy.ethereumCongestionSeconds;
  if (value.claimBufferSeconds !== requiredClaimBuffer
    || !(value.quoteExpiresAt < value.lastSafeClaimAt && value.lastSafeClaimAt < value.refundAfter)
    || value.refundAfter - value.lastSafeClaimAt !== requiredClaimBuffer
    || value.ethereumFinalAt > value.lastSafeClaimAt) {
    throw new Error(`${name} deadline order is unsafe`);
  }
  return value;
}

function verifyDirections(value) {
  exactObject(value, ["bitToLightning", "lightningToBit"], "deadlineEvidence.directions");
  const bit = value.bitToLightning;
  exactObject(bit, [
    "claimSucceeded",
    "claimedAt",
    "confirmations",
    "finalizedAt",
    "openedAt",
    "paymentProofMatched",
    "paymentSucceeded",
    "refundRejectedBeforeClaim",
    "schedule",
  ], "deadlineEvidence.directions.bitToLightning");
  const bitSchedule = verifySchedule(bit.schedule, "bit-to-lightning", "bitToLightning.schedule");
  const bitOpened = integer(bit.openedAt, "bitToLightning.openedAt");
  const bitFinalized = integer(bit.finalizedAt, "bitToLightning.finalizedAt");
  const bitClaimed = integer(bit.claimedAt, "bitToLightning.claimedAt");
  if (integer(bit.confirmations, "bitToLightning.confirmations", { positive: true })
      < crossChainDeadlinePolicy.ethereumConfirmations
    || bitOpened > bitSchedule.quoteExpiresAt
    || bitFinalized < bitOpened
    || bitFinalized > bitSchedule.ethereumFinalAt
    || bitClaimed < bitFinalized
    || bitClaimed >= bitSchedule.refundAfter) {
    throw new Error("BIT-to-Lightning persisted timing evidence is unsafe");
  }
  for (const key of ["paymentProofMatched", "paymentSucceeded", "refundRejectedBeforeClaim", "claimSucceeded"]) {
    truth(bit[key], `bitToLightning.${key}`);
  }

  const lightning = value.lightningToBit;
  exactObject(lightning, [
    "acceptedHeight",
    "advertisedSafeHeight",
    "boundaryHeight",
    "claimRejectedAtRefundBoundary",
    "claimSimulationSucceededBeforeRefund",
    "confirmations",
    "expiryHeight",
    "finalizedAt",
    "initialHtlcValid",
    "payerReleased",
    "refundRejectedBeforeBoundary",
    "refundSucceeded",
    "refundedAt",
    "reservedAt",
    "safeHeight",
    "schedule",
    "settlementRejectedAtBoundary",
  ], "deadlineEvidence.directions.lightningToBit");
  const lightningSchedule = verifySchedule(lightning.schedule, "lightning-to-bit", "lightningToBit.schedule");
  const reserved = integer(lightning.reservedAt, "lightningToBit.reservedAt");
  const finalized = integer(lightning.finalizedAt, "lightningToBit.finalizedAt");
  const refunded = integer(lightning.refundedAt, "lightningToBit.refundedAt");
  const acceptedHeight = integer(lightning.acceptedHeight, "lightningToBit.acceptedHeight", { positive: true });
  const expiryHeight = integer(lightning.expiryHeight, "lightningToBit.expiryHeight", { positive: true });
  const safeHeight = integer(lightning.safeHeight, "lightningToBit.safeHeight", { positive: true });
  const boundaryHeight = integer(lightning.boundaryHeight, "lightningToBit.boundaryHeight", { positive: true });
  const advertisedSafeHeight = integer(
    lightning.advertisedSafeHeight,
    "lightningToBit.advertisedSafeHeight",
    { positive: true },
  );
  if (integer(lightning.confirmations, "lightningToBit.confirmations", { positive: true })
      < crossChainDeadlinePolicy.ethereumConfirmations
    || reserved > lightningSchedule.quoteExpiresAt
    || finalized < reserved
    || finalized > lightningSchedule.ethereumFinalAt
    || refunded < lightningSchedule.refundAfter
    || safeHeight !== expiryHeight - crossChainDeadlinePolicy.fulfillmentSafetyBlocks
    || boundaryHeight !== safeHeight
    || acceptedHeight >= safeHeight
    || advertisedSafeHeight !== lightningSchedule.cltvSafeHeight
    || safeHeight < advertisedSafeHeight) {
    throw new Error("Lightning-to-BIT persisted timing evidence is unsafe");
  }
  for (const key of [
    "claimRejectedAtRefundBoundary",
    "claimSimulationSucceededBeforeRefund",
    "initialHtlcValid",
    "payerReleased",
    "refundRejectedBeforeBoundary",
    "refundSucceeded",
    "settlementRejectedAtBoundary",
  ]) truth(lightning[key], `lightningToBit.${key}`);
}

function verifyEvidence(evidence) {
  exactObject(evidence, [
    "deadlineEvidence",
    "evidenceDigest",
    "limitations",
    "schema",
    "scope",
    "source",
    "status",
    "token",
  ], "evidence");
  if (evidence.schema !== liveBitCrossChainDeadlineSchemas.evidence
    || evidence.scope !== liveBitCrossChainDeadlineSchemas.scope
    || evidence.status !== "passed") {
    throw new Error("live-BIT evidence identity is invalid");
  }

  exactObject(evidence.source, ["branch", "clean", "commit", "published"], "source");
  if (evidence.source.branch !== "main" || evidence.source.clean !== true || evidence.source.published !== true
    || !/^[0-9a-f]{40}$/.test(String(evidence.source.commit ?? ""))) {
    throw new Error("live-BIT evidence source is not exact published main");
  }

  exactObject(evidence.token, Object.keys(liveBitCrossChainDeadlinePolicy), "token");
  for (const [key, required] of Object.entries(liveBitCrossChainDeadlinePolicy)) {
    const observed = evidence.token[key];
    const matches = typeof required === "string"
      ? typeof observed === "string" && observed.toLowerCase() === required.toLowerCase()
      : observed === required;
    if (!matches) {
      throw new Error(`token.${key} does not match the pinned live-BIT boundary`);
    }
  }

  exactObject(evidence.deadlineEvidence, [
    "directions",
    "evidenceDigest",
    "evm",
    "limitations",
    "policyDigest",
    "schema",
    "scope",
    "status",
  ], "deadlineEvidence");
  if (evidence.deadlineEvidence.schema !== crossChainDeadlineSchemas.evidence
    || evidence.deadlineEvidence.scope !== crossChainDeadlineSchemas.scope
    || evidence.deadlineEvidence.status !== "passed") {
    throw new Error("nested deadline evidence identity is invalid");
  }
  exactObject(evidence.deadlineEvidence.evm, [
    "chainId",
    "executionClient",
    "userEscrowRuntimeCodeHash",
    "vaultRuntimeCodeHash",
  ], "deadlineEvidence.evm");
  if (evidence.deadlineEvidence.evm.chainId !== "31337"
    || typeof evidence.deadlineEvidence.evm.executionClient !== "string"
    || evidence.deadlineEvidence.evm.executionClient.length < 3
    || !HASH.test(evidence.deadlineEvidence.evm.userEscrowRuntimeCodeHash)
    || !HASH.test(evidence.deadlineEvidence.evm.vaultRuntimeCodeHash)) {
    throw new Error("nested deadline EVM identity is invalid");
  }
  if (evidence.deadlineEvidence.policyDigest !== coordinatorCommitmentDigest(crossChainDeadlinePolicy)) {
    throw new Error("nested deadline policy digest is invalid");
  }
  verifyDirections(evidence.deadlineEvidence.directions);
  verifyLimitations(evidence.deadlineEvidence.limitations, {
    publicTestnetIncluded: false,
    independentProvidersIncluded: false,
    productionInfrastructureIncluded: false,
    simulatedEvmFinality: true,
    fundingAuthorization: false,
  }, "deadlineEvidence.limitations");
  verifyLimitations(evidence.limitations, {
    publicTestnetIncluded: false,
    independentProvidersIncluded: false,
    productionInfrastructureIncluded: false,
    localForkProvider: true,
    simulatedEvmFinality: true,
    fundingAuthorization: false,
  }, "limitations");

  const serialized = JSON.stringify(evidence);
  if (/paymentHash|paymentRequest|invoiceDigest|preimage|https?:\/\//i.test(serialized)) {
    throw new Error("live-BIT evidence contains a payment correlation field or endpoint");
  }
  verifyDigest(evidence.deadlineEvidence, "deadline evidence");
  verifyDigest(evidence, "live-BIT evidence");
  return evidence;
}

async function readBoundedStdin() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_EVIDENCE_BYTES) throw new Error("live-BIT evidence exceeds its size limit");
    chunks.push(chunk);
  }
  if (size === 0) throw new Error("live-BIT evidence is required on stdin");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("live-BIT evidence is not valid JSON");
  }
}

async function writeExclusiveEvidence(path, evidence) {
  if (!isAbsolute(path)) throw new Error("live-BIT evidence path must be absolute");
  const name = basename(path);
  if (!/^[a-z0-9][a-z0-9._-]{0,100}\.json$/.test(name)) {
    throw new Error("live-BIT evidence name must be one safe JSON filename");
  }
  const parent = await lstat(dirname(path));
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) !== 0) {
    throw new Error("live-BIT evidence parent must be a private real directory");
  }

  let handle;
  let created = false;
  try {
    handle = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    created = true;
    await handle.chmod(0o600);
    await handle.writeFile(`${JSON.stringify(evidence, null, 2)}\n`);
    await handle.sync();
    const state = await handle.stat();
    if (!state.isFile() || (state.mode & 0o777) !== 0o600) throw new Error("live-BIT evidence permissions are invalid");
  } catch (error) {
    await handle?.close().catch(() => {});
    handle = null;
    if (created) await unlink(path).catch(() => {});
    throw error;
  } finally {
    await handle?.close();
  }

  const directory = await open(dirname(path), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function main() {
  if (process.argv.length !== 3) {
    throw new Error("Usage: node scripts/write-live-bit-cross-chain-deadline-evidence.mjs <absolute-output-path>");
  }
  const evidence = verifyEvidence(await readBoundedStdin());
  await writeExclusiveEvidence(process.argv[2], evidence);
  process.stdout.write(`${JSON.stringify({
    status: "persisted",
    evidenceDigest: evidence.evidenceDigest,
    output: basename(process.argv[2]),
  })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "live-BIT evidence persistence failed"}\n`);
  process.exitCode = 1;
});
