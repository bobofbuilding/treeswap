export const COORDINATOR_RECOVERY_JOB_SCHEMA =
  "treeswap.coordinator-recovery-job.v1";

const BYTES32 = /^0x(?!0{64}$)[0-9a-f]{64}$/;
const JOB_KEYS = Object.freeze([
  "evidencePolicy",
  "runtime",
  "settlementId",
  "solverCapabilityVerification",
]);
const RUNTIME_KEYS = Object.freeze(["controls", "evm", "lightning", "packetClient"]);
const RECOVERY_CONTROL_KEYS = new Set(["authorizeEvmClaim", "observeReservation", "verifyAssets"]);
const ACTIVE_CONTROL_KEYS = new Set([
  "authorizeEvmClaim",
  "authorizeLightning",
  "observeReservation",
  "verifyAssets",
]);

function exactKeys(value, expected, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${name} fields are not exact`);
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function snapshotCoordinatorEvidencePolicy(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} evidence policy must be an object`);
  }
  return deepFreeze(structuredClone(value));
}

export function snapshotCoordinatorRecoveryEvidencePolicy(value) {
  return snapshotCoordinatorEvidencePolicy(value, "recovery");
}

export function snapshotCoordinatorActiveEvidencePolicy(value) {
  return snapshotCoordinatorEvidencePolicy(value, "active");
}

function snapshotControls(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} action controls must be an object`);
  }
  const controls = {};
  for (const [name, implementation] of Object.entries(value)) {
    if (!allowed.has(name)) throw new TypeError(`${label} action control is not permitted`);
    if (typeof implementation !== "function") throw new TypeError(`${label} action control must be a function`);
    controls[name] = (...args) => implementation.apply(value, args);
  }
  return Object.freeze(controls);
}

function snapshotPacketClient(value, label) {
  if (value === null) return null;
  if (!value || typeof value !== "object" || typeof value.read !== "function") {
    throw new TypeError(`${label} private packet client is invalid`);
  }
  const read = value.read;
  return Object.freeze({ read: (...args) => read.apply(value, args) });
}

function snapshotSigner(value, name) {
  if (!value || typeof value !== "object"
      || typeof value.getAddress !== "function"
      || typeof value.signTransaction !== "function") {
    throw new TypeError(`${name} signer is invalid`);
  }
  const getAddress = value.getAddress;
  const signTransaction = value.signTransaction;
  return Object.freeze({
    getAddress: (...args) => getAddress.apply(value, args),
    signTransaction: (...args) => signTransaction.apply(value, args),
  });
}

function snapshotConfigValue(value, name, copies) {
  if (value === null || value === undefined
      || typeof value === "string" || typeof value === "number"
      || typeof value === "bigint" || typeof value === "boolean") return value;
  if (typeof value === "function") return (...args) => value(...args);
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) return Uint8Array.from(value);
  if (Array.isArray(value)) {
    if (copies.has(value)) return copies.get(value);
    const result = [];
    copies.set(value, result);
    for (let index = 0; index < value.length; index += 1) {
      result.push(snapshotConfigValue(value[index], `${name}[${index}]`, copies));
    }
    return Object.freeze(result);
  }
  if (Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null) {
    throw new TypeError(`${name} contains an unsupported mutable runtime object`);
  }
  if (copies.has(value)) return copies.get(value);
  const result = {};
  copies.set(value, result);
  for (const [key, child] of Object.entries(value)) {
    if (key === "__proto__") throw new TypeError(`${name} contains a forbidden prototype key`);
    if (typeof child === "function") {
      const implementation = child;
      Object.defineProperty(result, key, {
        configurable: false,
        enumerable: true,
        writable: false,
        value: (...args) => implementation.apply(value, args),
      });
    } else {
      Object.defineProperty(result, key, {
        configurable: false,
        enumerable: true,
        writable: false,
        value: snapshotConfigValue(child, `${name}.${key}`, copies),
      });
    }
  }
  return Object.freeze(result);
}

function snapshotCoordinatorRuntime(value, { controlKeys, label }) {
  exactKeys(value, RUNTIME_KEYS, `${label} action runtime`);
  const copyConfig = (config, name) => {
    if (config === null) return null;
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      throw new TypeError(`${name} must be an object or null`);
    }
    const copy = {};
    const copies = new WeakMap();
    for (const [key, child] of Object.entries(config)) {
      if (key === "__proto__") throw new TypeError(`${name} contains a forbidden prototype key`);
      let copied;
      if (key === "signer") copied = snapshotSigner(child, name);
      else if (key === "privateKey" && child && typeof child === "object"
          && !Buffer.isBuffer(child) && !(child instanceof Uint8Array)) {
        // Node KeyObject/CryptoKey instances are opaque, immutable key handles.
        copied = child;
      } else if (typeof child === "function") {
        const implementation = child;
        copied = (...args) => implementation.apply(config, args);
      } else {
        copied = snapshotConfigValue(child, `${name}.${key}`, copies);
      }
      Object.defineProperty(copy, key, {
        configurable: false,
        enumerable: true,
        writable: false,
        value: copied,
      });
    }
    return Object.freeze(copy);
  };
  return Object.freeze({
    packetClient: snapshotPacketClient(value.packetClient, label),
    controls: snapshotControls(value.controls, controlKeys, label),
    lightning: copyConfig(value.lightning, `${label} Lightning configuration`),
    evm: copyConfig(value.evm, `${label} EVM configuration`),
  });
}

export function snapshotCoordinatorRecoveryRuntime(value) {
  return snapshotCoordinatorRuntime(value, {
    controlKeys: RECOVERY_CONTROL_KEYS,
    label: "recovery",
  });
}

export function snapshotCoordinatorActiveRuntime(value) {
  return snapshotCoordinatorRuntime(value, {
    controlKeys: ACTIVE_CONTROL_KEYS,
    label: "active",
  });
}

export function normalizeCoordinatorRecoveryJobs(jobs) {
  if (!Array.isArray(jobs) || jobs.length === 0 || jobs.length > 64) {
    throw new RangeError("recovery action jobs must contain between 1 and 64 settlements");
  }
  const seen = new Set();
  return Object.freeze(jobs.map((job) => {
    exactKeys(job, JOB_KEYS, "recovery action job");
    const settlementId = String(job.settlementId ?? "");
    if (!BYTES32.test(settlementId)) {
      throw new TypeError("recovery action settlementId must be nonzero lowercase bytes32");
    }
    if (seen.has(settlementId)) throw new Error("recovery action settlementId is duplicated");
    seen.add(settlementId);
    if (!job.solverCapabilityVerification || typeof job.solverCapabilityVerification !== "object") {
      throw new TypeError("recovery solver capability verification is required");
    }
    return Object.freeze({
      settlementId,
      solverCapabilityVerification: job.solverCapabilityVerification,
      evidencePolicy: snapshotCoordinatorRecoveryEvidencePolicy(job.evidencePolicy),
      runtime: snapshotCoordinatorRecoveryRuntime(job.runtime),
    });
  }));
}
