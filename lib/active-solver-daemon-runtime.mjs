import {
  verifiedActiveSolverDaemonContext,
  verifiedRecoverySolverDaemonContext,
} from "./capabilities.mjs";
import { assertCoordinatorServiceLeaseOwnership } from "./coordinator-service-state.mjs";
import {
  CoordinatorStore,
  coordinatorCommitmentDigest,
  isVerifiedCoordinatorStore,
} from "./coordinator-store.mjs";
import { executeSolverDaemonStep } from "./solver-daemon-runtime.mjs";
import { nextSolverDaemonStep } from "./solver-daemon-planner.mjs";

const ACTIVE_NEW_EXPOSURE_STEPS = new Set(["AUTHORIZE_AND_DISPATCH_LIGHTNING"]);
const RECOVERY_FORBIDDEN_STEPS = new Set([
  "PLAN_LIGHTNING_ACTION",
  "AUTHORIZE_AND_DISPATCH_LIGHTNING",
]);
const EVM_CLAIM_WORK_STEPS = new Set([
  "RECOVER_PAYMENT_PROOF_AND_PREPARE_EVM_CLAIM",
  "PREPARE_EVM_CLAIM_TRANSACTION",
  "DISPATCH_EVM_CLAIM",
]);
const BYTES32 = /^0x[0-9a-f]{64}$/;
const REQUIRED_STORE_METHODS = Object.freeze(Object.fromEntries([
  "bindEvmTransaction", "bindSettlementExecutionPolicy", "claimAction", "claimEvmBroadcast", "getAction",
  "getEvmTransaction", "getFirmOffer", "getRfqRequest", "getSettlement", "haltSettlement",
  "listSettlementActions", "planAction", "reconcileAction", "recordActionResult", "recordEvmInclusion",
  "recordReservation", "recordTerminal", "recoverInterruptedAction",
].map((name) => [name, CoordinatorStore.prototype[name]])));
const recoveryExecutionFences = new WeakMap();
const activeExecutionFences = new WeakMap();

class ActiveFundingGateClosedError extends Error {}
class ActiveExecutionGateClosedError extends Error {}
class RecoveryGateClosedError extends Error {}

function verifiedActiveSolverDaemonExecutionFence(fence, { requireActive = true } = {}) {
  const state = fence && typeof fence === "object" ? activeExecutionFences.get(fence) : null;
  if (!state) throw new TypeError("active daemon requires an original same-process execution fence");
  if (requireActive && state.active !== true) {
    throw new ActiveExecutionGateClosedError("active daemon execution fence is inactive");
  }
  return state;
}

export function createActiveSolverDaemonExecutionFence() {
  const fence = Object.freeze({
    schema: "treeswap.active-solver-daemon-execution-fence.v1",
    scope: "same-process-cancellable-active-side-effect-boundary",
  });
  activeExecutionFences.set(fence, { active: true });
  return fence;
}

export function deactivateActiveSolverDaemonExecutionFence(fence) {
  const state = verifiedActiveSolverDaemonExecutionFence(fence, { requireActive: false });
  if (state.active !== true) return false;
  state.active = false;
  return true;
}

function verifiedRecoverySolverDaemonExecutionFence(fence, { requireActive = true } = {}) {
  const state = fence && typeof fence === "object" ? recoveryExecutionFences.get(fence) : null;
  if (!state) throw new TypeError("recovery daemon requires an original same-process execution fence");
  if (requireActive && state.active !== true) {
    throw new RecoveryGateClosedError("recovery daemon execution fence is inactive");
  }
  return state;
}

export function createRecoverySolverDaemonExecutionFence() {
  const fence = Object.freeze({
    schema: "treeswap.recovery-solver-daemon-execution-fence.v1",
    scope: "same-process-cancellable-recovery-side-effect-boundary",
  });
  recoveryExecutionFences.set(fence, { active: true });
  return fence;
}

export function deactivateRecoverySolverDaemonExecutionFence(fence) {
  const state = verifiedRecoverySolverDaemonExecutionFence(fence, { requireActive: false });
  if (state.active !== true) return false;
  state.active = false;
  return true;
}

function nonzeroDigest(value) {
  return BYTES32.test(String(value ?? "")) && !/^0x0{64}$/.test(value);
}

function assertOriginalCoordinatorStore(store) {
  if (!isVerifiedCoordinatorStore(store)) {
    throw new TypeError("active daemon requires an original coordinator store with firm-offer provenance");
  }
  for (const [name, method] of Object.entries(REQUIRED_STORE_METHODS)) {
    if (typeof method !== "function" || store[name] !== method) {
      throw new TypeError("active daemon requires unmodified original coordinator store methods");
    }
  }
  return store;
}

function durableSettlementBinding({
  store,
  settlementId,
  context,
  now,
  requireActive,
  requireContextCapacityEpoch = true,
}) {
  const authority = assertOriginalCoordinatorStore(store);
  const settlement = REQUIRED_STORE_METHODS.getSettlement.call(authority, settlementId);
  if (!settlement) throw new Error("active daemon settlement does not exist");
  const offer = REQUIRED_STORE_METHODS.getFirmOffer.call(authority, settlement.selectedOfferId);
  const request = offer
    ? REQUIRED_STORE_METHODS.getRfqRequest.call(authority, offer.requestId)
    : null;
  const expectedExecutionPolicyBindingDigest = settlement
    ? coordinatorCommitmentDigest({
        schema: "treeswap.settlement-execution-policy.v3",
        settlementId: settlement.settlementId,
        selectedOfferId: settlement.selectedOfferId,
        marketRiskDigest: offer?.marketRiskDigest,
        riskPolicyDigest: settlement.riskPolicyDigest,
        marketRiskValidUntil: offer?.marketRiskValidUntil,
        releaseRecordDigest: settlement.releaseRecordDigest,
        evidencePolicyDigest: settlement.evidencePolicyDigest,
        solverCapabilityDigest: settlement.solverCapabilityDigest,
        boundAt: settlement.executionPolicyBoundAt,
      })
    : null;
  if (!offer
      || offer.offerId !== settlement.selectedOfferId
      || offer.requestId !== settlement.pricingId
      || offer.solverId !== context.solverId
      || offer.direction !== context.direction
      || offer.direction !== settlement.direction
      || (requireContextCapacityEpoch && offer.capacityEpoch !== context.capacityEpoch)
      || offer.capacityEpoch !== settlement.capacityEpoch
      || !request || request.requestId !== settlement.pricingId
      || request.direction !== settlement.direction
      || request.notionalSats !== settlement.amountSats
      || !nonzeroDigest(offer.capabilityDigest)
      || offer.capabilityDigest !== settlement.solverCapabilityDigest
      || (requireContextCapacityEpoch && offer.capabilityDigest !== context.solverCapabilityDigest)
      || !nonzeroDigest(settlement.releaseRecordDigest)
      || !nonzeroDigest(settlement.riskPolicyDigest)
      || !nonzeroDigest(offer.marketRiskPolicyDigest)
      || offer.marketRiskPolicyDigest !== settlement.riskPolicyDigest
      || (context.riskPolicyDigest !== undefined
        && settlement.riskPolicyDigest !== context.riskPolicyDigest)
      || !nonzeroDigest(settlement.evidencePolicyDigest)
      || !nonzeroDigest(settlement.executionPolicyBindingDigest)
      || settlement.executionPolicyBindingDigest !== expectedExecutionPolicyBindingDigest
      || settlement.releaseRecordDigest !== context.releaseRecordDigest
      || settlement.evidencePolicyDigest !== context.evidencePolicyDigest
      || !Number.isSafeInteger(settlement.executionPolicyBoundAt)) {
    throw new Error("active daemon settlement is not bound to the authorized solver offer and capacity epoch");
  }
  if (!nonzeroDigest(offer.selectionAuthorizationDigest)
      || !nonzeroDigest(offer.marketRiskDigest)
      || !Number.isSafeInteger(offer.marketRiskValidUntil)
      || offer.marketRiskValidUntil < offer.expiresAt
      || !nonzeroDigest(offer.privateRequestDigest)
      || !nonzeroDigest(offer.executableOfferDigest)
      || !nonzeroDigest(offer.executionBindingDigest)
      || !nonzeroDigest(offer.executionAuthorizationDigest)
      || !Number.isSafeInteger(offer.finalizedAt)
      || !Number.isSafeInteger(offer.authorizedAt)
      || offer.finalizedAt > offer.authorizedAt) {
    throw new Error("active daemon settlement lacks a complete executable quote and user authorization");
  }
  if (requireActive) {
    if (offer.state !== "ACTIVE" || !Number.isSafeInteger(offer.expiresAt) || offer.expiresAt <= now
        || offer.marketRiskValidUntil <= now
        || !Number.isSafeInteger(offer.executionAuthorizationExpiresAt)
        || offer.executionAuthorizationExpiresAt <= now
        || offer.authorizedAt > now
        || !request || request.state !== "ACTIVE" || !Number.isSafeInteger(request.expiresAt)
        || request.expiresAt <= now) {
      throw new Error("active daemon selected offer, user authorization, or RFQ is no longer active");
    }
  }
  return Object.freeze({ offer, settlement });
}

export async function bindActiveSolverSettlementExecutionPolicy(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("active settlement policy binding input must be an object");
  }
  const keys = Object.keys(input).sort();
  const expected = ["executionContext", "executionFence", "serviceLease", "settlementId", "store"].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new TypeError("active settlement policy binding fields are not exact");
  }
  const now = Math.floor(Date.now() / 1_000);
  verifiedActiveSolverDaemonExecutionFence(input.executionFence);
  const context = verifiedActiveSolverDaemonContext(input.executionContext, {
    now,
    requireFundingAuthorization: true,
  });
  const store = assertOriginalCoordinatorStore(input.store);
  await assertCoordinatorServiceLeaseOwnership(input.serviceLease);
  verifiedActiveSolverDaemonExecutionFence(input.executionFence);
  assertOriginalCoordinatorStore(store);
  return REQUIRED_STORE_METHODS.bindSettlementExecutionPolicy.call(store, {
    settlementId: input.settlementId,
    releaseRecordDigest: context.releaseRecordDigest,
    riskPolicyDigest: context.riskPolicyDigest,
    evidencePolicyDigest: context.evidencePolicyDigest,
    solverCapabilityDigest: context.solverCapabilityDigest,
    boundAt: now,
  });
}

export async function executeActiveSolverDaemonStep({
  executionContext,
  executionFence,
  serviceLease,
  store,
  settlementId,
  ...runtime
}) {
  if (Object.prototype.hasOwnProperty.call(runtime, "expectedEvidencePolicyDigest")) {
    throw new TypeError("active daemon evidence policy digest cannot be supplied by its caller");
  }
  if (Object.prototype.hasOwnProperty.call(runtime, "nowSeconds")) {
    throw new TypeError("active daemon execution time cannot be supplied by its caller");
  }
  if (Object.prototype.hasOwnProperty.call(runtime, "beforeSideEffect")) {
    throw new TypeError("active daemon leadership guard cannot be supplied by its caller");
  }
  verifiedActiveSolverDaemonExecutionFence(executionFence);
  const now = Math.floor(Date.now() / 1_000);
  const binding = verifiedActiveSolverDaemonContext(executionContext, {
    now,
    requireFundingAuthorization: false,
  });
  durableSettlementBinding({ store, settlementId, context: binding, now, requireActive: false });
  await assertCoordinatorServiceLeaseOwnership(serviceLease);
  verifiedActiveSolverDaemonExecutionFence(executionFence);
  assertOriginalCoordinatorStore(store);
  const step = nextSolverDaemonStep({ store, settlementId });
  if (ACTIVE_NEW_EXPOSURE_STEPS.has(step.kind)) {
    try {
      verifiedActiveSolverDaemonContext(executionContext, {
        now,
        requireFundingAuthorization: true,
      });
      durableSettlementBinding({ store, settlementId, context: binding, now, requireActive: true });
    } catch (error) {
      return Object.freeze({
        settlementId: step.settlementId,
        stepKind: step.kind,
        outcome: "GATE_CLOSED",
        reason: String(error?.message ?? "solver daemon funding authorization is inactive"),
      });
    }
  }
  try {
    return await executeSolverDaemonStep({
      ...runtime,
      store,
      settlementId,
      expectedEvidencePolicyDigest: binding.evidencePolicyDigest,
      nowSeconds: () => Math.floor(Date.now() / 1_000),
      beforeSideEffect: async (boundary) => {
        verifiedActiveSolverDaemonExecutionFence(executionFence);
        await assertCoordinatorServiceLeaseOwnership(serviceLease);
        verifiedActiveSolverDaemonExecutionFence(executionFence);
        assertOriginalCoordinatorStore(store);
        durableSettlementBinding({
          store,
          settlementId,
          context: binding,
          now: Math.floor(Date.now() / 1_000),
          requireActive: false,
        });
        if (ACTIVE_NEW_EXPOSURE_STEPS.has(step.kind) && boundary.startsWith("lightning-dispatch-")) {
          const dispatchNow = Math.floor(Date.now() / 1_000);
          if (dispatchNow < now) {
            throw new ActiveFundingGateClosedError("active daemon clock moved backwards before dispatch");
          }
          try {
            verifiedActiveSolverDaemonContext(executionContext, {
              now: dispatchNow,
              requireFundingAuthorization: true,
            });
            durableSettlementBinding({
              store,
              settlementId,
              context: binding,
              now: dispatchNow,
              requireActive: true,
            });
          } catch (error) {
            throw new ActiveFundingGateClosedError(String(
              error?.message ?? "solver daemon funding authorization is inactive",
            ));
          }
        }
      },
    });
  } catch (error) {
    if (error instanceof ActiveFundingGateClosedError
        || error instanceof ActiveExecutionGateClosedError) {
      return Object.freeze({
        settlementId: step.settlementId,
        stepKind: step.kind,
        outcome: "GATE_CLOSED",
        reason: error.message,
      });
    }
    throw error;
  }
}

export async function executeRecoverySolverDaemonStep({
  executionContext,
  executionFence,
  serviceLease,
  store,
  settlementId,
  ...runtime
}) {
  if (Object.prototype.hasOwnProperty.call(runtime, "expectedEvidencePolicyDigest")) {
    throw new TypeError("recovery daemon evidence policy digest cannot be supplied by its caller");
  }
  if (Object.prototype.hasOwnProperty.call(runtime, "nowSeconds")) {
    throw new TypeError("recovery daemon execution time cannot be supplied by its caller");
  }
  if (Object.prototype.hasOwnProperty.call(runtime, "beforeSideEffect")) {
    throw new TypeError("recovery daemon leadership guard cannot be supplied by its caller");
  }
  verifiedRecoverySolverDaemonExecutionFence(executionFence);
  const now = Math.floor(Date.now() / 1_000);
  const binding = verifiedRecoverySolverDaemonContext(executionContext, {
    now,
    requireActive: false,
  });
  durableSettlementBinding({
    store,
    settlementId,
    context: binding,
    now,
    requireActive: false,
    requireContextCapacityEpoch: false,
  });
  await assertCoordinatorServiceLeaseOwnership(serviceLease);
  assertOriginalCoordinatorStore(store);
  const step = nextSolverDaemonStep({ store, settlementId });
  try {
    verifiedRecoverySolverDaemonContext(executionContext, { now, requireActive: true });
  } catch (error) {
    return Object.freeze({
      settlementId: step.settlementId,
      stepKind: step.kind,
      outcome: "GATE_CLOSED",
      reason: String(error?.message ?? "recovery daemon authorization is inactive"),
    });
  }
  if (RECOVERY_FORBIDDEN_STEPS.has(step.kind)) {
    return Object.freeze({
      settlementId: step.settlementId,
      stepKind: step.kind,
      outcome: "GATE_CLOSED",
      reason: "recovery-only daemon context cannot plan or dispatch a Lightning action or open new exposure",
    });
  }
  if (EVM_CLAIM_WORK_STEPS.has(step.kind) && binding.evmClaimWorkAllowed !== true) {
    return Object.freeze({
      settlementId: step.settlementId,
      stepKind: step.kind,
      outcome: "GATE_CLOSED",
      reason: "recovery-only daemon cannot prepare or dispatch an EVM claim while BIT is paused",
    });
  }
  try {
    return await executeSolverDaemonStep({
      ...runtime,
      store,
      settlementId,
      expectedEvidencePolicyDigest: binding.evidencePolicyDigest,
      nowSeconds: () => Math.floor(Date.now() / 1_000),
      beforeSideEffect: async () => {
        verifiedRecoverySolverDaemonExecutionFence(executionFence);
        await assertCoordinatorServiceLeaseOwnership(serviceLease);
        assertOriginalCoordinatorStore(store);
        const boundaryNow = Math.floor(Date.now() / 1_000);
        if (boundaryNow < now) {
          throw new RecoveryGateClosedError("recovery daemon clock moved backwards before a side effect");
        }
        try {
          verifiedRecoverySolverDaemonContext(executionContext, {
            now: boundaryNow,
            requireActive: true,
          });
          durableSettlementBinding({
            store,
            settlementId,
            context: binding,
            now: boundaryNow,
            requireActive: false,
            requireContextCapacityEpoch: false,
          });
        } catch (error) {
          throw new RecoveryGateClosedError(String(
            error?.message ?? "recovery daemon authorization is inactive",
          ));
        }
      },
    });
  } catch (error) {
    if (error instanceof RecoveryGateClosedError) {
      return Object.freeze({
        settlementId: step.settlementId,
        stepKind: step.kind,
        outcome: "GATE_CLOSED",
        reason: error.message,
      });
    }
    throw error;
  }
}
