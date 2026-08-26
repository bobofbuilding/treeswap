import {
  ContractIntentWalletAbuseStore,
} from "../../lib/contract-intent-wallet-abuse-store.mjs";
import {
  acquireContractIntentWalletEdgeReplicaFence,
} from "../../lib/contract-intent-wallet-edge-perimeter.mjs";

const [path, runtimeDirectory, sessionDigest] = process.argv.slice(2);
if (!path || !runtimeDirectory || !sessionDigest) {
  throw new Error("wallet edge abrupt-kill fixture requires storage, runtime, and session inputs");
}

const lifecycle = new AbortController();
const store = await ContractIntentWalletAbuseStore.open({
  allowMemory: false,
  initialize: false,
  path,
});
store.consume({
  now: 1_787_686_400,
  sessionDigest,
  sessionExpiresAt: 1_787_687_000,
});
const fence = await acquireContractIntentWalletEdgeReplicaFence({
  runtimeDirectory,
  signal: lifecycle.signal,
});
await fence.assertHeld();
if (store.status().activeWindows !== 1) throw new Error("wallet edge crash fixture did not commit");
process.stdout.write("READY\n");
setInterval(() => {}, 60_000);
