import { verifiedReleaseCapabilityBinding } from "./release-authorization.mjs";

export const V1_CAPABILITIES = Object.freeze({
  publicLpDeposits: false,
  lpShares: false,
  promisedYield: false,
  publicOrderBook: false,
  makerRewards: false,
  partialFills: false,
  openCryptographicSolverAdmission: true,
  publicPermissionlessExecution: false,
  webSolverFunding: false,
  solverInventoryPlanner: true,
});

function exactRuntimeSnapshot(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort().join("|");
  return keys === [
    "balancesReconciled",
    "deploymentManifestDigest",
    "deploymentPostflightDigest",
    "deploymentPromotionDigest",
    "gateOpen",
    "observedAt",
    "openGateRiskDigest",
    "reconciliationDigest",
    "releasePolicyDigest",
    "releaseRecordDigest",
  ].sort().join("|");
}

const NONZERO_BYTES32 = /^0x(?!0{64}$)[0-9a-f]{64}$/;

export function authorizeSolverFunding({
  session,
  deployment,
  capabilities = V1_CAPABILITIES,
  now = Math.floor(Date.now() / 1_000),
}) {
  const reasons = [];
  let release = null;
  if (capabilities === V1_CAPABILITIES) {
    reasons.push("web solver funding is disabled");
  } else {
    try {
      release = verifiedReleaseCapabilityBinding(capabilities);
    } catch {
      reasons.push("a cryptographically verified release capability is required");
    }
  }
  if (session?.authenticated !== true || session?.role !== "solver" || session?.capabilityVerified !== true) {
    reasons.push("an authenticated solver with a verified capability is required");
  }
  if (!Number.isSafeInteger(now) || now <= 0) reasons.push("authorization time is invalid");
  if (!release) {
    reasons.push("reviewed deployment evidence is required");
  } else {
    if (now < release.validFrom || now > release.validUntil) reasons.push("release authorization is not active");
    if (!exactRuntimeSnapshot(deployment)) {
      reasons.push("an exact runtime deployment snapshot is required");
    } else {
      if (deployment.releaseRecordDigest !== release.releaseRecordDigest
          || deployment.releasePolicyDigest !== release.releasePolicyDigest
          || deployment.deploymentManifestDigest !== release.deploymentManifestDigest
          || deployment.deploymentPostflightDigest !== release.deploymentPostflightDigest
          || deployment.deploymentPromotionDigest !== release.deploymentPromotionDigest) {
        reasons.push("runtime deployment is not bound to the authorized release");
      }
      if (!Number.isSafeInteger(deployment.observedAt) || deployment.observedAt > now
          || now - deployment.observedAt > release.maximumRuntimeObservationAgeSeconds) {
        reasons.push("runtime deployment observation is stale or invalid");
      }
      if (deployment.gateOpen !== true || deployment.balancesReconciled !== true
          || !NONZERO_BYTES32.test(String(deployment.openGateRiskDigest ?? ""))
          || !NONZERO_BYTES32.test(String(deployment.reconciliationDigest ?? ""))) {
        reasons.push("risk gate and reconciled balances are required");
      }
    }
  }
  return Object.freeze({ allowed: reasons.length === 0, reasons });
}
