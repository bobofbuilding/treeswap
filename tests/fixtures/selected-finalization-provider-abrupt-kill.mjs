import { SelectedSolverFinalizationProviderStore } from "../../lib/selected-solver-finalization-provider.mjs";

const path = process.argv[2];
const store = await SelectedSolverFinalizationProviderStore.open({
  path,
  allowMemory: false,
  initialize: false,
  maximumLiveRequests: 8,
});

store.begin({
  requestId: `0x${"11".repeat(32)}`,
  requestDigest: `0x${"22".repeat(32)}`,
  requesterPublicKeyDigest: `0x${"33".repeat(32)}`,
  capabilityDigest: `0x${"44".repeat(32)}`,
  solverId: "0x5555555555555555555555555555555555555555",
  direction: "lightning-to-bit",
  expiresAt: 1_015,
  now: 1_000,
  leaseSeconds: 2,
});

process.stdout.write("CLAIMED\n");
setInterval(() => {}, 60_000);
