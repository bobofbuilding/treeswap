import {
  CoordinatorStore,
  isVerifiedCoordinatorStore,
} from "./coordinator-store.mjs";

const DATE_NOW = Date.now.bind(Date);
const POLICIES = new WeakMap();
const BOUND_STORES = new WeakSet();
const ORIGINAL_RECONCILE = CoordinatorStore.prototype.reconcileRfqFinalizationRestart;
const INPUT_FIELDS = Object.freeze(["coordinatorStore", "limit", "signal"]);
const TEST_INPUT_FIELDS = Object.freeze([...INPUT_FIELDS, "nowSeconds"]);

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

function positiveInteger(value, name, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new TypeError(`${name} must be a positive safe integer at or below ${maximum}`);
  }
  return value;
}

function assertStore(store, mode) {
  if (!isVerifiedCoordinatorStore(store) || !(store instanceof CoordinatorStore)
      || CoordinatorStore.prototype.reconcileRfqFinalizationRestart !== ORIGINAL_RECONCILE
      || store.reconcileRfqFinalizationRestart !== ORIGINAL_RECONCILE) {
    throw new TypeError("RFQ finalization restart policy requires an unmodified factory-opened coordinator store");
  }
  if (mode === "production" && store.path === ":memory:") {
    throw new TypeError("production RFQ finalization restart policy requires durable coordinator storage");
  }
  if (BOUND_STORES.has(store)) {
    throw new TypeError("coordinator store already has an RFQ finalization restart owner");
  }
  return store;
}

function createPolicy(input, mode, nowSeconds) {
  const source = exactDataRecord(input, INPUT_FIELDS, "RFQ finalization restart policy input");
  const store = assertStore(source.coordinatorStore, mode);
  const limit = positiveInteger(source.limit, "RFQ finalization restart sweep limit", 1_000);
  if (!(source.signal instanceof AbortSignal) || source.signal.aborted) {
    throw new TypeError("RFQ finalization restart policy requires an active deployment AbortSignal");
  }
  const observeNow = () => positiveInteger(
    nowSeconds(),
    "RFQ finalization restart policy time",
  );
  let state = "active";
  let sweeps = 0;
  let lastReconciliation = ORIGINAL_RECONCILE.call(store, {
    limit,
    observedAt: observeNow(),
  });
  sweeps += 1;
  BOUND_STORES.add(store);

  const stop = () => {
    if (state === "stopped") return;
    state = "stopped";
    source.signal.removeEventListener("abort", stop);
  };
  source.signal.addEventListener("abort", stop, { once: true });

  const policy = Object.freeze({
    sweep() {
      if (this !== policy || !POLICIES.has(this)) {
        throw new TypeError("RFQ finalization restart policy lacks factory provenance");
      }
      if (state !== "active" || source.signal.aborted) {
        throw new Error("RFQ finalization restart policy is stopped");
      }
      lastReconciliation = ORIGINAL_RECONCILE.call(store, {
        limit,
        observedAt: observeNow(),
      });
      sweeps += 1;
      return lastReconciliation;
    },
    status() {
      if (this !== policy || !POLICIES.has(this)) {
        throw new TypeError("RFQ finalization restart policy lacks factory provenance");
      }
      return Object.freeze({
        schema: "treeswap.rfq-finalization-restart-policy-status.v1",
        state,
        mode,
        sweeps,
        reconciliation: lastReconciliation,
        browserAuthorityRestored: false,
        privateRequestRecovered: false,
        invoiceCreationAuthority: false,
        fundingAuthorization: false,
        newExposureAuthorization: false,
        settlementDispatchAuthority: false,
        networkListener: false,
      });
    },
    stop() {
      if (this !== policy || !POLICIES.has(this)) {
        throw new TypeError("RFQ finalization restart policy lacks factory provenance");
      }
      stop();
      return this.status();
    },
  });
  POLICIES.set(policy, Object.freeze({ mode, signal: source.signal, store }));
  return policy;
}

export function createRfqFinalizationRestartPolicy(input) {
  return createPolicy(input, "production", () => Math.floor(DATE_NOW() / 1_000));
}

export function createTestRfqFinalizationRestartPolicy(input) {
  const source = exactDataRecord(
    input,
    TEST_INPUT_FIELDS,
    "test RFQ finalization restart policy input",
  );
  if (typeof source.nowSeconds !== "function") {
    throw new TypeError("test RFQ finalization restart policy requires an injected clock");
  }
  return createPolicy(Object.freeze({
    coordinatorStore: source.coordinatorStore,
    limit: source.limit,
    signal: source.signal,
  }), "injected-test", source.nowSeconds);
}

export function isRfqFinalizationRestartPolicy(value) {
  return POLICIES.has(value);
}

export function rfqFinalizationRestartPolicyMode(value) {
  const context = POLICIES.get(value);
  if (!context) throw new TypeError("RFQ finalization restart policy lacks factory provenance");
  return context.mode;
}
