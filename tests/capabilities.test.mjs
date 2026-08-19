import assert from "node:assert/strict";
import test from "node:test";
import { V1_CAPABILITIES, authorizeSolverFunding } from "../lib/capabilities.mjs";

test("keeps public liquidity, shares, rewards, yield, and partial fills disabled", () => {
  assert.deepEqual(
    {
      publicLpDeposits: V1_CAPABILITIES.publicLpDeposits,
      lpShares: V1_CAPABILITIES.lpShares,
      promisedYield: V1_CAPABILITIES.promisedYield,
      makerRewards: V1_CAPABILITIES.makerRewards,
      partialFills: V1_CAPABILITIES.partialFills,
      permissionlessSolvers: V1_CAPABILITIES.permissionlessSolvers,
    },
    {
      publicLpDeposits: false,
      lpShares: false,
      promisedYield: false,
      makerRewards: false,
      partialFills: false,
      permissionlessSolvers: false,
    },
  );
});

test("cannot authorize web funding even with a nominal solver session", () => {
  const result = authorizeSolverFunding({
    session: { authenticated: true, role: "solver", admitted: true },
    deployment: { audited: true, testnetCampaignPassed: true, openGateHealthy: true, balancesReconciled: true },
  });
  assert.equal(result.allowed, false);
  assert.match(result.reasons.join("; "), /web solver funding is disabled/);
});

test("denies a public user before any deployment condition matters", () => {
  const result = authorizeSolverFunding({ session: { authenticated: true, role: "user" }, deployment: {} });
  assert.equal(result.allowed, false);
  assert.match(result.reasons.join("; "), /admitted solver/);
});
