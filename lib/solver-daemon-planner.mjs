const BYTES32 = /^0x[0-9a-f]{64}$/;
const DIRECTIONS = new Set(["lightning-to-bit", "bit-to-lightning"]);
const ACTION_STATES = new Set(["PENDING", "DISPATCHING", "CONFIRMED", "FAILED", "UNKNOWN"]);
const SEND_PAYMENT = "/routerrpc.Router/SendPaymentV2";
const SETTLE_INVOICE = "/invoicesrpc.Invoices/SettleInvoice";
const EVM_CLAIM = "evm:claim";

function bytes32(value, name) {
  const raw = String(value ?? "");
  if (!BYTES32.test(raw)) throw new TypeError(`${name} must be lowercase bytes32`);
  return raw;
}

function step(kind, settlement, details = {}) {
  return Object.freeze({
    kind,
    settlementId: settlement.settlementId,
    direction: settlement.direction,
    ...details,
  });
}

function normalizeActions(settlement, actions) {
  if (!Array.isArray(actions)) throw new TypeError("settlement actions must be an array");
  const byMethod = new Map();
  for (const action of actions) {
    if (!action || typeof action !== "object" || Array.isArray(action)) throw new TypeError("settlement action is invalid");
    if (bytes32(action.settlementId, "action settlementId") !== settlement.settlementId) {
      throw new Error("settlement action belongs to another settlement");
    }
    bytes32(action.actionId, "actionId");
    if (!ACTION_STATES.has(action.state)) throw new Error("settlement action state is unsupported");
    if (byMethod.has(action.method)) throw new Error("settlement has duplicate action methods");
    byMethod.set(action.method, action);
  }
  return byMethod;
}

function unresolvedStep(settlement, actions) {
  const dispatching = actions.find((action) => action.state === "DISPATCHING");
  if (dispatching) {
    return step("RECOVER_INTERRUPTED_ACTION", settlement, {
      actionId: dispatching.actionId,
      method: dispatching.method,
      reason: "a claimed action has no durable result",
    });
  }
  const unknown = actions.find((action) => action.state === "UNKNOWN");
  if (settlement.reconciliationRequired || unknown) {
    if (!unknown) {
      return settlement.haltCode
        ? null
        : step("HALT_REQUIRED", settlement, { reason: "reconciliation is required without an unknown action" });
    }
    return step("RECONCILE_ACTION", settlement, {
      actionId: unknown.actionId,
      method: unknown.method,
      reason: "an ambiguous side effect must be observed before any next action",
    });
  }
  return null;
}

function directionMismatch(settlement, byMethod) {
  const allowed = settlement.direction === "bit-to-lightning"
    ? new Set([SEND_PAYMENT, EVM_CLAIM])
    : new Set([SETTLE_INVOICE]);
  return [...byMethod.keys()].some((method) => !allowed.has(method));
}

function paymentDirectionStep(settlement, byMethod) {
  const payment = byMethod.get(SEND_PAYMENT);
  const claim = byMethod.get(EVM_CLAIM);
  if (claim && payment?.state !== "CONFIRMED") {
    return step("HALT_REQUIRED", settlement, { reason: "EVM claim was planned before confirmed Lightning payment" });
  }
  if (!payment) return step("PLAN_LIGHTNING_ACTION", settlement, { method: SEND_PAYMENT });
  if (payment.state === "PENDING") {
    return step("AUTHORIZE_AND_DISPATCH_LIGHTNING", settlement, { actionId: payment.actionId, method: SEND_PAYMENT });
  }
  if (payment.state === "FAILED") {
    return step("VERIFY_REFUND_AND_RECONCILE", settlement, {
      actionId: payment.actionId,
      reason: "Lightning payment failed before an EVM claim",
    });
  }
  if (payment.state !== "CONFIRMED") {
    return step("HALT_REQUIRED", settlement, { reason: "Lightning payment state cannot advance" });
  }
  if (!claim) {
    return step("RECOVER_PAYMENT_PROOF_AND_PREPARE_EVM_CLAIM", settlement, {
      paymentActionId: payment.actionId,
      method: EVM_CLAIM,
    });
  }
  if (claim.state === "PENDING" && claim.evmTransactionBound === false) {
    return step("PREPARE_EVM_CLAIM_TRANSACTION", settlement, {
      actionId: claim.actionId,
      method: EVM_CLAIM,
      reason: "the EVM claim action was persisted before its signed transaction binding",
    });
  }
  if (claim.state === "PENDING") return step("DISPATCH_EVM_CLAIM", settlement, { actionId: claim.actionId, method: EVM_CLAIM });
  if (claim.state === "CONFIRMED") {
    return step("VERIFY_BOTH_ASSETS_AND_COMPLETE", settlement, { actionId: claim.actionId });
  }
  if (claim.state === "FAILED") {
    return step("HALT_REQUIRED", settlement, { reason: "Lightning paid but the bound EVM claim failed" });
  }
  return step("HALT_REQUIRED", settlement, { reason: "EVM claim state cannot advance" });
}

function invoiceDirectionStep(settlement, byMethod) {
  const settlementAction = byMethod.get(SETTLE_INVOICE);
  if (!settlementAction) return step("PLAN_LIGHTNING_ACTION", settlement, { method: SETTLE_INVOICE });
  if (settlementAction.state === "PENDING") {
    return step("AUTHORIZE_AND_DISPATCH_LIGHTNING", settlement, {
      actionId: settlementAction.actionId,
      method: SETTLE_INVOICE,
    });
  }
  if (settlementAction.state === "CONFIRMED") {
    return step("WAIT_FOR_BIT_CLAIM_AND_RECONCILE", settlement, {
      actionId: settlementAction.actionId,
      reason: "the beneficiary or any relayer must reveal the bound preimage to the EVM escrow",
    });
  }
  if (settlementAction.state === "FAILED") {
    return step("VERIFY_REFUND_AND_RECONCILE", settlement, {
      actionId: settlementAction.actionId,
      reason: "hold-invoice settlement did not complete",
    });
  }
  return step("HALT_REQUIRED", settlement, { reason: "hold-invoice action state cannot advance" });
}

export function classifySolverDaemonStep({ settlement, actions }) {
  if (!settlement || typeof settlement !== "object" || Array.isArray(settlement)) {
    throw new TypeError("settlement must be an object");
  }
  const normalizedSettlement = {
    ...settlement,
    settlementId: bytes32(settlement.settlementId, "settlementId"),
    direction: String(settlement.direction ?? ""),
  };
  if (!DIRECTIONS.has(normalizedSettlement.direction)) throw new Error("settlement direction is unsupported");
  const byMethod = normalizeActions(normalizedSettlement, actions);
  const orderedActions = [...byMethod.values()];

  if (normalizedSettlement.terminalState) return step("DONE", normalizedSettlement, { terminalState: normalizedSettlement.terminalState });
  const unresolved = unresolvedStep(normalizedSettlement, orderedActions);
  if (unresolved) return unresolved;
  if (normalizedSettlement.haltCode) return step("HALTED", normalizedSettlement, { haltCode: normalizedSettlement.haltCode });
  if (directionMismatch(normalizedSettlement, byMethod)) {
    return step("HALT_REQUIRED", normalizedSettlement, { reason: `${normalizedSettlement.direction} contains a direction-incompatible action` });
  }
  if (!normalizedSettlement.reservationId) return step("WAIT_FOR_RESERVATION", normalizedSettlement);
  return normalizedSettlement.direction === "bit-to-lightning"
    ? paymentDirectionStep(normalizedSettlement, byMethod)
    : invoiceDirectionStep(normalizedSettlement, byMethod);
}

export function nextSolverDaemonStep({ store, settlementId }) {
  if (!store || typeof store.getSettlement !== "function" || typeof store.listSettlementActions !== "function") {
    throw new TypeError("a coordinator store is required");
  }
  const id = bytes32(settlementId, "settlementId");
  const settlement = store.getSettlement(id);
  if (!settlement) throw new Error("settlement does not exist");
  const actions = store.listSettlementActions(id).map((action) => action.method === EVM_CLAIM
    ? Object.freeze({ ...action, evmTransactionBound: Boolean(store.getEvmTransaction?.(action.actionId)) })
    : action);
  return classifySolverDaemonStep({ settlement, actions });
}
