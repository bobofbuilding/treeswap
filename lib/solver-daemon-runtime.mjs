import { randomBytes } from "node:crypto";
import {
  CoordinatorDispatchError,
  dispatchLightningAction,
  lightningActionCommitment,
  readConfirmedLightningPaymentProof,
  reconcileLightningAction,
} from "./coordinator-action-runner.mjs";
import { coordinatorCommitmentDigest } from "./coordinator-store.mjs";
import {
  dispatchEvmClaimAction,
  evmClaimActionCommitment,
  prepareEvmClaimAction,
  reconcileEvmClaimActionWithQuorum,
} from "./evm-action-runner.mjs";
import {
  buildPrivatePacketRequest,
  fetchVerifiedPrivatePacket,
  isVerifiedPrivatePacketResult,
  signPrivatePacketRequest,
} from "./solver-private-packet.mjs";
import { verifiedSolverDaemonEvidence } from "./solver-daemon-evidence.mjs";
import { nextSolverDaemonStep } from "./solver-daemon-planner.mjs";

const BYTES32 = /^0x[0-9a-f]{64}$/;
const SEND_PAYMENT = "/routerrpc.Router/SendPaymentV2";
const SETTLE_INVOICE = "/invoicesrpc.Invoices/SettleInvoice";
const EVM_CLAIM = "evm:claim";

function bytes32(value, name) {
  const raw = String(value ?? "");
  if (!BYTES32.test(raw)) throw new TypeError(`${name} must be lowercase bytes32`);
  return raw;
}

function integer(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative safe integer`);
  return value;
}

function currentTime(nowSeconds, startedAt, name) {
  const value = integer(nowSeconds(), name);
  if (value < startedAt) throw new Error("daemon clock moved backwards during one step");
  return value;
}

function assertFreshPacket(packetRead, now, label) {
  const expiresAt = integer(packetRead.expiresAt, `${label} packet expiresAt`);
  if (expiresAt <= now) throw new Error(`${label} private packet expired before use`);
  return expiresAt;
}

function freshRequestId(randomBytesImpl) {
  const source = randomBytesImpl(32);
  if (!Buffer.isBuffer(source) && !(source instanceof Uint8Array)) throw new Error("daemon randomness source is invalid");
  const value = Buffer.from(source);
  if (value.length !== 32) throw new Error("daemon randomness source returned the wrong size");
  return `0x${value.toString("hex")}`;
}

function daemonActionDraft(settlement, method, plannedAt) {
  const actionId = coordinatorCommitmentDigest({
    schema: "treeswap.solver-daemon-action.v1",
    settlementId: settlement.settlementId,
    method,
  });
  return {
    actionId,
    settlementId: settlement.settlementId,
    method,
    requestId: coordinatorCommitmentDigest({
      schema: "treeswap.solver-daemon-request.v1",
      actionId,
      intentDigest: settlement.intentDigest,
    }),
    payloadDigest: coordinatorCommitmentDigest({ schema: "treeswap.pending-payload.v1", actionId }),
    intentDigest: settlement.intentDigest,
    paymentHash: settlement.paymentHash,
    invoiceDigest: settlement.invoiceDigest,
    amountSats: settlement.amountSats,
    capacityEpoch: settlement.capacityEpoch,
    plannedAt,
  };
}

function purposeForMethod(method) {
  if (method === SEND_PAYMENT) return "SEND_PAYMENT";
  if (method === SETTLE_INVOICE) return "SETTLE_INVOICE";
  if (method === EVM_CLAIM) return "EVM_CLAIM";
  throw new RangeError("daemon action method is unsupported");
}

function safeResult(step, outcome, details = {}) {
  return Object.freeze({
    settlementId: step.settlementId,
    stepKind: step.kind,
    outcome,
    ...details,
  });
}

async function guardSideEffect(beforeSideEffect, boundary) {
  if (beforeSideEffect === null) return;
  if (typeof beforeSideEffect !== "function") throw new TypeError("beforeSideEffect must be a function");
  await beforeSideEffect(boundary);
}

async function halt(store, step, haltCode, reason, recordedAt, beforeSideEffect) {
  const evidenceDigest = coordinatorCommitmentDigest({
    schema: "treeswap.solver-daemon-halt.v1",
    settlementId: step.settlementId,
    stepKind: step.kind,
    haltCode,
    reason,
  });
  await guardSideEffect(beforeSideEffect, "settlement-halt");
  const settlement = store.haltSettlement({
    settlementId: step.settlementId,
    haltCode,
    evidenceDigest,
    recordedAt,
  });
  return safeResult(step, "HALTED", { haltCode: settlement.haltCode, evidenceDigest });
}

function assertEvidenceSettlement(record, settlement, label, { requireReservation = true } = {}) {
  if (record.settlementId !== settlement.settlementId || record.direction !== settlement.direction
      || record.intentDigest !== settlement.intentDigest) {
    throw new Error(`${label} evidence changed the settlement binding`);
  }
  if (requireReservation && (
    record.reservationId !== settlement.reservationId
      || record.reservationTxHash !== settlement.reservationTxHash
      || record.reservationBlockNumber !== settlement.reservationBlockNumber
      || record.reservationBlockHash !== settlement.reservationBlockHash
  )) throw new Error(`${label} evidence changed the observed reservation`);
}

function assertEvidencePolicy(record, expectedEvidencePolicyDigest, label) {
  const expected = bytes32(expectedEvidencePolicyDigest, `${label} expected evidence policy digest`);
  if (record.evidencePolicyDigest !== expected) throw new Error(`${label} evidence policy is not active`);
}

function validateDispatchAuthorization(verification, {
  action,
  expectedKind,
  expectedEvidencePolicyDigest,
  settlement,
  packet,
  packetResponseDigest,
  deadline,
  now,
  label,
}) {
  const { record } = verifiedSolverDaemonEvidence(verification, { now, expectedKind });
  assertEvidencePolicy(record, expectedEvidencePolicyDigest, label);
  assertEvidenceSettlement(record, settlement, label);
  if (record.actionId !== action.actionId || record.intentDigest !== action.intentDigest
      || record.packetResponseDigest !== packetResponseDigest
      || record.quoteExpiresAt !== packet.quoteExpiresAt
      || record.lightningActionDeadline !== packet.lightningActionDeadline
      || record.evmRefundAt !== packet.evmRefundAt) {
    throw new Error(`${label} authorization changed the bound action`);
  }
  const expiresAt = integer(record.expiresAt, `${label} authorization expiresAt`);
  if (expiresAt <= now || expiresAt > deadline) throw new Error(`${label} authorization is outside the private deadline`);
  bytes32(record.proofDigest, `${label} authorization proofDigest`);
  return Object.freeze({ expiresAt, evidenceDigest: record.proofDigest });
}

function lightningConfig(value) {
  if (!value || typeof value !== "object") throw new Error("Lightning daemon configuration is required");
  if (!value.privateKey || !value.keyId || !value.adapterUrl) throw new Error("Lightning daemon credentials are incomplete");
  return value;
}

function evmConfig(value) {
  if (!value || typeof value !== "object") throw new Error("EVM daemon configuration is required");
  if (!value.signer || !value.expectedChainId || !value.expectedContract || !value.expectedContractCodeHash
      || !value.maximumGasCostWei || !value.rpcUrl) {
    throw new Error("EVM daemon configuration is incomplete");
  }
  if (!Array.isArray(value.reconciliationProviders) || value.reconciliationProviders.length !== 2) {
    throw new Error("EVM reconciliation provider quorum is incomplete");
  }
  return value;
}

function findConfirmedPayment(store, settlementId) {
  const action = store.listSettlementActions(settlementId)
    .find((candidate) => candidate.method === SEND_PAYMENT && candidate.state === "CONFIRMED");
  if (!action) throw new Error("confirmed Lightning payment action does not exist");
  return action;
}

async function readPaymentProof({ store, settlement, lightning, randomBytesImpl, nowSeconds }) {
  const payment = findConfirmedPayment(store, settlement.settlementId);
  const proof = await readConfirmedLightningPaymentProof({
    store,
    actionId: payment.actionId,
    requestId: freshRequestId(randomBytesImpl),
    privateKey: lightning.privateKey,
    keyId: lightning.keyId,
    adapterUrl: lightning.adapterUrl,
    nowSeconds,
    authorizationLifetimeSeconds: lightning.authorizationLifetimeSeconds,
    requestImpl: lightning.requestImpl,
    requestTimeoutMs: lightning.requestTimeoutMs,
  });
  return Object.freeze({ payment, preimage: proof.preimage });
}

async function prepareClaim({
  store,
  settlement,
  existingAction = null,
  packetClient,
  lightning,
  evm,
  randomBytesImpl,
  nowSeconds,
  beforeSideEffect,
  stepStartedAt,
}) {
  const proof = await readPaymentProof({ store, settlement, lightning, randomBytesImpl, nowSeconds });
  const packetRead = await packetClient.read({
    settlement,
    action: existingAction ?? proof.payment,
    purpose: "EVM_CLAIM",
  });
  if (!isVerifiedPrivatePacketResult(packetRead)) throw new Error("private packet result is not authenticated");
  bytes32(packetRead.responseDigest, "private packet response digest");
  const operation = Object.freeze({ ...packetRead.packet.operation, preimage: proof.preimage });
  const plannedAt = currentTime(nowSeconds, stepStartedAt, "claim plannedAt");
  const draft = existingAction ? {
    actionId: existingAction.actionId,
    settlementId: existingAction.settlementId,
    method: existingAction.method,
    requestId: existingAction.requestId,
    payloadDigest: existingAction.payloadDigest,
    intentDigest: existingAction.intentDigest,
    paymentHash: existingAction.paymentHash,
    invoiceDigest: existingAction.invoiceDigest,
    amountSats: existingAction.amountSats,
    capacityEpoch: existingAction.capacityEpoch,
    plannedAt: existingAction.plannedAt,
  } : daemonActionDraft(settlement, EVM_CLAIM, plannedAt);
  draft.payloadDigest = evmClaimActionCommitment(draft, operation, await evm.signer.getAddress());
  if (existingAction && draft.payloadDigest !== existingAction.payloadDigest) {
    throw new Error("rehydrated EVM claim changed the durable payload commitment");
  }
  if (existingAction && store.getEvmTransaction(existingAction.actionId)) {
    return Object.freeze({
      action: existingAction,
      packet: packetRead.packet,
      packetResponseDigest: packetRead.responseDigest,
      packetExpiresAt: packetRead.expiresAt,
      operation,
    });
  }
  const prepared = await prepareEvmClaimAction({
    store,
    action: draft,
    operation,
    signer: evm.signer,
    expectedChainId: evm.expectedChainId,
    expectedContract: evm.expectedContract,
    expectedContractCodeHash: evm.expectedContractCodeHash,
    maximumGasCostWei: evm.maximumGasCostWei,
    boundAt: plannedAt,
    beforeStateChange: async (boundary) => {
      await guardSideEffect(beforeSideEffect, boundary);
      const boundaryNow = currentTime(nowSeconds, stepStartedAt, "EVM preparation boundary time");
      assertFreshPacket(packetRead, boundaryNow, "EVM claim");
    },
  });
  return Object.freeze({
    action: prepared.action,
    packet: packetRead.packet,
    packetResponseDigest: packetRead.responseDigest,
    packetExpiresAt: packetRead.expiresAt,
    operation,
  });
}

export function createAuthenticatedPrivatePacketClient({
  providerOrigin,
  requesterPrivateKey,
  requesterKeyId,
  providerPublicKey,
  providerKeyId,
  minimumEvmSafetySeconds,
  requestTtlSeconds = 15,
  timeoutMs = 5_000,
  requestImpl = fetch,
  nowSeconds = () => Math.floor(Date.now() / 1_000),
  randomBytesImpl = randomBytes,
}) {
  const ttl = integer(requestTtlSeconds, "private packet request TTL");
  if (ttl === 0 || ttl > 30) throw new RangeError("private packet request TTL is outside policy");
  return Object.freeze({
    async read({ settlement, action = null, purpose }) {
      const requestedAt = integer(nowSeconds(), "private packet requestedAt");
      const payload = buildPrivatePacketRequest({
        settlement,
        action,
        purpose,
        requestId: freshRequestId(randomBytesImpl),
        requesterKeyId,
        requestedAt,
        expiresAt: requestedAt + ttl,
      });
      const requestEnvelope = signPrivatePacketRequest(payload, requesterPrivateKey);
      return fetchVerifiedPrivatePacket({
        providerOrigin,
        requestEnvelope,
        providerPublicKey,
        expectedProviderKeyId: providerKeyId,
        minimumEvmSafetySeconds,
        requestImpl,
        nowSeconds,
        timeoutMs,
      });
    },
  });
}

export async function executeSolverDaemonStep({
  store,
  settlementId,
  packetClient,
  controls = {},
  lightning = null,
  evm = null,
  expectedEvidencePolicyDigest = null,
  nowSeconds = () => Math.floor(Date.now() / 1_000),
  randomBytesImpl = randomBytes,
  beforeSideEffect = null,
}) {
  if (!store || typeof store.getSettlement !== "function") throw new TypeError("a coordinator store is required");
  const step = nextSolverDaemonStep({ store, settlementId: bytes32(settlementId, "settlementId") });
  const now = integer(nowSeconds(), "daemon execution time");
  const settlement = store.getSettlement(step.settlementId);

  switch (step.kind) {
    case "WAIT_FOR_RESERVATION": {
      if (typeof controls.observeReservation !== "function") return safeResult(step, "WAITING");
      const verification = await controls.observeReservation({ settlement, now });
      if (!verification) return safeResult(step, "WAITING");
      await guardSideEffect(beforeSideEffect, "reservation-record");
      const evidenceNow = currentTime(nowSeconds, now, "reservation evidence time");
      let record;
      try {
        ({ record } = verifiedSolverDaemonEvidence(verification, { now: evidenceNow, expectedKind: "RESERVATION" }));
        assertEvidencePolicy(record, expectedEvidencePolicyDigest, "reservation");
        assertEvidenceSettlement(record, settlement, "reservation", { requireReservation: false });
      } catch (error) {
        return halt(store, step, "DAEMON_RESERVATION_EVIDENCE", error.message, evidenceNow, beforeSideEffect);
      }
      const observed = {
        settlementId: record.settlementId,
        reservationId: record.reservationId,
        reservationTxHash: record.reservationTxHash,
        reservationBlockNumber: record.reservationBlockNumber,
        reservationBlockHash: record.reservationBlockHash,
        reservationIntentDigest: record.intentDigest,
        observedAt: record.observedAt,
      };
      store.recordReservation(observed);
      return safeResult(step, "RESERVATION_RECORDED", { reservationId: observed.reservationId });
    }

    case "PLAN_LIGHTNING_ACTION": {
      if (typeof packetClient?.read !== "function") {
        throw new Error("authenticated private packet client is required");
      }
      const packetRead = await packetClient.read({ settlement, purpose: purposeForMethod(step.method) });
      if (!isVerifiedPrivatePacketResult(packetRead)) throw new Error("private packet result is not authenticated");
      bytes32(packetRead.responseDigest, "private packet response digest");
      const draft = daemonActionDraft(settlement, step.method, now);
      draft.payloadDigest = lightningActionCommitment(draft, packetRead.packet.operation);
      await guardSideEffect(beforeSideEffect, "lightning-action-plan");
      const planNow = currentTime(nowSeconds, now, "Lightning action plan time");
      assertFreshPacket(packetRead, planNow, "Lightning action");
      const action = store.planAction(draft);
      return safeResult(step, "ACTION_PLANNED", { actionId: action.actionId, method: action.method });
    }

    case "AUTHORIZE_AND_DISPATCH_LIGHTNING": {
      if (typeof packetClient?.read !== "function") {
        throw new Error("authenticated private packet client is required");
      }
      const config = lightningConfig(lightning);
      const action = store.getAction(step.actionId);
      const packetRead = await packetClient.read({ settlement, action, purpose: purposeForMethod(action.method) });
      if (!isVerifiedPrivatePacketResult(packetRead)) throw new Error("private packet result is not authenticated");
      bytes32(packetRead.responseDigest, "private packet response digest");
      if (typeof controls.authorizeLightning !== "function") return safeResult(step, "GATE_CLOSED");
      const verification = await controls.authorizeLightning({
        settlement,
        action,
        packet: packetRead.packet,
        packetResponseDigest: packetRead.responseDigest,
        now,
      });
      if (!verification) return safeResult(step, "GATE_CLOSED");
      const authorizationNow = currentTime(nowSeconds, now, "Lightning authorization time");
      let authorization;
      try {
        assertFreshPacket(packetRead, authorizationNow, "Lightning dispatch");
        authorization = validateDispatchAuthorization(verification, {
          action,
          expectedKind: "LIGHTNING_DISPATCH",
          expectedEvidencePolicyDigest,
          settlement,
          packet: packetRead.packet,
          packetResponseDigest: packetRead.responseDigest,
          deadline: packetRead.packet.lightningActionDeadline,
          now: authorizationNow,
          label: "Lightning",
        });
      } catch (error) {
        return halt(store, step, "DAEMON_AUTH_MISMATCH", error.message, authorizationNow, beforeSideEffect);
      }
      const beforeAuthorizedDispatch = async (boundary) => {
        await guardSideEffect(beforeSideEffect, boundary);
        const boundaryNow = currentTime(nowSeconds, now, "Lightning dispatch boundary time");
        if (authorization.expiresAt <= boundaryNow) {
          throw new Error("Lightning authorization expired before dispatch");
        }
        assertFreshPacket(packetRead, boundaryNow, "Lightning dispatch");
      };
      try {
        const dispatched = await dispatchLightningAction({
          store,
          actionId: action.actionId,
          operation: packetRead.packet.operation,
          privateKey: config.privateKey,
          keyId: config.keyId,
          adapterUrl: config.adapterUrl,
          nowSeconds,
          authorizationLifetimeSeconds: config.authorizationLifetimeSeconds,
          requestImpl: config.requestImpl,
          dispatchTimeoutMs: config.dispatchTimeoutMs,
          beforeSideEffect: beforeAuthorizedDispatch,
        });
        return safeResult(step, "DISPATCH_CONFIRMED", {
          actionId: dispatched.action.actionId,
          actionState: dispatched.action.state,
        });
      } catch (error) {
        if (error instanceof CoordinatorDispatchError && error.ambiguous) {
          return safeResult(step, "DISPATCH_AMBIGUOUS", { actionId: action.actionId, actionState: "UNKNOWN" });
        }
        throw error;
      }
    }

    case "RECOVER_INTERRUPTED_ACTION": {
      await guardSideEffect(beforeSideEffect, "interrupted-action-recovery");
      const recovered = store.recoverInterruptedAction(step.actionId, now);
      return safeResult(step, "ACTION_MARKED_UNKNOWN", { actionId: recovered.action.actionId });
    }

    case "RECONCILE_ACTION": {
      const action = store.getAction(step.actionId);
      if (action.method === EVM_CLAIM) {
        const config = evmConfig(evm);
        const reconciled = await reconcileEvmClaimActionWithQuorum({
          store,
          actionId: action.actionId,
          providers: config.reconciliationProviders,
          expectedContractCodeHash: config.expectedContractCodeHash,
          nowSeconds,
          requestTimeoutMs: config.requestTimeoutMs,
          beforeStateChange: beforeSideEffect,
        });
        return safeResult(step, "ACTION_RECONCILED", {
          actionId: action.actionId,
          disposition: reconciled.disposition,
          actionState: reconciled.action.state,
          providerConsensusDigest: reconciled.providerQuorum.consensusDigest,
        });
      }
      const config = lightningConfig(lightning);
      const reconciled = await reconcileLightningAction({
        store,
        actionId: action.actionId,
        reconciliationRequestId: freshRequestId(randomBytesImpl),
        privateKey: config.privateKey,
        keyId: config.keyId,
        adapterUrl: config.adapterUrl,
        nowSeconds,
        authorizationLifetimeSeconds: config.authorizationLifetimeSeconds,
        requestImpl: config.requestImpl,
        requestTimeoutMs: config.requestTimeoutMs,
        beforeStateChange: beforeSideEffect,
      });
      return safeResult(step, "ACTION_RECONCILED", {
        actionId: action.actionId,
        disposition: reconciled.disposition,
        actionState: reconciled.action.state,
      });
    }

    case "RECOVER_PAYMENT_PROOF_AND_PREPARE_EVM_CLAIM":
    case "PREPARE_EVM_CLAIM_TRANSACTION": {
      if (typeof packetClient?.read !== "function") {
        throw new Error("authenticated private packet client is required");
      }
      const prepared = await prepareClaim({
        store,
        settlement,
        existingAction: step.kind === "PREPARE_EVM_CLAIM_TRANSACTION" ? store.getAction(step.actionId) : null,
        packetClient,
        lightning: lightningConfig(lightning),
        evm: evmConfig(evm),
        randomBytesImpl,
        nowSeconds,
        beforeSideEffect,
        stepStartedAt: now,
      });
      return safeResult(step, "EVM_CLAIM_PREPARED", { actionId: prepared.action.actionId });
    }

    case "DISPATCH_EVM_CLAIM": {
      if (typeof packetClient?.read !== "function") {
        throw new Error("authenticated private packet client is required");
      }
      const config = evmConfig(evm);
      const action = store.getAction(step.actionId);
      const prepared = await prepareClaim({
        store,
        settlement,
        existingAction: action,
        packetClient,
        lightning: lightningConfig(lightning),
        evm: config,
        randomBytesImpl,
        nowSeconds,
        beforeSideEffect,
        stepStartedAt: now,
      });
      if (typeof controls.authorizeEvmClaim !== "function") return safeResult(step, "GATE_CLOSED");
      const verification = await controls.authorizeEvmClaim({
        settlement,
        action,
        packet: prepared.packet,
        packetResponseDigest: prepared.packetResponseDigest,
        transaction: store.getEvmTransaction(action.actionId),
        now,
      });
      if (!verification) return safeResult(step, "GATE_CLOSED");
      const authorizationNow = currentTime(nowSeconds, now, "EVM claim authorization time");
      let authorization;
      try {
        if (prepared.packetExpiresAt <= authorizationNow) {
          throw new Error("EVM claim private packet expired before use");
        }
        authorization = validateDispatchAuthorization(verification, {
          action,
          expectedKind: "EVM_CLAIM_DISPATCH",
          expectedEvidencePolicyDigest,
          settlement,
          packet: prepared.packet,
          packetResponseDigest: prepared.packetResponseDigest,
          deadline: prepared.packet.evmRefundAt,
          now: authorizationNow,
          label: "EVM claim",
        });
      } catch (error) {
        return halt(store, step, "DAEMON_AUTH_MISMATCH", error.message, authorizationNow, beforeSideEffect);
      }
      const beforeAuthorizedDispatch = async (boundary) => {
        await guardSideEffect(beforeSideEffect, boundary);
        const boundaryNow = currentTime(nowSeconds, now, "EVM dispatch boundary time");
        if (authorization.expiresAt <= boundaryNow) {
          throw new Error("EVM claim authorization expired before dispatch");
        }
        if (prepared.packetExpiresAt <= boundaryNow) {
          throw new Error("EVM claim private packet expired before dispatch");
        }
      };
      const dispatched = await dispatchEvmClaimAction({
        store,
        actionId: action.actionId,
        operation: prepared.operation,
        signer: config.signer,
        expectedChainId: config.expectedChainId,
        expectedContract: config.expectedContract,
        expectedContractCodeHash: config.expectedContractCodeHash,
        maximumGasCostWei: config.maximumGasCostWei,
        rpcUrl: config.rpcUrl,
        rpcRequestImpl: config.rpcRequestImpl,
        nowSeconds,
        requestTimeoutMs: config.requestTimeoutMs,
        beforeSideEffect: beforeAuthorizedDispatch,
      });
      return safeResult(step, "EVM_BROADCAST_UNPROVEN", {
        actionId: action.actionId,
        actionState: dispatched.action.state,
        broadcastAccepted: dispatched.broadcastAccepted,
      });
    }

    case "VERIFY_BOTH_ASSETS_AND_COMPLETE":
    case "WAIT_FOR_BIT_CLAIM_AND_RECONCILE":
    case "VERIFY_REFUND_AND_RECONCILE": {
      if (typeof controls.verifyAssets !== "function") return safeResult(step, "WAITING");
      const expectedTerminal = step.kind === "VERIFY_REFUND_AND_RECONCILE" ? "REFUNDED" : "COMPLETED";
      const verification = await controls.verifyAssets({ settlement, expectedTerminal, now });
      if (!verification) return safeResult(step, "WAITING");
      await guardSideEffect(beforeSideEffect, "terminal-record");
      const evidenceNow = currentTime(nowSeconds, now, "terminal evidence time");
      let record;
      try {
        ({ record } = verifiedSolverDaemonEvidence(verification, {
          now: evidenceNow,
          expectedKind: expectedTerminal === "COMPLETED" ? "TERMINAL_COMPLETED" : "TERMINAL_REFUNDED",
        }));
        assertEvidencePolicy(record, expectedEvidencePolicyDigest, "terminal asset");
        assertEvidenceSettlement(record, settlement, "terminal asset");
        if (record.terminalState !== expectedTerminal) throw new Error("asset evidence returned an incompatible terminal state");
      } catch (error) {
        return halt(store, step, "DAEMON_ASSET_MISMATCH", error.message, evidenceNow, beforeSideEffect);
      }
      const terminal = store.recordTerminal({
        settlementId: settlement.settlementId,
        terminalState: expectedTerminal,
        assetsReconciled: true,
        proofDigest: bytes32(record.proofDigest, "asset reconciliation proofDigest"),
        recordedAt: evidenceNow,
      });
      return safeResult(step, "TERMINAL_RECORDED", { terminalState: terminal.terminalState });
    }

    case "HALT_REQUIRED":
      return halt(store, step, "DAEMON_ORDERING", step.reason, now, beforeSideEffect);
    case "HALTED":
      return safeResult(step, "HALTED", { haltCode: step.haltCode });
    case "DONE":
      return safeResult(step, "DONE", { terminalState: step.terminalState });
    default:
      throw new Error(`unsupported solver daemon step ${step.kind}`);
  }
}
