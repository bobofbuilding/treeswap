import assert from "node:assert/strict";
import test from "node:test";
import { V1_CAPABILITIES, authorizeSolverFunding } from "../lib/capabilities.mjs";

test("opens cryptographic solver admission while keeping public execution and pooled products disabled", () => {
  assert.deepEqual(
    {
      publicLpDeposits: V1_CAPABILITIES.publicLpDeposits,
      lpShares: V1_CAPABILITIES.lpShares,
      promisedYield: V1_CAPABILITIES.promisedYield,
      makerRewards: V1_CAPABILITIES.makerRewards,
      partialFills: V1_CAPABILITIES.partialFills,
      openCryptographicSolverAdmission: V1_CAPABILITIES.openCryptographicSolverAdmission,
      publicPermissionlessExecution: V1_CAPABILITIES.publicPermissionlessExecution,
    },
    {
      publicLpDeposits: false,
      lpShares: false,
      promisedYield: false,
      makerRewards: false,
      partialFills: false,
      openCryptographicSolverAdmission: true,
      publicPermissionlessExecution: false,
    },
  );
});

test("cannot authorize web funding even with a nominal solver session", () => {
  const result = authorizeSolverFunding({
    session: { authenticated: true, role: "solver", capabilityVerified: true },
    deployment: { audited: true, testnetCampaignPassed: true, openGateHealthy: true, balancesReconciled: true },
  });
  assert.equal(result.allowed, false);
  assert.match(result.reasons.join("; "), /web solver funding is disabled/);
  assert.match(result.reasons.join("; "), /reviewed deployment evidence/);
});

test("denies a public user before any deployment condition matters", () => {
  const result = authorizeSolverFunding({ session: { authenticated: true, role: "user" }, deployment: {} });
  assert.equal(result.allowed, false);
  assert.match(result.reasons.join("; "), /verified capability/);
});
