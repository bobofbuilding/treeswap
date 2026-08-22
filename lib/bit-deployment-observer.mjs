import {
  Interface,
  ZeroAddress,
  getAddress,
  isHexString,
  keccak256,
  toUtf8Bytes,
} from "ethers";

export const BIT_MAINNET_CONTRACT = "0x57A447E4d5e18A9423408C365963A73F08B9d18C";
export const EIP1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

const BIT_INTERFACE = new Interface([
  "function decimals() view returns (uint8)",
  "function paused() view returns (bool)",
  "function symbol() view returns (string)",
]);
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const LOWER_BYTES32 = /^0x[0-9a-f]{64}$/;
const GIT_COMMIT = /^[0-9a-f]{40}$/;
const HEX_QUANTITY = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/;
const DECIMAL_QUANTITY = /^(?:0|[1-9][0-9]*)$/;
const PROVIDER_LABEL = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}$/;
const ZERO_BYTES32 = `0x${"00".repeat(32)}`;

export const BIT_DEPLOYMENT_OBSERVATION_SCHEMA = "treeswap.bit-deployment-observation.v3";
export const BIT_DEPLOYMENT_COMPARISON_SCHEMA = "treeswap.bit-deployment-comparison.v2";
export const TREESWAP_CANONICAL_ORIGIN = "https://github.com/bobofbuilding/treeswap.git";
export const BIT_OBSERVATION_MAXIMUM_AGE_SECONDS = 3_600;
export const BIT_OBSERVATION_MAXIMUM_CLOCK_SKEW_SECONDS = 60;
export const BIT_OBSERVATION_MAXIMUM_PROVIDER_SKEW_SECONDS = 1_800;

const OBSERVATION_FIELDS = Object.freeze([
  "chainId",
  "evidenceStatus",
  "finalizedBlock",
  "implementation",
  "observedAt",
  "providerFinalizedHead",
  "providerIdentity",
  "providerLabel",
  "proxy",
  "safety",
  "schema",
  "sourceCommit",
  "stateAnchor",
  "token",
]);

function exactKeys(value, expected, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${name} fields are not exact`);
  }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function valueDigest(value) {
  return keccak256(toUtf8Bytes(JSON.stringify(canonical(value)))).toLowerCase();
}

function canonicalIso(value, name) {
  const raw = String(value ?? "");
  const parsed = new Date(raw);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== raw) {
    throw new TypeError(`${name} must be canonical ISO-8601`);
  }
  return raw;
}

function safeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function bytes32(value, name, { nonzero = false } = {}) {
  const raw = String(value ?? "");
  if (!LOWER_BYTES32.test(raw) || (nonzero && raw === ZERO_BYTES32)) {
    throw new TypeError(`${name} must be ${nonzero ? "nonzero " : ""}lowercase bytes32`);
  }
  return raw;
}

function canonicalAddress(value, name) {
  let normalized;
  try {
    normalized = getAddress(value);
  } catch {
    throw new TypeError(`${name} must be an Ethereum address`);
  }
  if (normalized !== value) throw new TypeError(`${name} is not canonically checksummed`);
  return normalized;
}

function providerLabel(value, name) {
  const raw = String(value ?? "");
  if (!PROVIDER_LABEL.test(raw)
      || /(?:https?|wss?):|rpc[./_-]|api[._ -]?key|bearer|authorization/i.test(raw)) {
    throw new TypeError(`${name} must be a credential-free provider label`);
  }
  return raw;
}

function normalizeRecordedBlock(value, name) {
  exactKeys(value, ["hash", "number", "timestamp"], name);
  return Object.freeze({
    number: safeInteger(value.number, `${name}.number`),
    hash: bytes32(value.hash, `${name}.hash`),
    timestamp: canonicalIso(value.timestamp, `${name}.timestamp`),
  });
}

export function validateBitObservationSourceProvenance({ branch, head, originUrl, published, status }) {
  const normalizedHead = String(head ?? "");
  const normalizedPublished = String(published ?? "");
  if (String(status ?? "") !== "" || branch !== "main" || originUrl !== TREESWAP_CANONICAL_ORIGIN
      || !GIT_COMMIT.test(normalizedHead) || !GIT_COMMIT.test(normalizedPublished)
      || normalizedHead !== normalizedPublished) {
    throw new Error("BIT observation requires the exact clean commit published on origin/main");
  }
  return normalizedHead;
}

function requireHexQuantity(value, label) {
  if (!HEX_QUANTITY.test(String(value))) throw new TypeError(`${label} is not a canonical hex quantity`);
  const parsed = BigInt(value);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError(`${label} exceeds the safe integer range`);
  return Number(parsed);
}

function requireBlockNumber(value, label) {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative safe integer`);
    return value;
  }
  if (typeof value === "bigint") {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError(`${label} exceeds the safe integer range`);
    return Number(value);
  }
  if (DECIMAL_QUANTITY.test(String(value))) {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) throw new RangeError(`${label} exceeds the safe integer range`);
    return parsed;
  }
  if (HEX_QUANTITY.test(String(value))) return requireHexQuantity(value, label);
  throw new TypeError(`${label} must be a canonical block number`);
}

function blockTag(number) {
  return `0x${number.toString(16)}`;
}

function requireBlock(value, label) {
  if (!value || !BYTES32.test(String(value.hash ?? ""))) {
    throw new TypeError(`RPC did not return a ${label} block hash`);
  }
  return {
    number: requireHexQuantity(value.number, `${label} block number`),
    hash: value.hash.toLowerCase(),
    timestamp: requireHexQuantity(value.timestamp, `${label} block timestamp`),
  };
}

function requireCode(value, label) {
  if (!isHexString(value) || value === "0x") throw new TypeError(`${label} has no deployed bytecode`);
  return value.toLowerCase();
}

function implementationFromSlot(value) {
  if (!isHexString(value, 32)) throw new TypeError("BIT implementation slot is not bytes32");
  const implementation = getAddress(`0x${value.slice(-40)}`);
  if (implementation === ZeroAddress) throw new TypeError("BIT implementation slot is empty");
  return implementation;
}

function decodeCall(functionName, encoded) {
  if (!isHexString(encoded)) throw new TypeError(`${functionName} returned malformed data`);
  try {
    return BIT_INTERFACE.decodeFunctionResult(functionName, encoded)[0];
  } catch {
    throw new TypeError(`${functionName} returned undecodable data`);
  }
}

export function assessBitDeploymentObservation(observation) {
  const reasons = [];
  if (observation.chainId !== 1) reasons.push("BIT observation is not from Ethereum mainnet");
  if (observation.proxy.address !== BIT_MAINNET_CONTRACT) reasons.push("BIT proxy address is not the reviewed contract");
  if (observation.token.symbol !== "BIT") reasons.push("BIT symbol changed");
  if (observation.token.decimals !== 18) reasons.push("BIT decimals changed");
  if (observation.token.paused !== false) reasons.push("BIT is paused");
  return Object.freeze({ eligible: reasons.length === 0, reasons: Object.freeze(reasons) });
}

export function normalizeBitDeploymentObservation(raw, name = "BIT observation") {
  exactKeys(raw, OBSERVATION_FIELDS, name);
  if (raw.schema !== BIT_DEPLOYMENT_OBSERVATION_SCHEMA) {
    throw new TypeError(`${name} schema is unsupported`);
  }
  if (raw.evidenceStatus !== "unreviewed-live-observation") {
    throw new TypeError(`${name} evidence status is unsupported`);
  }
  const observedAt = canonicalIso(raw.observedAt, `${name}.observedAt`);
  const label = providerLabel(raw.providerLabel, `${name}.providerLabel`);
  const identity = bytes32(raw.providerIdentity, `${name}.providerIdentity`, { nonzero: true });
  const sourceCommit = String(raw.sourceCommit ?? "");
  if (!GIT_COMMIT.test(sourceCommit)) throw new TypeError(`${name}.sourceCommit must be full lowercase hex`);
  const chainId = safeInteger(raw.chainId, `${name}.chainId`);
  const providerFinalizedHead = normalizeRecordedBlock(raw.providerFinalizedHead, `${name}.providerFinalizedHead`);
  const finalizedBlock = normalizeRecordedBlock(raw.finalizedBlock, `${name}.finalizedBlock`);
  exactKeys(raw.stateAnchor, ["blockHash", "requireCanonical"], `${name}.stateAnchor`);
  const stateAnchor = Object.freeze({
    blockHash: bytes32(raw.stateAnchor.blockHash, `${name}.stateAnchor.blockHash`),
    requireCanonical: raw.stateAnchor.requireCanonical,
  });
  if (stateAnchor.requireCanonical !== true || stateAnchor.blockHash !== finalizedBlock.hash) {
    throw new Error(`${name} is not canonically anchored to its finalized block`);
  }
  if (providerFinalizedHead.number < finalizedBlock.number) {
    throw new Error(`${name} provider did not prove the observed block finalized`);
  }
  if (providerFinalizedHead.number === finalizedBlock.number
      && (providerFinalizedHead.hash !== finalizedBlock.hash
        || providerFinalizedHead.timestamp !== finalizedBlock.timestamp)) {
    throw new Error(`${name} finalized head conflicts with the observed block`);
  }
  const observedAtMs = Date.parse(observedAt);
  for (const [blockName, block] of [["providerFinalizedHead", providerFinalizedHead], ["finalizedBlock", finalizedBlock]]) {
    if (Date.parse(block.timestamp) > observedAtMs + BIT_OBSERVATION_MAXIMUM_CLOCK_SKEW_SECONDS * 1_000) {
      throw new Error(`${name}.${blockName} is future-dated relative to the observation`);
    }
  }

  exactKeys(raw.proxy, ["address", "codeHash", "implementationSlot"], `${name}.proxy`);
  const proxy = Object.freeze({
    address: canonicalAddress(raw.proxy.address, `${name}.proxy.address`),
    codeHash: bytes32(raw.proxy.codeHash, `${name}.proxy.codeHash`),
    implementationSlot: bytes32(raw.proxy.implementationSlot, `${name}.proxy.implementationSlot`),
  });
  exactKeys(raw.implementation, ["address", "codeHash"], `${name}.implementation`);
  const implementation = Object.freeze({
    address: canonicalAddress(raw.implementation.address, `${name}.implementation.address`),
    codeHash: bytes32(raw.implementation.codeHash, `${name}.implementation.codeHash`),
  });
  exactKeys(raw.token, ["decimals", "paused", "symbol"], `${name}.token`);
  if (typeof raw.token.symbol !== "string" || raw.token.symbol.length > 32) {
    throw new TypeError(`${name}.token.symbol is invalid`);
  }
  const token = Object.freeze({
    symbol: raw.token.symbol,
    decimals: safeInteger(raw.token.decimals, `${name}.token.decimals`),
    paused: raw.token.paused,
  });
  if (typeof token.paused !== "boolean") throw new TypeError(`${name}.token.paused must be boolean`);

  const base = {
    schema: BIT_DEPLOYMENT_OBSERVATION_SCHEMA,
    evidenceStatus: "unreviewed-live-observation",
    observedAt,
    providerLabel: label,
    providerIdentity: identity,
    sourceCommit,
    chainId,
    providerFinalizedHead,
    finalizedBlock,
    stateAnchor,
    proxy,
    implementation,
    token,
  };
  const expectedSafety = assessBitDeploymentObservation(base);
  exactKeys(raw.safety, ["eligible", "reasons"], `${name}.safety`);
  if (typeof raw.safety.eligible !== "boolean" || !Array.isArray(raw.safety.reasons)
      || raw.safety.reasons.some((reason) => typeof reason !== "string")
      || raw.safety.eligible !== expectedSafety.eligible
      || JSON.stringify(raw.safety.reasons) !== JSON.stringify(expectedSafety.reasons)) {
    throw new Error(`${name}.safety does not match the observed state`);
  }
  const normalized = Object.freeze({ ...base, safety: expectedSafety });
  if (JSON.stringify(canonical(normalized)) !== JSON.stringify(canonical(raw))) {
    throw new Error(`${name} is not canonical`);
  }
  return normalized;
}

export function bitDeploymentObservationValueDigest(observation) {
  return valueDigest(normalizeBitDeploymentObservation(observation));
}

export function compareBitDeploymentObservations(left, right, { comparedAt = new Date() } = {}) {
  const reasons = [];
  const add = (condition, reason) => {
    if (condition) reasons.push(reason);
  };
  const field = (value, path) => path.split(".").reduce((current, part) => current?.[part], value);
  const comparedFields = [
    "schema",
    "sourceCommit",
    "chainId",
    "finalizedBlock.number",
    "finalizedBlock.hash",
    "finalizedBlock.timestamp",
    "stateAnchor.blockHash",
    "stateAnchor.requireCanonical",
    "proxy.address",
    "proxy.codeHash",
    "proxy.implementationSlot",
    "implementation.address",
    "implementation.codeHash",
    "token.symbol",
    "token.decimals",
    "token.paused",
  ];

  let normalizedLeft;
  let normalizedRight;
  for (const [position, observation] of [["first", left], ["second", right]]) {
    try {
      const normalized = normalizeBitDeploymentObservation(observation, `${position} observation`);
      if (position === "first") normalizedLeft = normalized;
      else normalizedRight = normalized;
    } catch (error) {
      reasons.push(error instanceof Error ? error.message : `${position} observation is invalid`);
    }
  }
  if (normalizedLeft && normalizedRight) {
    let comparisonTime;
    try {
      comparisonTime = Date.parse(canonicalIso(
        comparedAt instanceof Date ? comparedAt.toISOString() : comparedAt,
        "comparison time",
      ));
    } catch (error) {
      reasons.push(error instanceof Error ? error.message : "comparison time is invalid");
    }
    add(normalizedLeft.providerIdentity === normalizedRight.providerIdentity, "providers must have distinct identity commitments");
    add(
      normalizedLeft.providerLabel.toLowerCase() === normalizedRight.providerLabel.toLowerCase(),
      "providers must have distinct labels",
    );
    add(
      bitDeploymentObservationValueDigest(normalizedLeft) === bitDeploymentObservationValueDigest(normalizedRight),
      "provider observation digests must be distinct",
    );
    if (Number.isFinite(comparisonTime)) {
      const observedTimes = [Date.parse(normalizedLeft.observedAt), Date.parse(normalizedRight.observedAt)];
      for (const [index, observedTime] of observedTimes.entries()) {
        const position = index === 0 ? "first" : "second";
        add(
          observedTime > comparisonTime + BIT_OBSERVATION_MAXIMUM_CLOCK_SKEW_SECONDS * 1_000,
          `${position} observation is future-dated`,
        );
        add(
          comparisonTime - observedTime > BIT_OBSERVATION_MAXIMUM_AGE_SECONDS * 1_000,
          `${position} observation is stale`,
        );
      }
      add(
        Math.abs(observedTimes[0] - observedTimes[1]) > BIT_OBSERVATION_MAXIMUM_PROVIDER_SKEW_SECONDS * 1_000,
        "provider observations were not captured within the allowed window",
      );
    }
    add(!normalizedLeft.safety.eligible, "first observation is not safety eligible");
    add(!normalizedRight.safety.eligible, "second observation is not safety eligible");
    for (const path of comparedFields) {
      add(field(normalizedLeft, path) !== field(normalizedRight, path), `${path} differs between providers`);
    }
  }

  return Object.freeze({
    eligible: reasons.length === 0,
    reasons: Object.freeze(reasons),
    comparedFields: Object.freeze(comparedFields),
  });
}

export function buildBitDeploymentComparisonReport(left, right, { comparedAt = new Date() } = {}) {
  const normalizedLeft = normalizeBitDeploymentObservation(left, "first observation");
  const normalizedRight = normalizeBitDeploymentObservation(right, "second observation");
  const timestamp = canonicalIso(comparedAt instanceof Date ? comparedAt.toISOString() : comparedAt, "comparison time");
  const comparison = compareBitDeploymentObservations(normalizedLeft, normalizedRight, { comparedAt: timestamp });
  const observations = [normalizedLeft, normalizedRight]
    .map((observation) => Object.freeze({
      providerIdentity: observation.providerIdentity,
      providerLabel: observation.providerLabel,
      observationDigest: bitDeploymentObservationValueDigest(observation),
    }))
    .sort((a, b) => a.providerIdentity.localeCompare(b.providerIdentity));
  return Object.freeze({
    schema: BIT_DEPLOYMENT_COMPARISON_SCHEMA,
    evidenceStatus: "unreviewed-provider-comparison",
    comparedAt: timestamp,
    policy: Object.freeze({
      maximumObservationAgeSeconds: BIT_OBSERVATION_MAXIMUM_AGE_SECONDS,
      maximumObservationClockSkewSeconds: BIT_OBSERVATION_MAXIMUM_CLOCK_SKEW_SECONDS,
      maximumProviderObservationSkewSeconds: BIT_OBSERVATION_MAXIMUM_PROVIDER_SKEW_SECONDS,
    }),
    observations: Object.freeze(observations),
    finalizedBlock: normalizedLeft.finalizedBlock,
    sourceCommit: normalizedLeft.sourceCommit,
    eligible: comparison.eligible,
    reasons: comparison.reasons,
    comparedFields: comparison.comparedFields,
    independenceStatus: "requires-external-organizational-verification",
    fundingAuthorization: false,
  });
}

export async function observeBitDeployment({
  rpcCall,
  proxyAddress = BIT_MAINNET_CONTRACT,
  providerLabel: providerLabelValue,
  providerIdentity,
  observedAt = new Date(),
  sourceCommit,
  targetBlockNumber = null,
} = {}) {
  if (typeof rpcCall !== "function") throw new TypeError("rpcCall is required");
  const normalizedProviderLabel = providerLabel(providerLabelValue, "providerLabel");
  const normalizedProviderIdentity = bytes32(providerIdentity, "providerIdentity", { nonzero: true });
  if (!GIT_COMMIT.test(String(sourceCommit ?? ""))) {
    throw new TypeError("sourceCommit must be full lowercase hex");
  }
  const proxy = getAddress(proxyAddress);
  if (proxy !== BIT_MAINNET_CONTRACT) throw new TypeError("unexpected BIT proxy address");

  const chainId = requireHexQuantity(await rpcCall("eth_chainId", []), "chain ID");
  if (chainId !== 1) throw new TypeError("BIT observation must use Ethereum mainnet");

  const finalizedHead = requireBlock(
    await rpcCall("eth_getBlockByNumber", ["finalized", false]),
    "finalized",
  );
  const requestedBlockNumber = targetBlockNumber === null
    ? finalizedHead.number
    : requireBlockNumber(targetBlockNumber, "target block number");
  if (requestedBlockNumber > finalizedHead.number) {
    throw new RangeError("target block is newer than the provider's finalized head");
  }
  const exactBlockTag = blockTag(requestedBlockNumber);
  const observedBlock = requireBlock(
    await rpcCall("eth_getBlockByNumber", [exactBlockTag, false]),
    "target",
  );
  if (observedBlock.number !== requestedBlockNumber) throw new TypeError("RPC returned the wrong target block number");
  if (observedBlock.number === finalizedHead.number && observedBlock.hash !== finalizedHead.hash) {
    throw new TypeError("RPC finalized head changed while pinning the target block");
  }
  const stateAnchor = Object.freeze({ blockHash: observedBlock.hash, requireCanonical: true });

  const [proxyCodeValue, implementationWord, decimalsValue, pausedValue, symbolValue] = await Promise.all([
    rpcCall("eth_getCode", [proxy, stateAnchor]),
    rpcCall("eth_getStorageAt", [proxy, EIP1967_IMPLEMENTATION_SLOT, stateAnchor]),
    rpcCall("eth_call", [{ to: proxy, data: BIT_INTERFACE.encodeFunctionData("decimals") }, stateAnchor]),
    rpcCall("eth_call", [{ to: proxy, data: BIT_INTERFACE.encodeFunctionData("paused") }, stateAnchor]),
    rpcCall("eth_call", [{ to: proxy, data: BIT_INTERFACE.encodeFunctionData("symbol") }, stateAnchor]),
  ]);

  const implementationAddress = implementationFromSlot(implementationWord);
  const implementationCodeValue = await rpcCall("eth_getCode", [implementationAddress, stateAnchor]);
  const proxyCode = requireCode(proxyCodeValue, "BIT proxy");
  const implementationCode = requireCode(implementationCodeValue, "BIT implementation");
  const symbol = String(decodeCall("symbol", symbolValue));
  if (symbol.length > 32) throw new TypeError("BIT symbol is unexpectedly long");

  const timestamp = observedAt instanceof Date ? observedAt : new Date(observedAt);
  if (!Number.isFinite(timestamp.getTime())) throw new TypeError("observedAt is invalid");

  const observation = {
    schema: BIT_DEPLOYMENT_OBSERVATION_SCHEMA,
    evidenceStatus: "unreviewed-live-observation",
    observedAt: timestamp.toISOString(),
    providerLabel: normalizedProviderLabel,
    providerIdentity: normalizedProviderIdentity,
    sourceCommit,
    chainId,
    providerFinalizedHead: {
      number: finalizedHead.number,
      hash: finalizedHead.hash,
      timestamp: new Date(finalizedHead.timestamp * 1_000).toISOString(),
    },
    finalizedBlock: {
      number: observedBlock.number,
      hash: observedBlock.hash,
      timestamp: new Date(observedBlock.timestamp * 1_000).toISOString(),
    },
    stateAnchor,
    proxy: {
      address: proxy,
      codeHash: keccak256(proxyCode),
      implementationSlot: EIP1967_IMPLEMENTATION_SLOT,
    },
    implementation: {
      address: implementationAddress,
      codeHash: keccak256(implementationCode),
    },
    token: {
      symbol,
      decimals: Number(decodeCall("decimals", decimalsValue)),
      paused: Boolean(decodeCall("paused", pausedValue)),
    },
  };

  return normalizeBitDeploymentObservation({
    ...observation,
    safety: assessBitDeploymentObservation(observation),
  });
}

export function createJsonRpcClient(rpcUrl, fetchImpl = globalThis.fetch, { timeoutMs = 10_000 } = {}) {
  let url;
  try {
    url = new URL(rpcUrl);
  } catch {
    throw new TypeError("ETHEREUM_RPC_URL must be a valid URL");
  }
  if (!/^https?:$/.test(url.protocol)) throw new TypeError("ETHEREUM_RPC_URL must use HTTP or HTTPS");
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !loopback) {
    throw new TypeError("remote ETHEREUM_RPC_URL must use HTTPS");
  }
  if (typeof fetchImpl !== "function") throw new TypeError("fetch implementation is required");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000) {
    throw new RangeError("Ethereum RPC timeout is outside policy");
  }

  let requestId = 0;
  return async function rpcCall(method, params) {
    const id = ++requestId;
    let response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new Error(`Ethereum RPC transport failed for ${method}`);
    }
    if (!response.ok) throw new Error(`Ethereum RPC returned HTTP ${response.status} for ${method}`);

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error(`Ethereum RPC returned invalid JSON for ${method}`);
    }
    if (payload?.id !== id || payload?.jsonrpc !== "2.0") throw new Error(`Ethereum RPC response mismatch for ${method}`);
    if (payload.error) throw new Error(`Ethereum RPC rejected ${method} with code ${payload.error.code ?? "unknown"}`);
    if (!("result" in payload)) throw new Error(`Ethereum RPC omitted the result for ${method}`);
    return payload.result;
  };
}
