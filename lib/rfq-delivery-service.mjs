import {
  RfqDeliveryError,
  claimRfqDeliveryClientOwnership,
  isProductionRfqDeliveryClient,
  isRfqDeliveryClient,
  rfqDeliveryClientLifecycleState,
  rfqDeliveryClientTransportMode,
} from "./rfq-delivery.mjs";

const SERVICE_INPUT_FIELDS = Object.freeze(["client", "signal"]);
const COLLECTION_CALL_FIELDS = Object.freeze(["requestDigest", "requestId", "rfq", "signal"]);
const SERVICES = new WeakMap();
const BOUND_CLIENTS = new WeakSet();

function exactDataRecord(value, expected, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${name} must be a plain data object`);
  }
  const keys = Reflect.ownKeys(value);
  const wanted = [...expected].sort();
  if (keys.some((key) => typeof key !== "string")) {
    throw new TypeError(`${name} fields are not exact data properties`);
  }
  const actual = [...keys].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${name} fields are not exact`);
  }
  const result = Object.create(null);
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value") || descriptor.enumerable !== true) {
      throw new TypeError(`${name} fields must be enumerable data properties`);
    }
    result[key] = descriptor.value;
  }
  return Object.freeze(result);
}

function abortSignal(value, name) {
  if (!(value instanceof AbortSignal)) throw new TypeError(`${name} must be an AbortSignal`);
  return value;
}

function stoppedError() {
  return new RfqDeliveryError("RFQ delivery service is stopped", { code: "SERVICE_STOPPED" });
}

function buildStatus(context) {
  const settled = context.completed + context.cancelled + context.failed;
  if (context.started !== settled + context.inFlight) {
    throw new Error("RFQ delivery service counters are inconsistent");
  }
  return Object.freeze({
    schema: "treeswap.rfq-delivery-service-status.v1",
    state: context.state,
    transportMode: context.transportMode,
    requestsStarted: context.started,
    requestsCompleted: context.completed,
    requestsCancelled: context.cancelled,
    requestsFailed: context.failed,
    requestsInFlight: context.inFlight,
    fundingAuthorization: false,
    settlementAuthorization: false,
    networkListener: false,
  });
}

function createService(input, expectedMode) {
  const source = exactDataRecord(input, SERVICE_INPUT_FIELDS, "RFQ delivery service input");
  const deploymentSignal = abortSignal(source.signal, "RFQ delivery service signal");
  if (deploymentSignal.aborted) throw stoppedError();
  if (!isRfqDeliveryClient(source.client)) {
    throw new TypeError("RFQ delivery service requires a factory-created client");
  }
  const transportMode = rfqDeliveryClientTransportMode(source.client);
  if (expectedMode === "fixed-public-node-https" && !isProductionRfqDeliveryClient(source.client)) {
    throw new TypeError("production RFQ delivery service requires the fixed public Node HTTPS client");
  }
  if (transportMode !== expectedMode) {
    throw new TypeError("RFQ delivery service client mode is invalid");
  }
  const clientState = rfqDeliveryClientLifecycleState(source.client);
  if (clientState === "closed") {
    throw new TypeError("RFQ delivery service client is already closed");
  }
  if (clientState === "owned" || BOUND_CLIENTS.has(source.client)) {
    throw new TypeError("RFQ delivery client is already owned by a service");
  }

  const lifecycle = new AbortController();
  const clientLease = claimRfqDeliveryClientOwnership(source.client);
  const context = {
    client: source.client,
    clientLease,
    lifecycle,
    deploymentSignal,
    state: "active",
    transportMode,
    started: 0,
    completed: 0,
    cancelled: 0,
    failed: 0,
    inFlight: 0,
    abortListener: null,
  };

  const synchronizeLifecycle = () => {
    if (context.state === "active" && rfqDeliveryClientLifecycleState(context.client) === "closed") {
      context.state = "stopped";
      lifecycle.abort();
      deploymentSignal.removeEventListener("abort", context.abortListener);
    }
  };

  const stopService = () => {
    if (context.state === "stopped") return;
    context.state = "stopped";
    lifecycle.abort();
    context.clientLease.close();
    deploymentSignal.removeEventListener("abort", context.abortListener);
  };

  const service = Object.freeze({
    async collect(rawCall) {
      if (this !== service || SERVICES.get(this) !== context) {
        throw new TypeError("RFQ delivery service lacks factory provenance");
      }
      synchronizeLifecycle();
      if (context.state !== "active") throw stoppedError();
      const call = exactDataRecord(rawCall, COLLECTION_CALL_FIELDS, "RFQ delivery service call");
      const callSignal = abortSignal(call.signal, "RFQ delivery service call signal");
      context.started += 1;
      context.inFlight += 1;
      try {
        const collection = await context.clientLease.collect({
          requestDigest: call.requestDigest,
          requestId: call.requestId,
          rfq: call.rfq,
          signal: AbortSignal.any([lifecycle.signal, callSignal]),
        });
        context.completed += 1;
        return collection;
      } catch (error) {
        if (error instanceof RfqDeliveryError
            && (error.code === "CANCELLED" || error.code === "CLIENT_CLOSED")) {
          context.cancelled += 1;
        } else {
          context.failed += 1;
        }
        throw error;
      } finally {
        context.inFlight -= 1;
        synchronizeLifecycle();
      }
    },
    status() {
      if (this !== service || SERVICES.get(this) !== context) {
        throw new TypeError("RFQ delivery service lacks factory provenance");
      }
      synchronizeLifecycle();
      return buildStatus(context);
    },
    stop() {
      if (this !== service || SERVICES.get(this) !== context) {
        throw new TypeError("RFQ delivery service lacks factory provenance");
      }
      stopService();
      return buildStatus(context);
    },
  });

  context.abortListener = stopService;
  deploymentSignal.addEventListener("abort", context.abortListener, { once: true });
  BOUND_CLIENTS.add(source.client);
  SERVICES.set(service, context);
  return service;
}

export function startRfqDeliveryService(input) {
  return createService(input, "fixed-public-node-https");
}

export function startTestRfqDeliveryService(input) {
  return createService(input, "injected-test");
}

export function isRfqDeliveryService(value) {
  return Boolean(value && SERVICES.has(value));
}

export function isProductionRfqDeliveryService(value) {
  return SERVICES.get(value)?.transportMode === "fixed-public-node-https";
}
