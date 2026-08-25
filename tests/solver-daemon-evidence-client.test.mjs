import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { Wallet, id } from "ethers";
import {
  SOLVER_DAEMON_EVIDENCE_REQUEST_SCHEMA,
  buildSolverDaemonEvidenceRequest,
  buildSolverDaemonEvidenceRouteResponse,
  createSolverDaemonEvidenceControls,
  isSolverDaemonEvidenceControls,
  signSolverDaemonEvidenceRequest,
  solverDaemonEvidenceControlsTransportMode,
  verifySolverDaemonEvidenceRequest,
} from "../lib/solver-daemon-evidence-client.mjs";
import {
  SOLVER_DAEMON_EVIDENCE_POLICY_SCHEMA,
  SOLVER_DAEMON_EVIDENCE_SCHEMA,
  SOLVER_DAEMON_ZERO_BYTES32,
  buildSolverDaemonEvidenceApproval,
  solverDaemonEvidencePolicyDigest,
  verifiedSolverDaemonEvidence,
} from "../lib/solver-daemon-evidence.mjs";
import { executeSolverDaemonStep } from "../lib/solver-daemon-runtime.mjs";
import { CoordinatorStore } from "../lib/coordinator-store.mjs";

const NOW = 2_100_000_000;
const LIGHTNING_OPERATOR = new Wallet(`0x${"51".repeat(32)}`);
const SECURITY_REVIEWER = new Wallet(`0x${"52".repeat(32)}`);
const WRONG_SIGNER = new Wallet(`0x${"53".repeat(32)}`);
const REQUESTER_KEY_ID = "coordinator-active-1";
const { privateKey: REQUESTER_PRIVATE_KEY, publicKey: REQUESTER_PUBLIC_KEY } = generateKeyPairSync("ed25519");

function hash(label) {
  return id(label).toLowerCase();
}

function policy(direction = "bit-to-lightning") {
  return {
    schema: SOLVER_DAEMON_EVIDENCE_POLICY_SCHEMA,
    releaseRecordDigest: hash("dual route release"),
    chainId: "11155111",
    settlementContract: "0x1111111111111111111111111111111111111111",
    settlementContractCodeHash: hash("dual route contract code"),
    solver: "0x2222222222222222222222222222222222222222",
    direction,
    approvers: {
      lightningOperator: LIGHTNING_OPERATOR.address,
      securityReviewer: SECURITY_REVIEWER.address,
    },
    maxEvidenceAgeSeconds: 30,
    maxEvidenceLifetimeSeconds: 30,
    maxClockSkewSeconds: 2,
  };
}

function settlement(direction = "bit-to-lightning", { observed = true } = {}) {
  return {
    settlementId: hash(`${direction}:settlement`),
    intentDigest: hash(`${direction}:intent`),
    direction,
    reservationId: observed ? hash(`${direction}:reservation`) : null,
    reservationTxHash: observed ? hash(`${direction}:reservation-tx`) : null,
    reservationBlockNumber: observed ? 12345 : null,
    reservationBlockHash: observed ? hash(`${direction}:reservation-block`) : null,
  };
}

function action(label = "action") {
  return { actionId: hash(label) };
}

function packet() {
  return {
    quoteExpiresAt: NOW + 20,
    lightningActionDeadline: NOW + 40,
    evmRefundAt: NOW + 400,
  };
}

function reservationFromRequest(request) {
  return request.settlement.reservation ?? {
    reservationId: hash(`${request.settlement.settlementId}:discovered-reservation`),
    reservationTxHash: hash(`${request.settlement.settlementId}:discovered-transaction`),
    reservationBlockNumber: 54321,
    reservationBlockHash: hash(`${request.settlement.settlementId}:discovered-block`),
  };
}

function recordForRequest(request, overrides = {}) {
  const reservation = reservationFromRequest(request);
  return {
    schema: SOLVER_DAEMON_EVIDENCE_SCHEMA,
    kind: request.kind,
    releaseRecordDigest: request.policy.releaseRecordDigest,
    evidencePolicyDigest: request.policy.evidencePolicyDigest,
    chainId: request.policy.chainId,
    settlementContract: request.policy.settlementContract,
    settlementContractCodeHash: request.policy.settlementContractCodeHash,
    solver: request.policy.solver,
    direction: request.policy.direction,
    settlementId: request.settlement.settlementId,
    reservationId: reservation.reservationId,
    reservationTxHash: reservation.reservationTxHash,
    reservationBlockNumber: reservation.reservationBlockNumber,
    reservationBlockHash: reservation.reservationBlockHash,
    actionId: request.action?.actionId ?? SOLVER_DAEMON_ZERO_BYTES32,
    intentDigest: request.settlement.intentDigest,
    packetResponseDigest: request.action?.packetResponseDigest ?? SOLVER_DAEMON_ZERO_BYTES32,
    quoteExpiresAt: request.action?.quoteExpiresAt ?? 0,
    lightningActionDeadline: request.action?.lightningActionDeadline ?? 0,
    evmRefundAt: request.action?.evmRefundAt ?? 0,
    terminalState: request.terminalState,
    proofDigest: hash(`${request.requestId}:${request.kind}:proof`),
    observedAt: NOW,
    expiresAt: NOW + 10,
    ...overrides,
  };
}

async function approvalFor(record, role, evidencePolicy, signer = null) {
  const wallet = signer ?? (role === "lightningOperator" ? LIGHTNING_OPERATOR : SECURITY_REVIEWER);
  const payload = buildSolverDaemonEvidenceApproval({ record, policy: evidencePolicy });
  return {
    role,
    signer: wallet.address,
    signature: await wallet.signTypedData(payload.domain, payload.types, payload.message),
  };
}

function jsonResponse(body, overrides = {}) {
  return new Response(JSON.stringify(body), {
    status: overrides.status ?? 200,
    headers: {
      "cache-control": overrides.cacheControl ?? "no-store",
      "content-type": overrides.contentType ?? "application/json",
    },
  });
}

function routeHarness({
  evidencePolicy = policy(),
  mutateRecord = null,
  mutateResponse = null,
  signerForRole = null,
} = {}) {
  const consumed = {
    lightningOperator: new Set(),
    securityReviewer: new Set(),
  };
  const calls = [];
  return {
    calls,
    async requestImpl(url, options) {
      const role = url.hostname.startsWith("lightning-") ? "lightningOperator" : "securityReviewer";
      const requestEnvelope = JSON.parse(options.body);
      calls.push({ role, requestEnvelope });
      let record = recordForRequest(requestEnvelope.payload);
      if (mutateRecord) record = mutateRecord({ record, role, requestEnvelope }) ?? record;
      const approvalRole = role;
      const approval = await approvalFor(
        record,
        approvalRole,
        evidencePolicy,
        signerForRole?.({ role, record }) ?? null,
      );
      let response = await buildSolverDaemonEvidenceRouteResponse({
        requestEnvelope,
        requesterPublicKey: REQUESTER_PUBLIC_KEY,
        expectedRequesterKeyId: REQUESTER_KEY_ID,
        consumeRequest: async ({ requestId }) => {
          if (consumed[role].has(requestId)) return false;
          consumed[role].add(requestId);
          return true;
        },
        record,
        policy: evidencePolicy,
        approval,
        now: NOW,
      });
      if (mutateResponse) response = mutateResponse({ response, role, requestEnvelope }) ?? response;
      return jsonResponse(response);
    },
  };
}

function controlsWithHarness(harness, evidencePolicy = policy()) {
  let nonce = 0;
  return createSolverDaemonEvidenceControls({
    policy: evidencePolicy,
    routes: {
      lightningOperator: "https://lightning-approver.internal",
      securityReviewer: "https://security-approver.internal",
    },
    requesterPrivateKey: REQUESTER_PRIVATE_KEY,
    requesterKeyId: REQUESTER_KEY_ID,
    requestImpl: harness.requestImpl,
    nowSeconds: () => NOW,
    randomBytesImpl: () => Buffer.alloc(32, ++nonce),
    requestTtlSeconds: 15,
    timeoutMs: 1_000,
  });
}

test("builds signed exact requests and requires durable one-use consumption at each route", async () => {
  const evidencePolicy = policy("lightning-to-bit");
  assert.throws(() => buildSolverDaemonEvidenceRequest({
    kind: "RESERVATION",
    policy: policy("bit-to-lightning"),
    settlement: settlement("lightning-to-bit", { observed: false }),
    requestId: hash("wrong direction request"),
    requesterKeyId: REQUESTER_KEY_ID,
    requestedAt: NOW,
    expiresAt: NOW + 15,
  }), /direction is outside its policy/);
  const request = buildSolverDaemonEvidenceRequest({
    kind: "RESERVATION",
    policy: evidencePolicy,
    settlement: settlement("lightning-to-bit", { observed: false }),
    requestId: hash("request"),
    requesterKeyId: REQUESTER_KEY_ID,
    requestedAt: NOW,
    expiresAt: NOW + 15,
  });
  assert.equal(request.schema, SOLVER_DAEMON_EVIDENCE_REQUEST_SCHEMA);
  const envelope = signSolverDaemonEvidenceRequest(request, REQUESTER_PRIVATE_KEY);
  assert.equal(verifySolverDaemonEvidenceRequest({
    envelope,
    requesterPublicKey: REQUESTER_PUBLIC_KEY,
    expectedRequesterKeyId: REQUESTER_KEY_ID,
    now: NOW + 1,
  }).requestId, request.requestId);
  assert.throws(() => verifySolverDaemonEvidenceRequest({
    envelope: {
      ...envelope,
      payload: { ...envelope.payload, settlement: { ...envelope.payload.settlement, intentDigest: hash("mutated") } },
    },
    requesterPublicKey: REQUESTER_PUBLIC_KEY,
    expectedRequesterKeyId: REQUESTER_KEY_ID,
    now: NOW + 1,
  }), /signature is invalid/);

  const record = recordForRequest(request);
  const approval = await approvalFor(record, "lightningOperator", evidencePolicy);
  const used = new Set();
  const build = () => buildSolverDaemonEvidenceRouteResponse({
    requestEnvelope: envelope,
    requesterPublicKey: REQUESTER_PUBLIC_KEY,
    expectedRequesterKeyId: REQUESTER_KEY_ID,
    consumeRequest: async ({ requestId }) => {
      if (used.has(requestId)) return false;
      used.add(requestId);
      return true;
    },
    record,
    policy: evidencePolicy,
    approval,
    now: NOW + 1,
  });
  await build();
  await assert.rejects(build(), /already consumed/);
  await assert.rejects(buildSolverDaemonEvidenceRouteResponse({
    requestEnvelope: envelope,
    requesterPublicKey: REQUESTER_PUBLIC_KEY,
    expectedRequesterKeyId: REQUESTER_KEY_ID,
    record,
    policy: evidencePolicy,
    approval,
    now: NOW + 1,
  }), /durable request replay consumer/);
});

test("collects both distinct route approvals for every daemon control and returns uncopyable evidence", async () => {
  const evidencePolicy = policy();
  const harness = routeHarness({ evidencePolicy });
  const controls = controlsWithHarness(harness, evidencePolicy);
  assert.equal(isSolverDaemonEvidenceControls(controls), true);
  assert.equal(isSolverDaemonEvidenceControls({ ...controls }), false);
  assert.equal(solverDaemonEvidenceControlsTransportMode(controls), "injected-test");
  const pending = settlement("bit-to-lightning", { observed: false });
  const observed = settlement();
  const privatePacket = packet();
  const responseDigest = hash("private packet response");
  const plannedAction = action();
  const cases = [
    ["RESERVATION", await controls.observeReservation({ settlement: pending })],
    ["LIGHTNING_DISPATCH", await controls.authorizeLightning({
      settlement: observed,
      action: plannedAction,
      packet: privatePacket,
      packetResponseDigest: responseDigest,
    })],
    ["EVM_CLAIM_DISPATCH", await controls.authorizeEvmClaim({
      settlement: observed,
      action: plannedAction,
      packet: privatePacket,
      packetResponseDigest: responseDigest,
    })],
    ["TERMINAL_COMPLETED", await controls.verifyAssets({ settlement: observed, expectedTerminal: "COMPLETED" })],
    ["TERMINAL_REFUNDED", await controls.verifyAssets({ settlement: observed, expectedTerminal: "REFUNDED" })],
  ];
  for (const [expectedKind, verification] of cases) {
    const context = verifiedSolverDaemonEvidence(verification, { now: NOW + 1, expectedKind });
    assert.equal(context.record.kind, expectedKind);
    assert.equal(context.record.evidencePolicyDigest, solverDaemonEvidencePolicyDigest(evidencePolicy));
    assert.throws(
      () => verifiedSolverDaemonEvidence({ ...verification }, { now: NOW + 1, expectedKind }),
      /provenance is invalid/,
    );
  }
  assert.equal(harness.calls.length, cases.length * 2);
  for (let index = 0; index < harness.calls.length; index += 2) {
    assert.equal(harness.calls[index].requestEnvelope.payload.requestId, harness.calls[index + 1].requestEnvelope.payload.requestId);
    assert.notEqual(
      harness.calls[index].requestEnvelope.payload.requestId,
      harness.calls[(index + 2) % harness.calls.length].requestEnvelope.payload.requestId,
    );
  }
});

test("plugs into the daemon reservation boundary without an injected evidence callback", async (t) => {
  const evidencePolicy = policy("lightning-to-bit");
  const harness = routeHarness({ evidencePolicy });
  const controls = controlsWithHarness(harness, evidencePolicy);
  const pending = settlement("lightning-to-bit", { observed: false });
  const store = await CoordinatorStore.open(":memory:", { allowMemory: true });
  t.after(() => store.close());
  store.acceptSettlement({
    settlementId: pending.settlementId,
    pricingId: hash("integration pricing"),
    direction: pending.direction,
    nonceAuthorityDigest: hash("integration nonce authority"),
    intentNonce: "7",
    intentDigest: pending.intentDigest,
    paymentHash: hash("integration payment"),
    invoiceDigest: hash("integration invoice"),
    amountSats: "10000",
    quoteReceiptDigest: hash("integration quote receipt"),
    selectedSetDigest: hash("integration selected set"),
    selectedOfferId: hash("integration selected offer"),
    capacityEpoch: 9,
    createdAt: NOW,
  });
  const result = await executeSolverDaemonStep({
    store,
    settlementId: pending.settlementId,
    controls,
    expectedEvidencePolicyDigest: solverDaemonEvidencePolicyDigest(evidencePolicy),
    nowSeconds: () => NOW,
  });
  assert.equal(result.outcome, "RESERVATION_RECORDED");
  assert.equal(
    store.getSettlement(pending.settlementId).reservationId,
    hash(`${pending.settlementId}:discovered-reservation`),
  );
  assert.deepEqual(harness.calls.map(({ role }) => role).sort(), ["lightningOperator", "securityReviewer"]);
});

test("fails closed when routes share an origin or a route is public, plaintext, or path-bearing", () => {
  const base = {
    policy: policy(),
    requesterPrivateKey: REQUESTER_PRIVATE_KEY,
    requesterKeyId: REQUESTER_KEY_ID,
  };
  assert.throws(() => createSolverDaemonEvidenceControls({
    ...base,
    routes: {
      lightningOperator: "https://shared.internal",
      securityReviewer: "https://shared.internal",
    },
  }), /distinct private origins/);
  for (const unsafe of [
    "http://lightning-approver.internal",
    "https://example.com",
    "https://lightning-approver.internal/path",
    "https://user:pass@lightning-approver.internal",
  ]) {
    assert.throws(() => createSolverDaemonEvidenceControls({
      ...base,
      routes: {
        lightningOperator: unsafe,
        securityReviewer: "https://security-approver.internal",
      },
    }), /isolated private HTTPS origin/);
  }

  const fixedTransportControls = createSolverDaemonEvidenceControls({
    ...base,
    routes: {
      lightningOperator: "https://lightning-approver.internal",
      securityReviewer: "https://security-approver.internal",
    },
  });
  assert.equal(solverDaemonEvidenceControlsTransportMode(fixedTransportControls), "fixed-node-https");
  assert.throws(
    () => solverDaemonEvidenceControlsTransportMode({ ...fixedTransportControls }),
    /factory provenance/,
  );
});

test("rejects route disagreement, wrong signers, copied responses, redirects, and cacheable bodies", async () => {
  const observed = settlement();
  const disagreeing = routeHarness({
    mutateRecord: ({ record, role }) => role === "securityReviewer"
      ? { ...record, proofDigest: hash("security route disagreed") }
      : record,
  });
  await assert.rejects(
    controlsWithHarness(disagreeing).verifyAssets({ settlement: observed, expectedTerminal: "COMPLETED" }),
    /disagreed on the record/,
  );

  const wrongSigner = routeHarness({
    mutateResponse: ({ response, role }) => role === "securityReviewer" ? {
      ...response,
      approval: { ...response.approval, signer: WRONG_SIGNER.address },
    } : response,
  });
  await assert.rejects(
    controlsWithHarness(wrongSigner).verifyAssets({ settlement: observed, expectedTerminal: "COMPLETED" }),
    /signer is wrong|signature is invalid/,
  );

  let cachedResponse = null;
  const copied = routeHarness({
    mutateResponse: ({ response, role }) => {
      if (role !== "securityReviewer") return response;
      if (cachedResponse === null) cachedResponse = response;
      return cachedResponse;
    },
  });
  const copiedControls = controlsWithHarness(copied);
  await copiedControls.verifyAssets({ settlement: observed, expectedTerminal: "COMPLETED" });
  await assert.rejects(
    copiedControls.verifyAssets({ settlement: observed, expectedTerminal: "REFUNDED" }),
    /changed the request/,
  );

  for (const responseFactory of [
    () => ({ status: 200, redirected: true }),
    () => jsonResponse({}, { cacheControl: "public, max-age=60" }),
  ]) {
    let nonce = 0;
    const controls = createSolverDaemonEvidenceControls({
      policy: policy(),
      routes: {
        lightningOperator: "https://lightning-approver.internal",
        securityReviewer: "https://security-approver.internal",
      },
      requesterPrivateKey: REQUESTER_PRIVATE_KEY,
      requesterKeyId: REQUESTER_KEY_ID,
      requestImpl: async () => responseFactory(),
      nowSeconds: () => NOW,
      randomBytesImpl: () => Buffer.alloc(32, ++nonce),
    });
    await assert.rejects(
      controls.verifyAssets({ settlement: observed, expectedTerminal: "COMPLETED" }),
      /rejected the request|disable storage/,
    );
  }
});

test("rejects unsupported terminal requests, expired evidence, and route timeouts", async () => {
  const observed = settlement();
  const controls = controlsWithHarness(routeHarness());
  assert.throws(
    () => controls.verifyAssets({ settlement: observed, expectedTerminal: "PENDING" }),
    /terminal state is unsupported/,
  );

  const expired = routeHarness({
    mutateRecord: ({ record }) => ({ ...record, observedAt: NOW - 20, expiresAt: NOW }),
  });
  await assert.rejects(
    controlsWithHarness(expired).verifyAssets({ settlement: observed, expectedTerminal: "COMPLETED" }),
    /stale, future-dated, or expired/,
  );

  let nonce = 0;
  const timedOut = createSolverDaemonEvidenceControls({
    policy: policy(),
    routes: {
      lightningOperator: "https://lightning-approver.internal",
      securityReviewer: "https://security-approver.internal",
    },
    requesterPrivateKey: REQUESTER_PRIVATE_KEY,
    requesterKeyId: REQUESTER_KEY_ID,
    requestImpl: async () => new Promise(() => {}),
    nowSeconds: () => NOW,
    randomBytesImpl: () => Buffer.alloc(32, ++nonce),
    timeoutMs: 10,
  });
  await assert.rejects(
    timedOut.verifyAssets({ settlement: observed, expectedTerminal: "COMPLETED" }),
    /transport failed/,
  );
});
