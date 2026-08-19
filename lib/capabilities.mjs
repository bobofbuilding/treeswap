export const V1_CAPABILITIES = Object.freeze({
  publicLpDeposits: false,
  lpShares: false,
  promisedYield: false,
  publicOrderBook: false,
  makerRewards: false,
  partialFills: false,
  permissionlessSolvers: false,
  webSolverFunding: false,
  solverInventoryPlanner: true,
});

export function authorizeSolverFunding({ session, deployment, capabilities = V1_CAPABILITIES }) {
  const reasons = [];
  if (capabilities.webSolverFunding !== true) reasons.push("web solver funding is disabled");
  if (session?.authenticated !== true || session?.role !== "solver" || session?.admitted !== true) {
    reasons.push("an authenticated admitted solver is required");
  }
  if (deployment?.audited !== true || deployment?.testnetCampaignPassed !== true) {
    reasons.push("reviewed deployment evidence is required");
  }
  if (deployment?.openGateHealthy !== true || deployment?.balancesReconciled !== true) {
    reasons.push("risk gate and reconciled balances are required");
  }
  return Object.freeze({ allowed: reasons.length === 0, reasons });
}
