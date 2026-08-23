import { verifiedActiveSolverDaemonContext } from "./capabilities.mjs";
import { isVerifiedCoordinatorStore } from "./coordinator-store.mjs";
import { executeSolverDaemonStep } from "./solver-daemon-runtime.mjs";
import { nextSolverDaemonStep } from "./solver-daemon-planner.mjs";

const NEW_EXPOSURE_STEPS = new Set(["AUTHORIZE_AND_DISPATCH_LIGHTNING"]);
const BYTES32 = /^0x[0-9a-f]{64}$/;

function nonzeroDigest(value) {
  return BYTES32.test(String(value ?? "")) && !/^0x0{64}$/.test(value);
}

function durableSettlementBinding({ store, settlementId, context, now, requireActive }) {
  if (!isVerifiedCoordinatorStore(store)) {
    throw new TypeError("active daemon requires an original coordinator store with firm-offer provenance");
  }
  const settlement = store.getSettlement(settlementId);
  if (!settlement) throw new Error("active daemon settlement does not exist");
  const offer = store.getFirmOffer(settlement.selectedOfferId);
  if (!offer
      || offer.offerId !== settlement.selectedOfferId
      || offer.solverId !== context.solverId
      || offer.direction !== context.direction
      || offer.direction !== settlement.direction
      || offer.capacityEpoch !== context.capacityEpoch
      || offer.capacityEpoch !== settlement.capacityEpoch
      || offer.lightningAmountSats !== settlement.amountSats) {
    throw new Error("active daemon settlement is not bound to the authorized solver offer and capacity epoch");
  }
  if (!nonzeroDigest(offer.privateRequestDigest)
      || !nonzeroDigest(offer.executableOfferDigest)
      || !nonzeroDigest(offer.executionBindingDigest)
      || !nonzeroDigest(offer.executionAuthorizationDigest)
      || !Number.isSafeInteger(offer.finalizedAt)
      || !Number.isSafeInteger(offer.authorizedAt)
      || offer.finalizedAt > offer.authorizedAt) {
    throw new Error("active daemon settlement lacks a complete executable quote and user authorization");
  }
  if (requireActive) {
    const request = typeof store.getRfqRequest === "function" ? store.getRfqRequest(offer.requestId) : null;
    if (offer.state !== "ACTIVE" || !Number.isSafeInteger(offer.expiresAt) || offer.expiresAt <= now
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

export async function executeActiveSolverDaemonStep({
  executionContext,
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
  const now = Math.floor(Date.now() / 1_000);
  const binding = verifiedActiveSolverDaemonContext(executionContext, {
    now,
    requireFundingAuthorization: false,
  });
  durableSettlementBinding({ store, settlementId, context: binding, now, requireActive: false });
  const step = nextSolverDaemonStep({ store, settlementId });
  if (NEW_EXPOSURE_STEPS.has(step.kind)) {
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
  return executeSolverDaemonStep({
    ...runtime,
    store,
    settlementId,
    expectedEvidencePolicyDigest: binding.evidencePolicyDigest,
    nowSeconds: () => now,
  });
}
