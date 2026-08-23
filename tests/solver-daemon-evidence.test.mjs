import assert from "node:assert/strict";
import test from "node:test";
import { Wallet, id } from "ethers";
import {
  SOLVER_DAEMON_EVIDENCE_POLICY_SCHEMA,
  SOLVER_DAEMON_EVIDENCE_SCHEMA,
  SOLVER_DAEMON_ZERO_BYTES32,
  buildSolverDaemonEvidenceApproval,
  solverDaemonEvidencePolicyDigest,
  verifiedSolverDaemonEvidence,
  verifySolverDaemonEvidence,
} from "../lib/solver-daemon-evidence.mjs";

const NOW = 2_000_000_000;
const LIGHTNING_OPERATOR = new Wallet(`0x${"41".repeat(32)}`);
const SECURITY_REVIEWER = new Wallet(`0x${"42".repeat(32)}`);
const WRONG_SIGNER = new Wallet(`0x${"43".repeat(32)}`);

function hash(label) {
  return id(label).toLowerCase();
}

function policy(overrides = {}) {
  return {
    schema: SOLVER_DAEMON_EVIDENCE_POLICY_SCHEMA,
    releaseRecordDigest: hash("daemon release"),
    chainId: "11155111",
    settlementContract: "0x1111111111111111111111111111111111111111",
    settlementContractCodeHash: hash("daemon escrow runtime"),
    solver: "0x2222222222222222222222222222222222222222",
    direction: "bit-to-lightning",
    approvers: {
      lightningOperator: LIGHTNING_OPERATOR.address,
      securityReviewer: SECURITY_REVIEWER.address,
    },
    maxEvidenceAgeSeconds: 30,
    maxEvidenceLifetimeSeconds: 30,
    maxClockSkewSeconds: 2,
    ...overrides,
  };
}

function record(kind = "LIGHTNING_DISPATCH", overrides = {}, evidencePolicy = policy()) {
  const dispatch = kind === "LIGHTNING_DISPATCH" || kind === "EVM_CLAIM_DISPATCH";
  const terminalState = kind === "TERMINAL_COMPLETED" ? "COMPLETED"
    : kind === "TERMINAL_REFUNDED" ? "REFUNDED" : "NONE";
  return {
    schema: SOLVER_DAEMON_EVIDENCE_SCHEMA,
    kind,
    releaseRecordDigest: evidencePolicy.releaseRecordDigest,
    evidencePolicyDigest: solverDaemonEvidencePolicyDigest(evidencePolicy),
    chainId: evidencePolicy.chainId,
    settlementContract: evidencePolicy.settlementContract,
    settlementContractCodeHash: evidencePolicy.settlementContractCodeHash,
    solver: evidencePolicy.solver,
    direction: evidencePolicy.direction,
    settlementId: hash("daemon settlement"),
    reservationId: hash("daemon reservation"),
    reservationTxHash: hash("daemon reservation transaction"),
    reservationBlockNumber: 123,
    reservationBlockHash: hash("daemon reservation block"),
    actionId: dispatch ? hash("daemon action") : SOLVER_DAEMON_ZERO_BYTES32,
    intentDigest: hash("daemon intent"),
    packetResponseDigest: dispatch ? hash("daemon packet") : SOLVER_DAEMON_ZERO_BYTES32,
    quoteExpiresAt: dispatch ? NOW + 100 : 0,
    lightningActionDeadline: dispatch ? NOW + 200 : 0,
    evmRefundAt: dispatch ? NOW + 800 : 0,
    terminalState,
    proofDigest: hash(`${kind}:proof`),
    observedAt: NOW,
    expiresAt: NOW + 20,
    ...overrides,
  };
}

async function approvals(value, evidencePolicy, wallets = [LIGHTNING_OPERATOR, SECURITY_REVIEWER]) {
  const payload = buildSolverDaemonEvidenceApproval({ record: value, policy: evidencePolicy });
  return Promise.all([
    ["lightningOperator", wallets[0]],
    ["securityReviewer", wallets[1]],
  ].map(async ([role, wallet]) => ({
    role,
    signer: wallet.address,
    signature: await wallet.signTypedData(payload.domain, payload.types, payload.message),
  })));
}

async function verify(kind, overrides = {}, evidencePolicy = policy(), approvalWallets) {
  const value = record(kind, overrides, evidencePolicy);
  return verifySolverDaemonEvidence({
    record: value,
    policy: evidencePolicy,
    approvals: await approvals(value, evidencePolicy, approvalWallets),
    now: NOW + 1,
  });
}

test("verifies dual-signed reservation, dispatch, and terminal evidence with non-copyable provenance", async () => {
  for (const evidenceKind of [
    "RESERVATION",
    "LIGHTNING_DISPATCH",
    "EVM_CLAIM_DISPATCH",
    "TERMINAL_COMPLETED",
    "TERMINAL_REFUNDED",
  ]) {
    const verification = await verify(evidenceKind);
    const context = verifiedSolverDaemonEvidence(verification, { now: NOW + 2, expectedKind: evidenceKind });
    assert.equal(context.record.kind, evidenceKind);
    assert.equal(context.record.releaseRecordDigest, policy().releaseRecordDigest);
    assert.throws(
      () => verifiedSolverDaemonEvidence({ ...verification }, { now: NOW + 2, expectedKind: evidenceKind }),
      /provenance is invalid/,
    );
  }
});

test("rejects signer substitution, missing approval, mutation, wrong purpose, and exact expiry", async () => {
  const evidencePolicy = policy();
  const value = record("LIGHTNING_DISPATCH", {}, evidencePolicy);
  const validApprovals = await approvals(value, evidencePolicy);
  const wrongApprovals = await approvals(value, evidencePolicy, [WRONG_SIGNER, SECURITY_REVIEWER]);
  assert.throws(
    () => verifySolverDaemonEvidence({
      record: value,
      policy: evidencePolicy,
      approvals: wrongApprovals,
      now: NOW + 1,
    }),
    /signer is wrong|signature is invalid/,
  );
  assert.throws(
    () => verifySolverDaemonEvidence({ record: value, policy: evidencePolicy, approvals: validApprovals.slice(0, 1), now: NOW + 1 }),
    /exactly two approvals/,
  );
  assert.throws(
    () => verifySolverDaemonEvidence({
      record: { ...value, actionId: hash("mutated action") },
      policy: evidencePolicy,
      approvals: validApprovals,
      now: NOW + 1,
    }),
    /signature is invalid/,
  );
  const verified = verifySolverDaemonEvidence({ record: value, policy: evidencePolicy, approvals: validApprovals, now: NOW + 1 });
  assert.throws(
    () => verifiedSolverDaemonEvidence(verified, { now: NOW + 2, expectedKind: "EVM_CLAIM_DISPATCH" }),
    /wrong purpose/,
  );
  assert.throws(
    () => verifiedSolverDaemonEvidence(verified, { now: value.expiresAt, expectedKind: "LIGHTNING_DISPATCH" }),
    /no longer active/,
  );
});

test("rejects policy substitution, stale evidence, unsafe deadlines, and action authority in non-dispatch evidence", async () => {
  const evidencePolicy = policy();
  const nominal = record("LIGHTNING_DISPATCH", {}, evidencePolicy);
  const nominalApprovals = await approvals(nominal, evidencePolicy);
  assert.throws(
    () => verifySolverDaemonEvidence({
      record: nominal,
      policy: policy({ releaseRecordDigest: hash("another release") }),
      approvals: nominalApprovals,
      now: NOW + 1,
    }),
    /changed its release, policy, solver, direction, or escrow binding/,
  );
  const stale = record("LIGHTNING_DISPATCH", { observedAt: NOW - 40, expiresAt: NOW - 20 }, evidencePolicy);
  assert.throws(
    () => verifySolverDaemonEvidence({
      record: stale,
      policy: evidencePolicy,
      approvals: [],
      now: NOW,
    }),
    /stale, future-dated, or expired/,
  );
  assert.throws(
    () => record("LIGHTNING_DISPATCH", { expiresAt: NOW + 101, quoteExpiresAt: NOW + 100 }, evidencePolicy)
      && buildSolverDaemonEvidenceApproval({
        record: record("LIGHTNING_DISPATCH", { expiresAt: NOW + 101, quoteExpiresAt: NOW + 100 }, evidencePolicy),
        policy: evidencePolicy,
      }),
    /outlives the bound action|lifetime is outside policy/,
  );
  assert.throws(
    () => buildSolverDaemonEvidenceApproval({
      record: record("RESERVATION", { actionId: hash("forbidden action") }, evidencePolicy),
      policy: evidencePolicy,
    }),
    /contains action authority/,
  );
});
