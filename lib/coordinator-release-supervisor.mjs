import {
  deactivatePublicTestnetRelease,
  isPublicTestnetReleaseActive,
} from "./capabilities.mjs";
import {
  activatePublicTestnetReleaseFromManifest,
  buildPublicTestnetReleaseActivationPreflightSummary,
} from "./public-testnet-release-activation.mjs";

export const COORDINATOR_RELEASE_VERIFICATION_SCHEMA =
  "treeswap.coordinator-release-verification.v1";

const AUTHORIZATIONS = Object.freeze({
  signing: false,
  broadcast: false,
  gateOpening: false,
  dispatch: false,
  funding: false,
});

function timestamp(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive safe integer`);
  return value;
}

function wholeSecondIso(seconds) {
  return new Date(seconds * 1_000).toISOString();
}

function inactiveVerification({ lastAttemptAt, lastSuccessAt, consecutiveFailures }) {
  return Object.freeze({
    schema: COORDINATOR_RELEASE_VERIFICATION_SCHEMA,
    state: "inactive",
    scope: "verification-only-no-listener-solver-context-dispatch-or-funding-authority",
    lastAttemptAt,
    lastSuccessAt,
    consecutiveFailures,
    releaseId: null,
    fundingMode: null,
    validUntil: null,
    recordDigest: null,
    policyDigest: null,
    inputManifestDigest: null,
    approvalBundleDigest: null,
    reconciliationDigest: null,
    providerConsensusDigest: null,
    runtimeBlockNumber: null,
    runtimeBlockHash: null,
    authorizations: AUTHORIZATIONS,
  });
}

function activeVerification({ summary, lastAttemptAt, lastSuccessAt }) {
  return Object.freeze({
    schema: COORDINATOR_RELEASE_VERIFICATION_SCHEMA,
    state: "active",
    scope: "verification-only-no-listener-solver-context-dispatch-or-funding-authority",
    lastAttemptAt,
    lastSuccessAt,
    consecutiveFailures: 0,
    releaseId: summary.releaseId,
    fundingMode: summary.fundingMode,
    validUntil: summary.validUntil,
    recordDigest: summary.recordDigest,
    policyDigest: summary.policyDigest,
    inputManifestDigest: summary.inputManifestDigest,
    approvalBundleDigest: summary.approvalBundleDigest,
    reconciliationDigest: summary.reconciliationDigest,
    providerConsensusDigest: summary.providerConsensusDigest,
    runtimeBlockNumber: summary.runtimeBlockNumber,
    runtimeBlockHash: summary.runtimeBlockHash,
    authorizations: AUTHORIZATIONS,
  });
}

export function createCoordinatorReleaseVerificationSupervisor({
  manifestPath,
  environment = process.env,
  fetchImpl = globalThis.fetch,
  timeoutMs = 10_000,
  activate = activatePublicTestnetReleaseFromManifest,
  deactivate = deactivatePublicTestnetRelease,
  isActive = isPublicTestnetReleaseActive,
} = {}) {
  if (typeof manifestPath !== "string" || manifestPath.length === 0) {
    throw new TypeError("coordinator release activation manifest path is required");
  }
  if (typeof activate !== "function" || typeof deactivate !== "function" || typeof isActive !== "function") {
    throw new TypeError("coordinator release activation dependencies are invalid");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000) {
    throw new RangeError("coordinator release provider timeout is outside policy");
  }

  let current = null;
  let summary = null;
  let lastAttemptAt = null;
  let lastSuccessAt = null;
  let lastObservedAt = null;
  let consecutiveFailures = 0;
  let refreshing = false;
  let stopped = false;

  function deactivateCurrent() {
    if (!current) return false;
    const activation = current.activation;
    current = null;
    summary = null;
    deactivate(activation);
    return true;
  }

  function rejectExternallyDeactivatedCurrent() {
    if (!current || isActive(current.activation)) return false;
    current = null;
    summary = null;
    consecutiveFailures += 1;
    return true;
  }

  function observeTime(now, { countFailure = true } = {}) {
    const observedAt = timestamp(now, "coordinator release verification time");
    if (lastObservedAt !== null && observedAt < lastObservedAt) {
      const highWaterAt = lastObservedAt;
      deactivateCurrent();
      if (countFailure) consecutiveFailures += 1;
      lastAttemptAt = wholeSecondIso(highWaterAt);
      return Object.freeze({ observedAt, regressed: true });
    }
    lastObservedAt = observedAt;
    return Object.freeze({ observedAt, regressed: false });
  }

  function status({ now = Math.floor(Date.now() / 1_000) } = {}) {
    const time = observeTime(now);
    if (time.regressed) {
      return inactiveVerification({ lastAttemptAt, lastSuccessAt, consecutiveFailures });
    }
    rejectExternallyDeactivatedCurrent();
    if (summary && time.observedAt > summary.validUntil) {
      deactivateCurrent();
    }
    if (!current || !summary) {
      return inactiveVerification({ lastAttemptAt, lastSuccessAt, consecutiveFailures });
    }
    return activeVerification({ summary, lastAttemptAt, lastSuccessAt });
  }

  async function refresh({ now = Math.floor(Date.now() / 1_000) } = {}) {
    if (stopped) throw new Error("coordinator release verification supervisor is stopped");
    if (refreshing) throw new Error("coordinator release verification refresh is already running");
    refreshing = true;
    try {
      const time = observeTime(now, { countFailure: false });
      lastAttemptAt = wholeSecondIso(time.observedAt);
      deactivateCurrent();
      if (time.regressed) {
        consecutiveFailures += 1;
        return inactiveVerification({ lastAttemptAt, lastSuccessAt, consecutiveFailures });
      }
      let result = null;
      try {
        result = await activate({
          manifestPath,
          environment,
          fetchImpl,
          now: time.observedAt,
          timeoutMs,
        });
        if (stopped) {
          deactivate(result.activation);
          return inactiveVerification({ lastAttemptAt, lastSuccessAt, consecutiveFailures });
        }
        if (!isActive(result.activation)) {
          throw new Error("coordinator release verification result is not an active same-process release");
        }
        const nextSummary = buildPublicTestnetReleaseActivationPreflightSummary(result);
        if (nextSummary.validUntil < time.observedAt) {
          deactivate(result.activation);
          throw new Error("coordinator release verification result is already expired");
        }
        current = result;
        result = null;
        summary = nextSummary;
        lastSuccessAt = lastAttemptAt;
        consecutiveFailures = 0;
        return activeVerification({ summary, lastAttemptAt, lastSuccessAt });
      } catch {
        if (result?.activation) {
          try {
            deactivate(result.activation);
          } catch {
            // The non-authorizing status remains inactive even when an injected test dependency is malformed.
          }
        }
        consecutiveFailures += 1;
        return inactiveVerification({ lastAttemptAt, lastSuccessAt, consecutiveFailures });
      }
    } finally {
      refreshing = false;
    }
  }

  function useActiveActivation(callback, { now = Math.floor(Date.now() / 1_000) } = {}) {
    if (typeof callback !== "function") throw new TypeError("active release callback is required");
    const verification = status({ now });
    if (verification.state !== "active" || !current) {
      throw new Error("coordinator release verification is not active");
    }
    return callback(current);
  }

  function stop() {
    if (stopped) return false;
    stopped = true;
    deactivateCurrent();
    return true;
  }

  return Object.freeze({ refresh, status, stop, useActiveActivation });
}
