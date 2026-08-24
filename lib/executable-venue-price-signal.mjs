import { getAddress, keccak256, toUtf8Bytes, verifyTypedData } from "ethers";

const verifiedVenueSignals = new WeakSet();

function exactKeys(value, expected, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${name} fields are not exact`);
  }
}

function integer(value, name) {
  try {
    return BigInt(value);
  } catch {
    throw new TypeError(`${name} must be an integer`);
  }
}

function positiveInteger(value, name) {
  const parsed = integer(value, name);
  if (parsed <= 0n) throw new RangeError(`${name} must be positive`);
  return parsed;
}

function bytes32(value, name) {
  const parsed = String(value ?? "").toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(parsed) || /^0x0{64}$/.test(parsed)) throw new TypeError(`${name} must be nonzero bytes32`);
  return parsed;
}

function safeId(value, name) {
  const parsed = String(value ?? "").toLowerCase();
  if (!/^[a-z0-9][a-z0-9._:-]{1,79}$/.test(parsed)) throw new TypeError(`${name} is invalid`);
  return parsed;
}

function canonical(value) {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function digest(value) {
  return keccak256(toUtf8Bytes(JSON.stringify(canonical(value))));
}

function unsignedObservation(observation) {
  const result = { ...observation };
  delete result.signature;
  return result;
}

function validateSourcePolicy(policy) {
  exactKeys(policy, [
    "chainId",
    "controlDomain",
    "maximumValiditySeconds",
    "operatorOrganization",
    "signer",
    "source",
    "venueId",
    "verifyingContract",
  ], "executable venue source policy");
  const chainId = positiveInteger(policy.chainId, "sourcePolicy.chainId");
  if (chainId > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("sourcePolicy.chainId is too large");
  const verifyingContract = getAddress(policy.verifyingContract);
  if (BigInt(verifyingContract) === 0n) throw new TypeError("sourcePolicy.verifyingContract must be nonzero");
  const signer = getAddress(policy.signer);
  if (BigInt(signer) === 0n) throw new TypeError("sourcePolicy.signer must be nonzero");
  const maximumValiditySeconds = positiveInteger(policy.maximumValiditySeconds, "sourcePolicy.maximumValiditySeconds");
  if (maximumValiditySeconds > 300n) throw new RangeError("sourcePolicy.maximumValiditySeconds exceeds five minutes");
  return Object.freeze({
    chainId,
    verifyingContract,
    signer,
    maximumValiditySeconds,
    source: safeId(policy.source, "sourcePolicy.source"),
    venueId: bytes32(policy.venueId, "sourcePolicy.venueId"),
    controlDomain: bytes32(policy.controlDomain, "sourcePolicy.controlDomain"),
    operatorOrganization: bytes32(policy.operatorOrganization, "sourcePolicy.operatorOrganization"),
  });
}

export function executableVenueObservationTypedData({ sourcePolicy, observation }) {
  const policy = validateSourcePolicy(sourcePolicy);
  const unsigned = unsignedObservation(observation);
  return Object.freeze({
    domain: Object.freeze({
      name: "TreeSwap Executable Venue Price",
      version: "1",
      chainId: Number(policy.chainId),
      verifyingContract: policy.verifyingContract,
    }),
    types: Object.freeze({
      PriceObservation: Object.freeze([
        Object.freeze({ name: "sourcePolicyDigest", type: "bytes32" }),
        Object.freeze({ name: "observationDigest", type: "bytes32" }),
      ]),
    }),
    value: Object.freeze({
      sourcePolicyDigest: digest(sourcePolicy),
      observationDigest: digest(unsigned),
    }),
  });
}

export function buildExecutableVenuePriceSignal({ sourcePolicy, observation }) {
  const policy = validateSourcePolicy(sourcePolicy);
  exactKeys(observation, [
    "direction",
    "executableDepthBitWei",
    "executableDepthSats",
    "observedAt",
    "priceMsatPerBit",
    "quoteCommitment",
    "signature",
    "source",
    "validUntil",
  ], "executable venue observation");
  const source = safeId(observation.source, "observation.source");
  if (source !== policy.source) throw new Error("executable venue source does not match policy");
  if (observation.direction !== "lightning-to-bit" && observation.direction !== "bit-to-lightning") {
    throw new Error("executable venue direction is invalid");
  }
  const observedAt = positiveInteger(observation.observedAt, "observation.observedAt");
  const validUntil = positiveInteger(observation.validUntil, "observation.validUntil");
  if (validUntil <= observedAt || validUntil - observedAt > policy.maximumValiditySeconds) {
    throw new Error("executable venue validity is unsafe");
  }
  const priceMsatPerBit = positiveInteger(observation.priceMsatPerBit, "observation.priceMsatPerBit");
  const executableDepthSats = positiveInteger(observation.executableDepthSats, "observation.executableDepthSats");
  const executableDepthBitWei = positiveInteger(observation.executableDepthBitWei, "observation.executableDepthBitWei");
  bytes32(observation.quoteCommitment, "observation.quoteCommitment");
  let recovered;
  try {
    const typedData = executableVenueObservationTypedData({ sourcePolicy, observation });
    recovered = verifyTypedData(typedData.domain, typedData.types, typedData.value, observation.signature);
  } catch {
    throw new Error("executable venue signature is invalid");
  }
  if (recovered.toLowerCase() !== policy.signer.toLowerCase()) {
    throw new Error("executable venue signature is not from the pinned signer");
  }
  const pricePolicyDigest = digest(sourcePolicy);
  const observationDigest = digest({
    sourcePolicyDigest: pricePolicyDigest,
    observation: unsignedObservation(observation),
    signatureDigest: keccak256(observation.signature),
  });
  const signal = Object.freeze({
    kind: "executable-venue",
    chainId: policy.chainId,
    source,
    venueId: policy.venueId,
    controlDomain: policy.controlDomain,
    operatorOrganization: policy.operatorOrganization,
    pricePolicyDigest,
    observationDigest,
    direction: observation.direction,
    observedAt,
    validUntil,
    priceMsatPerBit,
    executableDepthSats,
    executableDepthBitWei,
  });
  verifiedVenueSignals.add(signal);
  return signal;
}

export function isVerifiedExecutableVenuePriceSignal(value) {
  return Boolean(value && typeof value === "object" && verifiedVenueSignals.has(value));
}
