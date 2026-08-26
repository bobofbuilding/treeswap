import { runScheduledAccountMaintenance } from "../../lib/scheduled-account-maintenance.mjs";

const FAILURE_LOG = JSON.stringify({
  schema: "treeswap.scheduled-account-maintenance-failure.v1",
  status: "failed-closed",
  accountEnablement: false,
  outboundDelivery: false,
  funding: false,
  releaseActivation: false,
});

const worker = {
  async scheduled(controller, env, _ctx) {
    void _ctx;
    try {
      await runScheduledAccountMaintenance(controller, env);
    } catch {
      console.error(FAILURE_LOG);
      throw new Error("scheduled account maintenance failed closed");
    }
  },
};

export default worker;
