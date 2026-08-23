import {
  TypedDataEncoder,
  getAddress,
  id,
  keccak256,
  toUtf8Bytes,
  verifyTypedData,
} from "ethers";

export const SOLVER_DAEMON_EVIDENCE_POLICY_SCHEMA = "treeswap.solver-daemon-evidence-policy.v1";
export const SOLVER_DAEMON_EVIDENCE_SCHEMA = "treeswap.solver-daemon-evidence.v1";

export const SOLVER_DAEMON_EVIDENCE_TYPES = Object.freeze({
  SolverDaemonEvidence: Object.freeze([
    Object.freeze({ name: "kind", type: "bytes32" }),
    Object.freeze({ name: "releaseRecordDigest", type: "bytes32" }),
    Object.freeze({ name: "evidencePolicyDigest", type: "bytes32" }),
    Object.freeze({ name: "chainId", type: "uint256" }),
    Object.freeze({ name: "settlementContract", type: "address" }),
    Object.freeze({ name: "settlementContractCodeHash", type: "bytes32" }),
    Object.freeze({ name: "solver", type: "address" }),
    Object.freeze({ name: "direction", type: "bytes32" }),
    Object.freeze({ name: "settlementId", type: "bytes32" }),
    Object.freeze({ name: "reservationId", type: "bytes32" }),
    Object.freeze({ name: "reservationTxHash", type: "bytes32" }),
    Object.freeze({ name: "reservationBlockNumber", type: "uint64" }),
    Object.freeze({ name: "reservationBlockHash", type: "bytes32" }),
    Object.freeze({ name: "actionId", type: "bytes32" }),
    Object.freeze({ name: "intentDigest", type: "bytes32" }),
    Object.freeze({ name: "packetResponseDigest", type: "bytes32" }),
    Object.freeze({ name: "quoteExpiresAt", type: "uint64" }),
    Object.freeze({ name: "lightningActionDeadline", type: "uint64" }),
    Object.freeze({ name: "evmRefundAt", type: "uint64" }),
    Object.freeze({ name: "terminalState", type: "bytes32" }),
    Object.freeze({ name: "proofDigest", type: "bytes32" }),
    Object.freeze({ name: "observedAt", type: "uint64" }),
    Object.freeze({ name: "expiresAt", type: "uint64" }),
  ]),
});

const ZERO_BYTES32 = `0x${"00".repeat(32)}`;
const BYTES32 = /^0x[0-9a-f]{64}$/;
const UINT = /^(?:0|[1-9][0-9]*)$/;
const DIRECTIONS = new Set(["lightning-to-bit", "bit-to-lightning"]);
const KINDS = new Set([
  "RESERVATION",
  "LIGHTNING_DISPATCH",
  "EVM_CLAIM_DISPATCH",
  "TERMINAL_COMPLETED",
  "TERMINAL_REFUNDED",
]);
const APPROVER_ROLES = Object.freeze(["lightningOperator", "securityReviewer"]);
const VERIFIED_EVIDENCE = new WeakMap();

function exactKeys(value, expected, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${name} fields are not exact`);
  }
}

function bytes32(value, name, { nonzero = false } = {}) {
  const raw = String(value ?? "");
  if (!BYTES32.test(raw) || (nonzero && raw === ZERO_BYTES32)) throw new TypeError(`${name} must be lowercase bytes32`);
  return raw;
}

function address(value, name) {
  try {
    const normalized = getAddress(value).toLowerCase();
    if (normalized === "0x0000000000000000000000000000000000000000") throw new Error();
    return normalized;
  } catch {
    throw new TypeError(`${name} must be a nonzero Ethereum address`);
  }
}

function uint(value, name, { nonzero = false } = {}) {
  const raw = String(value ?? "");
  if (!UINT.test(raw)) throw new TypeError(`${name} must be a canonical unsigned decimal string`);
  const parsed = BigInt(raw);
  if (parsed > (1n << 256n) - 1n || (nonzero && parsed === 0n)) throw new RangeError(`${name} is outside its range`);
  return raw;
}

function integer(value, name, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new TypeError(`${name} must be a non-negative safe integer at or below ${maximum}`);
  }
  return value;
}

function direction(value) {
  const raw = String(value ?? "");
  if (!DIRECTIONS.has(raw)) throw new RangeError("solver daemon evidence direction is unsupported");
  return raw;
}

function kind(value) {
  const raw = String(value ?? "");
  if (!KINDS.has(raw)) throw new RangeError("solver daemon evidence kind is unsupported");
  return raw;
}

function normalizePolicy(raw) {
  exactKeys(raw, [
    "approvers", "chainId", "direction", "maxClockSkewSeconds", "maxEvidenceAgeSeconds",
    "maxEvidenceLifetimeSeconds", "releaseRecordDigest", "schema", "settlementContract",
    "settlementContractCodeHash", "solver",
  ], "solver daemon evidence policy");
  if (raw.schema !== SOLVER_DAEMON_EVIDENCE_POLICY_SCHEMA) {
    throw new TypeError("solver daemon evidence policy schema is unsupported");
  }
  exactKeys(raw.approvers, APPROVER_ROLES, "solver daemon evidence approvers");
  const approvers = Object.freeze(Object.fromEntries(APPROVER_ROLES.map((role) => [
    role,
    address(raw.approvers[role], `solver daemon evidence approver ${role}`),
  ])));
  if (new Set(Object.values(approvers)).size !== APPROVER_ROLES.length) {
    throw new Error("solver daemon evidence approvers must be distinct");
  }
  const maxEvidenceAgeSeconds = integer(raw.maxEvidenceAgeSeconds, "maximum solver daemon evidence age", 300);
  const maxEvidenceLifetimeSeconds = integer(
    raw.maxEvidenceLifetimeSeconds,
    "maximum solver daemon evidence lifetime",
    300,
  );
  if (maxEvidenceAgeSeconds === 0 || maxEvidenceLifetimeSeconds === 0) {
    throw new RangeError("solver daemon evidence age and lifetime must be nonzero");
  }
  return Object.freeze({
    schema: SOLVER_DAEMON_EVIDENCE_POLICY_SCHEMA,
    releaseRecordDigest: bytes32(raw.releaseRecordDigest, "solver daemon release record digest", { nonzero: true }),
    chainId: uint(raw.chainId, "solver daemon evidence chainId", { nonzero: true }),
    settlementContract: address(raw.settlementContract, "solver daemon settlement contract"),
    settlementContractCodeHash: bytes32(
      raw.settlementContractCodeHash,
      "solver daemon settlement contract code hash",
      { nonzero: true },
    ),
    solver: address(raw.solver, "solver daemon solver"),
    direction: direction(raw.direction),
    approvers,
    maxEvidenceAgeSeconds,
    maxEvidenceLifetimeSeconds,
    maxClockSkewSeconds: integer(raw.maxClockSkewSeconds, "maximum solver daemon clock skew", 30),
  });
}

function stablePolicyPayload(policy) {
  return {
    schema: policy.schema,
    releaseRecordDigest: policy.releaseRecordDigest,
    chainId: policy.chainId,
    settlementContract: policy.settlementContract,
    settlementContractCodeHash: policy.settlementContractCodeHash,
    solver: policy.solver,
    direction: policy.direction,
    approvers: Object.fromEntries(APPROVER_ROLES.map((role) => [role, policy.approvers[role]])),
    maxEvidenceAgeSeconds: policy.maxEvidenceAgeSeconds,
    maxEvidenceLifetimeSeconds: policy.maxEvidenceLifetimeSeconds,
    maxClockSkewSeconds: policy.maxClockSkewSeconds,
  };
}

export function solverDaemonEvidencePolicyDigest(raw) {
  const policy = normalizePolicy(raw);
  return keccak256(toUtf8Bytes(JSON.stringify(stablePolicyPayload(policy)))).toLowerCase();
}

function normalizeRecord(raw, policy) {
  exactKeys(raw, [
    "actionId", "chainId", "direction", "evidencePolicyDigest", "evmRefundAt", "expiresAt", "intentDigest",
    "kind", "lightningActionDeadline", "observedAt", "packetResponseDigest", "proofDigest", "quoteExpiresAt",
    "releaseRecordDigest", "reservationBlockHash", "reservationBlockNumber", "reservationId", "reservationTxHash",
    "schema", "settlementContract", "settlementContractCodeHash", "settlementId", "solver", "terminalState",
  ], "solver daemon evidence record");
  if (raw.schema !== SOLVER_DAEMON_EVIDENCE_SCHEMA) {
    throw new TypeError("solver daemon evidence schema is unsupported");
  }
  const normalizedKind = kind(raw.kind);
  const observedAt = integer(raw.observedAt, "solver daemon evidence observedAt");
  const expiresAt = integer(raw.expiresAt, "solver daemon evidence expiresAt");
  if (expiresAt <= observedAt || expiresAt - observedAt > policy.maxEvidenceLifetimeSeconds) {
    throw new RangeError("solver daemon evidence lifetime is outside policy");
  }
  const record = Object.freeze({
    schema: SOLVER_DAEMON_EVIDENCE_SCHEMA,
    kind: normalizedKind,
    releaseRecordDigest: bytes32(raw.releaseRecordDigest, "evidence release record digest", { nonzero: true }),
    evidencePolicyDigest: bytes32(raw.evidencePolicyDigest, "evidence policy digest", { nonzero: true }),
    chainId: uint(raw.chainId, "evidence chainId", { nonzero: true }),
    settlementContract: address(raw.settlementContract, "evidence settlement contract"),
    settlementContractCodeHash: bytes32(raw.settlementContractCodeHash, "evidence contract code hash", { nonzero: true }),
    solver: address(raw.solver, "evidence solver"),
    direction: direction(raw.direction),
    settlementId: bytes32(raw.settlementId, "evidence settlementId", { nonzero: true }),
    reservationId: bytes32(raw.reservationId, "evidence reservationId", { nonzero: true }),
    reservationTxHash: bytes32(raw.reservationTxHash, "evidence reservation transaction", { nonzero: true }),
    reservationBlockNumber: integer(raw.reservationBlockNumber, "evidence reservation block number"),
    reservationBlockHash: bytes32(raw.reservationBlockHash, "evidence reservation block hash", { nonzero: true }),
    actionId: bytes32(raw.actionId, "evidence actionId"),
    intentDigest: bytes32(raw.intentDigest, "evidence intent digest", { nonzero: true }),
    packetResponseDigest: bytes32(raw.packetResponseDigest, "evidence packet response digest"),
    quoteExpiresAt: integer(raw.quoteExpiresAt, "evidence quote expiry"),
    lightningActionDeadline: integer(raw.lightningActionDeadline, "evidence Lightning deadline"),
    evmRefundAt: integer(raw.evmRefundAt, "evidence EVM refund time"),
    terminalState: String(raw.terminalState ?? ""),
    proofDigest: bytes32(raw.proofDigest, "evidence proof digest", { nonzero: true }),
    observedAt,
    expiresAt,
  });
  const expectedPolicyDigest = solverDaemonEvidencePolicyDigest(policy);
  if (record.releaseRecordDigest !== policy.releaseRecordDigest
      || record.evidencePolicyDigest !== expectedPolicyDigest
      || record.chainId !== policy.chainId
      || record.settlementContract !== policy.settlementContract
      || record.settlementContractCodeHash !== policy.settlementContractCodeHash
      || record.solver !== policy.solver
      || record.direction !== policy.direction) {
    throw new Error("solver daemon evidence changed its release, policy, solver, direction, or escrow binding");
  }
  const isDispatch = normalizedKind === "LIGHTNING_DISPATCH" || normalizedKind === "EVM_CLAIM_DISPATCH";
  const expectedTerminal = normalizedKind === "TERMINAL_COMPLETED"
    ? "COMPLETED"
    : normalizedKind === "TERMINAL_REFUNDED" ? "REFUNDED" : "NONE";
  if (record.terminalState !== expectedTerminal) throw new Error("solver daemon evidence terminal state is inconsistent");
  if (isDispatch) {
    if (record.actionId === ZERO_BYTES32 || record.packetResponseDigest === ZERO_BYTES32
        || record.quoteExpiresAt === 0 || record.lightningActionDeadline === 0 || record.evmRefundAt === 0
        || record.lightningActionDeadline >= record.evmRefundAt) {
      throw new Error("solver daemon dispatch evidence is incomplete or has unsafe deadlines");
    }
    const deadline = normalizedKind === "LIGHTNING_DISPATCH" ? record.lightningActionDeadline : record.evmRefundAt;
    if (record.expiresAt > deadline || record.expiresAt > record.quoteExpiresAt) {
      throw new Error("solver daemon dispatch evidence outlives the bound action");
    }
  } else if (record.actionId !== ZERO_BYTES32 || record.packetResponseDigest !== ZERO_BYTES32
      || record.quoteExpiresAt !== 0 || record.lightningActionDeadline !== 0 || record.evmRefundAt !== 0) {
    throw new Error("non-dispatch solver daemon evidence contains action authority");
  }
  return record;
}

function domain(policy) {
  return Object.freeze({
    name: "TreeSwap",
    version: "1",
    chainId: BigInt(policy.chainId),
    verifyingContract: policy.settlementContract,
  });
}

function typedMessage(record) {
  return Object.freeze({
    kind: id(record.kind),
    releaseRecordDigest: record.releaseRecordDigest,
    evidencePolicyDigest: record.evidencePolicyDigest,
    chainId: BigInt(record.chainId),
    settlementContract: record.settlementContract,
    settlementContractCodeHash: record.settlementContractCodeHash,
    solver: record.solver,
    direction: id(record.direction),
    settlementId: record.settlementId,
    reservationId: record.reservationId,
    reservationTxHash: record.reservationTxHash,
    reservationBlockNumber: record.reservationBlockNumber,
    reservationBlockHash: record.reservationBlockHash,
    actionId: record.actionId,
    intentDigest: record.intentDigest,
    packetResponseDigest: record.packetResponseDigest,
    quoteExpiresAt: record.quoteExpiresAt,
    lightningActionDeadline: record.lightningActionDeadline,
    evmRefundAt: record.evmRefundAt,
    terminalState: id(record.terminalState),
    proofDigest: record.proofDigest,
    observedAt: record.observedAt,
    expiresAt: record.expiresAt,
  });
}

export function buildSolverDaemonEvidenceApproval({ record: rawRecord, policy: rawPolicy }) {
  const policy = normalizePolicy(rawPolicy);
  const record = normalizeRecord(rawRecord, policy);
  return Object.freeze({
    domain: domain(policy),
    types: SOLVER_DAEMON_EVIDENCE_TYPES,
    primaryType: "SolverDaemonEvidence",
    message: typedMessage(record),
  });
}

export function verifySolverDaemonEvidence({ record: rawRecord, policy: rawPolicy, approvals, now }) {
  const policy = normalizePolicy(rawPolicy);
  const record = normalizeRecord(rawRecord, policy);
  const observedAt = integer(now, "solver daemon evidence verification time");
  if (record.observedAt > observedAt + policy.maxClockSkewSeconds || record.expiresAt <= observedAt
      || (observedAt > record.observedAt && observedAt - record.observedAt > policy.maxEvidenceAgeSeconds)) {
    throw new Error("solver daemon evidence is stale, future-dated, or expired");
  }
  if (!Array.isArray(approvals) || approvals.length !== APPROVER_ROLES.length) {
    throw new Error("solver daemon evidence requires exactly two approvals");
  }
  const sorted = [...approvals].sort((left, right) => String(left?.role).localeCompare(String(right?.role)));
  const expectedRoles = [...APPROVER_ROLES].sort();
  const recovered = new Set();
  for (let index = 0; index < sorted.length; index += 1) {
    const approval = sorted[index];
    exactKeys(approval, ["role", "signature", "signer"], "solver daemon evidence approval");
    if (approval.role !== expectedRoles[index]) throw new Error("solver daemon evidence approval role set is invalid");
    const expectedSigner = policy.approvers[approval.role];
    const claimedSigner = address(approval.signer, `solver daemon evidence ${approval.role} signer`);
    if (claimedSigner !== expectedSigner || recovered.has(claimedSigner)) {
      throw new Error("solver daemon evidence approval signer is wrong or duplicated");
    }
    let actualSigner;
    try {
      actualSigner = verifyTypedData(
        domain(policy),
        SOLVER_DAEMON_EVIDENCE_TYPES,
        typedMessage(record),
        String(approval.signature ?? ""),
      ).toLowerCase();
    } catch {
      throw new Error("solver daemon evidence approval signature is invalid");
    }
    if (actualSigner !== expectedSigner) throw new Error("solver daemon evidence approval signature is invalid");
    recovered.add(actualSigner);
  }
  const recordDigest = TypedDataEncoder.hash(
    domain(policy),
    SOLVER_DAEMON_EVIDENCE_TYPES,
    typedMessage(record),
  ).toLowerCase();
  const result = Object.freeze({
    status: "dual-signed-solver-daemon-evidence-verified",
    kind: record.kind,
    recordDigest,
    evidencePolicyDigest: record.evidencePolicyDigest,
    expiresAt: record.expiresAt,
  });
  VERIFIED_EVIDENCE.set(result, Object.freeze({ policy, record, recordDigest }));
  return result;
}

export function verifiedSolverDaemonEvidence(verification, { now, expectedKind = null } = {}) {
  const context = VERIFIED_EVIDENCE.get(verification);
  if (!context) throw new Error("solver daemon evidence provenance is invalid");
  const observedAt = integer(now, "solver daemon evidence use time");
  if (expectedKind !== null && context.record.kind !== kind(expectedKind)) {
    throw new Error("solver daemon evidence has the wrong purpose");
  }
  if (context.record.observedAt > observedAt + context.policy.maxClockSkewSeconds
      || context.record.expiresAt <= observedAt
      || (observedAt > context.record.observedAt
        && observedAt - context.record.observedAt > context.policy.maxEvidenceAgeSeconds)) {
    throw new Error("solver daemon evidence is no longer active");
  }
  return context;
}

export { ZERO_BYTES32 as SOLVER_DAEMON_ZERO_BYTES32 };
