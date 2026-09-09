import { handleAccountMaintenanceObservation } from "../../lib/account-maintenance-observer.mjs";

// Deploy only as a private Service Binding, with workers.dev and preview URLs disabled.
const worker = { fetch: handleAccountMaintenanceObservation };
export default worker;
