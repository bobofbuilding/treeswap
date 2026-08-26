import { runScheduledAccountStorageMonitor } from "../../lib/scheduled-account-storage-monitor.mjs";

const FAILURE_LOG = JSON.stringify({
  schema: "treeswap.scheduled-account-storage-monitor-failure.v1",
  status: "failed-closed",
  accountEnablement: false,
  accountDisable: false,
  outboundDelivery: false,
  walletDispatch: false,
  lightningDispatch: false,
  settlement: false,
  funding: false,
  releaseActivation: false,
});

const worker = {
  async scheduled(controller, env, _ctx) {
    void _ctx;
    try {
      await runScheduledAccountStorageMonitor(controller, env);
    } catch {
      console.error(FAILURE_LOG);
      throw new Error("scheduled account storage monitor failed closed");
    }
  },
};

export default worker;
