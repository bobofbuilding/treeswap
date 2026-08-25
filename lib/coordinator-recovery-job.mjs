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
const CONTROL_KEYS = new Set(["authorizeEvmClaim", "observeReservation", "verifyAssets"]);

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

export function snapshotCoordinatorRecoveryEvidencePolicy(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("recovery evidence policy must be an object");
  }
  return deepFreeze(structuredClone(value));
}

function snapshotControls(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("recovery action controls must be an object");
  }
  const controls = {};
  for (const [name, implementation] of Object.entries(value)) {
    if (!CONTROL_KEYS.has(name)) throw new TypeError("recovery action control is not permitted");
    if (typeof implementation !== "function") throw new TypeError("recovery action control must be a function");
    controls[name] = (...args) => implementation.apply(value, args);
  }
  return Object.freeze(controls);
}

function snapshotPacketClient(value) {
  if (value === null) return null;
  if (!value || typeof value !== "object" || typeof value.read !== "function") {
    throw new TypeError("recovery private packet client is invalid");
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
    if (typeof child === "function") {
      const implementation = child;
      result[key] = (...args) => implementation.apply(value, args);
    } else {
      result[key] = snapshotConfigValue(child, `${name}.${key}`, copies);
    }
  }
  return Object.freeze(result);
}

export function snapshotCoordinatorRecoveryRuntime(value) {
  exactKeys(value, RUNTIME_KEYS, "recovery action runtime");
  const copyConfig = (config, name) => {
    if (config === null) return null;
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      throw new TypeError(`${name} must be an object or null`);
    }
    const copy = {};
    const copies = new WeakMap();
    for (const [key, child] of Object.entries(config)) {
      if (key === "signer") copy.signer = snapshotSigner(child, name);
      else if (key === "privateKey" && child && typeof child === "object"
          && !Buffer.isBuffer(child) && !(child instanceof Uint8Array)) {
        // Node KeyObject/CryptoKey instances are opaque, immutable key handles.
        copy.privateKey = child;
      } else if (typeof child === "function") {
        const implementation = child;
        copy[key] = (...args) => implementation.apply(config, args);
      } else {
        copy[key] = snapshotConfigValue(child, `${name}.${key}`, copies);
      }
    }
    return Object.freeze(copy);
  };
  return Object.freeze({
    packetClient: snapshotPacketClient(value.packetClient),
    controls: snapshotControls(value.controls),
    lightning: copyConfig(value.lightning, "recovery Lightning configuration"),
    evm: copyConfig(value.evm, "recovery EVM configuration"),
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
