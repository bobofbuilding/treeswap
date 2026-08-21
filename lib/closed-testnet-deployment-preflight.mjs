import {
  getAddress,
  isHexString,
  keccak256,
  toUtf8Bytes,
  verifyTypedData,
} from "ethers";
import { EIP1967_IMPLEMENTATION_SLOT } from "./bit-deployment-observer.mjs";
import { assertClosedTestnetDeploymentPlanIsSecretFree } from "./closed-testnet-deployment-plan.mjs";

const BYTES32 = /^0x[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const DECIMAL = /^(?:0|[1-9][0-9]{0,19})$/;
const ZERO_DIGEST = `0x${"00".repeat(32)}`;
const UINT64_MAX = (1n << 64n) - 1n;
const APPROVER_ROLES = Object.freeze(["operations-reviewer", "provider"]);

const PLAN_FIELDS = Object.freeze([
  "artifacts",
  "bit",
  "controllerSafeActions",
  "deployer",
  "deploymentTransactions",
  "environment",
  "gate",
  "inputDigest",
  "network",
  "permissions",
  "planDigest",
  "requiredPostconditions",
  "requiredPreflight",
  "roles",
  "schema",
  "scope",
  "source",
  "userEscrowRisk",
  "vaultRisk",
]);

const POLICY_FIELDS = Object.freeze([
  "approvers",
  "chainId",
  "environment",
  "independentReviewDigest",
  "inputDigest",
  "maximumBlockAgeSeconds",
  "maximumObservationAgeSeconds",
  "maximumPreflightLifetimeSeconds",
  "minimumProviderCount",
  "planDigest",
  "reviewedBuildCommit",
  "schema",
  "verifyingContract",
]);

const RECORD_FIELDS = Object.freeze([
  "anchorBlockHash",
  "anchorBlockNumber",
  "chainId",
  "deployer",
  "environment",
  "independentReviewDigest",
  "inputDigest",
  "planDigest",
  "preflightId",
  "preparedAt",
  "providerObservations",
  "reviewedBuildCommit",
  "schema",
  "startingNonce",
  "validUntil",
  "verifyingContract",
]);

const OBSERVATION_FIELDS = Object.freeze([
  "anchorBlock",
  "bit",
  "chainId",
  "deploymentTargets",
  "deployer",
  "evidenceStatus",
  "inputDigest",
  "observedAt",
  "planDigest",
  "providerIdentity",
  "providerLabel",
  "roles",
  "schema",
  "sourceCommit",
  "stateAnchor",
]);

const ROLE_FIELDS = Object.freeze([
  "address",
  "ownerAddresses",
  "runtimeCodeHash",
  "threshold",
]);

const BIT_FIELDS = Object.freeze([
  "decimals",
  "implementationAddress",
  "implementationCodeHash",
  "implementationSlot",
  "paused",
  "proxyAddress",
  "proxyCodeHash",
  "symbol",
]);

const DEPLOYMENT_TARGET_FIELDS = Object.freeze(["address", "codeEmpty", "name"]);

const verifiedPreflights = new WeakSet();

export const CLOSED_TESTNET_DEPLOYMENT_PREFLIGHT_APPROVAL_TYPES = Object.freeze({
  ClosedTestnetDeploymentPreflightApproval: Object.freeze([
    Object.freeze({ name: "preflightId", type: "bytes32" }),
    Object.freeze({ name: "recordDigest", type: "bytes32" }),
    Object.freeze({ name: "policyDigest", type: "bytes32" }),
    Object.freeze({ name: "role", type: "string" }),
    Object.freeze({ name: "approverId", type: "bytes32" }),
    Object.freeze({ name: "planDigest", type: "bytes32" }),
    Object.freeze({ name: "inputDigest", type: "bytes32" }),
    Object.freeze({ name: "anchorBlockNumber", type: "uint64" }),
    Object.freeze({ name: "anchorBlockHash", type: "bytes32" }),
    Object.freeze({ name: "deployer", type: "address" }),
    Object.freeze({ name: "startingNonce", type: "uint64" }),
  ]),
});

function exactKeys(value, expected, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${name} fields are not exact`);
  }
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hash(value) {
  return keccak256(toUtf8Bytes(canonical(value))).toLowerCase();
}

function digest(value, name, { nonzero = true } = {}) {
  const normalized = String(value ?? "").toLowerCase();
  if (!BYTES32.test(normalized) || (nonzero && normalized === ZERO_DIGEST)) {
    throw new TypeError(`${name} must be a${nonzero ? " nonzero" : ""} lowercase bytes32 digest`);
  }
  return normalized;
}

function address(value, name) {
  try {
    return getAddress(String(value ?? ""));
  } catch {
    throw new TypeError(`${name} must be an Ethereum address`);
  }
}

function decimal(value, name, { positive = false } = {}) {
  const normalized = String(value ?? "");
  if (!DECIMAL.test(normalized)) throw new TypeError(`${name} must be a canonical uint64 decimal string`);
  const parsed = BigInt(normalized);
  if (parsed > UINT64_MAX || (positive && parsed === 0n)) throw new RangeError(`${name} is outside uint64`);
  return normalized;
}

function safeInteger(value, name, { positive = false } = {}) {
  if (!Number.isSafeInteger(value) || value < 0 || (positive && value === 0)) {
    throw new TypeError(`${name} must be a ${positive ? "positive" : "non-negative"} safe integer`);
  }
  return value;
}

function canonicalIso(value, name) {
  const raw = String(value ?? "");
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== raw) {
    throw new TypeError(`${name} must be canonical ISO-8601`);
  }
  return Object.freeze({ raw, seconds: Math.floor(parsed / 1_000) });
}

function requireCanonicalOrder(values, selector, name) {
  const keys = values.map(selector);
  const sorted = [...keys].sort();
  if (keys.some((key, index) => key !== sorted[index])) throw new Error(`${name} are not canonically ordered`);
}

function normalizePlanRole(raw, name) {
  exactKeys(raw, ROLE_FIELDS, name);
  if (!Array.isArray(raw.ownerAddresses) || raw.ownerAddresses.length < 3 || raw.ownerAddresses.length > 20) {
    throw new Error(`${name} owner set is outside policy`);
  }
  const ownerAddresses = raw.ownerAddresses.map((value, index) => address(value, `${name}.ownerAddresses[${index}]`));
  requireCanonicalOrder(ownerAddresses, (value) => value.toLowerCase(), `${name} owners`);
  if (new Set(ownerAddresses.map((value) => value.toLowerCase())).size !== ownerAddresses.length) {
    throw new Error(`${name} owners are duplicated`);
  }
  const threshold = safeInteger(raw.threshold, `${name}.threshold`, { positive: true });
  if (threshold < 2 || threshold > ownerAddresses.length) throw new Error(`${name} threshold is outside policy`);
  return Object.freeze({
    address: address(raw.address, `${name}.address`),
    ownerAddresses: Object.freeze(ownerAddresses),
    threshold,
    runtimeCodeHash: digest(raw.runtimeCodeHash, `${name}.runtimeCodeHash`),
  });
}

function normalizePlan(raw) {
  exactKeys(raw, PLAN_FIELDS, "closed-testnet deployment plan");
  if (raw.schema !== "treeswap.closed-testnet-deployment-plan.v1"
      || raw.scope !== "unsigned-public-testnet-plan-no-signing-broadcast-or-funding-authorization"
      || raw.environment !== "public-testnet") {
    throw new TypeError("preflight requires an unsigned public-testnet deployment plan");
  }
  exactKeys(raw.network, ["chainId", "mainnetAssets", "name"], "deployment plan network");
  if (raw.network.chainId !== "11155111" || raw.network.name !== "sepolia" || raw.network.mainnetAssets !== false) {
    throw new Error("deployment plan is not pinned to the Sepolia test boundary");
  }
  exactKeys(
    raw.permissions,
    ["broadcastAuthorization", "fundingAuthorization", "gateOpeningAuthorization", "signingAuthorization"],
    "deployment plan permissions",
  );
  if (Object.values(raw.permissions).some((value) => value !== false)) {
    throw new Error("deployment plan grants an operational authorization");
  }
  exactKeys(raw.source, ["independentReviewDigest", "reviewedBuildCommit"], "deployment plan source");
  if (!COMMIT.test(String(raw.source.reviewedBuildCommit ?? ""))) throw new TypeError("reviewed build commit is invalid");
  exactKeys(raw.deployer, ["address", "startingNonce"], "deployment plan deployer");
  exactKeys(raw.roles, ["controller", "feeCollector", "guardian"], "deployment plan roles");
  exactKeys(raw.bit, [
    "decimals",
    "implementationAddress",
    "implementationCodeHash",
    "paused",
    "proxyAddress",
    "proxyCodeHash",
    "symbol",
    "tokenBoundary",
  ], "deployment plan BIT");
  if (raw.bit.tokenBoundary !== "reviewed-public-testnet-bit-proxy"
      || raw.bit.symbol !== "BIT" || raw.bit.decimals !== 18 || raw.bit.paused !== false) {
    throw new Error("deployment plan BIT boundary is invalid");
  }
  if (!Array.isArray(raw.deploymentTransactions) || raw.deploymentTransactions.length !== 4) {
    throw new Error("deployment plan transaction sequence is invalid");
  }
  const { planDigest, ...body } = raw;
  const normalizedPlanDigest = digest(planDigest, "planDigest");
  if (hash(body) !== normalizedPlanDigest) throw new Error("deployment plan digest is invalid");
  assertClosedTestnetDeploymentPlanIsSecretFree(raw);
  const roles = Object.freeze({
    controller: normalizePlanRole(raw.roles.controller, "roles.controller"),
    feeCollector: normalizePlanRole(raw.roles.feeCollector, "roles.feeCollector"),
    guardian: normalizePlanRole(raw.roles.guardian, "roles.guardian"),
  });
  if (new Set(Object.values(roles).map((value) => value.address.toLowerCase())).size !== 3) {
    throw new Error("deployment plan role wallets must be distinct");
  }
  const roleOwners = Object.values(roles).flatMap((value) => value.ownerAddresses.map((owner) => owner.toLowerCase()));
  if (new Set(roleOwners).size !== roleOwners.length) {
    throw new Error("deployment plan role owner sets must be completely disjoint");
  }
  const deployer = address(raw.deployer.address, "deployer");
  const startingNonce = decimal(raw.deployer.startingNonce, "startingNonce");
  const names = ["gate", "paymentHashRegistry", "vault", "userEscrow"];
  const deploymentTargets = raw.deploymentTransactions.map((transaction, index) => {
    if (!transaction || transaction.name !== names[index]
        || transaction.kind !== "unsigned-contract-creation"
        || transaction.chainId !== raw.network.chainId
        || address(transaction.from, `deploymentTransactions[${index}].from`) !== deployer
        || transaction.to !== null || transaction.valueWei !== "0"
        || decimal(transaction.nonce, `deploymentTransactions[${index}].nonce`) !== String(BigInt(startingNonce) + BigInt(index))) {
      throw new Error("deployment plan transaction sequence is invalid");
    }
    return Object.freeze({
      name: names[index],
      address: address(transaction.expectedContractAddress, `deploymentTransactions[${index}].expectedContractAddress`),
      codeEmpty: true,
    });
  });
  if (new Set(deploymentTargets.map((value) => value.address.toLowerCase())).size !== deploymentTargets.length) {
    throw new Error("deployment plan target addresses are duplicated");
  }
  return Object.freeze({
    raw,
    planDigest: normalizedPlanDigest,
    inputDigest: digest(raw.inputDigest, "inputDigest"),
    reviewedBuildCommit: raw.source.reviewedBuildCommit,
    independentReviewDigest: digest(raw.source.independentReviewDigest, "independentReviewDigest"),
    chainId: raw.network.chainId,
    verifyingContract: deploymentTargets[0].address,
    deployer,
    startingNonce,
    deploymentTargets: Object.freeze(deploymentTargets),
    roles,
    bit: Object.freeze({
      proxyAddress: address(raw.bit.proxyAddress, "bit.proxyAddress"),
      implementationAddress: address(raw.bit.implementationAddress, "bit.implementationAddress"),
      proxyCodeHash: digest(raw.bit.proxyCodeHash, "bit.proxyCodeHash"),
      implementationCodeHash: digest(raw.bit.implementationCodeHash, "bit.implementationCodeHash"),
      symbol: "BIT",
      decimals: 18,
      paused: false,
    }),
  });
}

function normalizeApprover(raw, index) {
  exactKeys(raw, ["approverId", "role", "signer"], `approvers[${index}]`);
  if (!APPROVER_ROLES.includes(raw.role)) throw new TypeError(`approvers[${index}].role is invalid`);
  return Object.freeze({
    role: raw.role,
    approverId: digest(raw.approverId, `approvers[${index}].approverId`),
    signer: address(raw.signer, `approvers[${index}].signer`),
  });
}

function normalizePolicy(raw, plan) {
  exactKeys(raw, POLICY_FIELDS, "deployment preflight policy");
  if (raw.schema !== "treeswap.closed-testnet-deployment-preflight-policy.v1"
      || raw.environment !== "public-testnet") {
    throw new TypeError("deployment preflight policy schema or environment is invalid");
  }
  if (!COMMIT.test(String(raw.reviewedBuildCommit ?? ""))) throw new TypeError("preflight build commit is invalid");
  const minimumProviderCount = safeInteger(raw.minimumProviderCount, "minimumProviderCount", { positive: true });
  const maximumObservationAgeSeconds = safeInteger(
    raw.maximumObservationAgeSeconds,
    "maximumObservationAgeSeconds",
    { positive: true },
  );
  const maximumBlockAgeSeconds = safeInteger(raw.maximumBlockAgeSeconds, "maximumBlockAgeSeconds", { positive: true });
  const maximumPreflightLifetimeSeconds = safeInteger(
    raw.maximumPreflightLifetimeSeconds,
    "maximumPreflightLifetimeSeconds",
    { positive: true },
  );
  if (minimumProviderCount < 2 || minimumProviderCount > 5) {
    throw new Error("preflight policy must require two to five providers");
  }
  if (maximumObservationAgeSeconds > 600 || maximumBlockAgeSeconds > 600) {
    throw new Error("preflight observations and blocks may not be older than ten minutes");
  }
  if (maximumPreflightLifetimeSeconds > 900) {
    throw new Error("deployment preflight may not remain current longer than fifteen minutes");
  }
  if (!Array.isArray(raw.approvers) || raw.approvers.length < 3 || raw.approvers.length > 6) {
    throw new TypeError("preflight approvers must be a bounded array");
  }
  const approvers = raw.approvers.map(normalizeApprover);
  requireCanonicalOrder(approvers, (value) => `${value.role}:${value.approverId}`, "preflight approvers");
  const keys = new Set();
  const approverIds = new Set();
  const signers = new Set();
  for (const approver of approvers) {
    const key = `${approver.role}:${approver.approverId}`;
    if (keys.has(key)) throw new Error("preflight approver is duplicated");
    keys.add(key);
    if (approverIds.has(approver.approverId)) throw new Error("preflight approver identities must be globally distinct");
    approverIds.add(approver.approverId);
    const signer = approver.signer.toLowerCase();
    if (signers.has(signer)) throw new Error("preflight approver signers must be globally distinct");
    signers.add(signer);
  }
  const providers = approvers.filter((value) => value.role === "provider");
  const reviewers = approvers.filter((value) => value.role === "operations-reviewer");
  if (providers.length < minimumProviderCount || providers.length > 5 || reviewers.length !== 1) {
    throw new Error("preflight requires its provider quorum and exactly one operations reviewer");
  }
  const normalized = Object.freeze({
    schema: raw.schema,
    environment: raw.environment,
    chainId: decimal(raw.chainId, "policy.chainId", { positive: true }),
    verifyingContract: address(raw.verifyingContract, "policy.verifyingContract"),
    reviewedBuildCommit: raw.reviewedBuildCommit,
    independentReviewDigest: digest(raw.independentReviewDigest, "policy.independentReviewDigest"),
    inputDigest: digest(raw.inputDigest, "policy.inputDigest"),
    planDigest: digest(raw.planDigest, "policy.planDigest"),
    minimumProviderCount,
    maximumObservationAgeSeconds,
    maximumBlockAgeSeconds,
    maximumPreflightLifetimeSeconds,
    approvers: Object.freeze(approvers),
  });
  for (const field of [
    "chainId",
    "verifyingContract",
    "reviewedBuildCommit",
    "independentReviewDigest",
    "inputDigest",
    "planDigest",
  ]) {
    if (normalized[field] !== plan[field]) throw new Error(`preflight policy ${field} does not match the deployment plan`);
  }
  return normalized;
}

function normalizeObservationReference(raw, index) {
  exactKeys(raw, ["observationDigest", "providerIdentity"], `providerObservations[${index}]`);
  return Object.freeze({
    providerIdentity: digest(raw.providerIdentity, `providerObservations[${index}].providerIdentity`),
    observationDigest: digest(raw.observationDigest, `providerObservations[${index}].observationDigest`),
  });
}

function normalizeRecord(raw, policy, plan) {
  exactKeys(raw, RECORD_FIELDS, "deployment preflight record");
  if (raw.schema !== "treeswap.closed-testnet-deployment-preflight-record.v1"
      || raw.environment !== "public-testnet") {
    throw new TypeError("deployment preflight record schema or environment is invalid");
  }
  if (!COMMIT.test(String(raw.reviewedBuildCommit ?? ""))) throw new TypeError("preflight build commit is invalid");
  const preparedAt = safeInteger(raw.preparedAt, "preparedAt", { positive: true });
  const validUntil = safeInteger(raw.validUntil, "validUntil", { positive: true });
  if (validUntil <= preparedAt || validUntil - preparedAt > policy.maximumPreflightLifetimeSeconds) {
    throw new Error("preflight validity is reversed or exceeds policy");
  }
  if (!Array.isArray(raw.providerObservations) || raw.providerObservations.length > 5) {
    throw new TypeError("providerObservations must be a bounded array");
  }
  const providerObservations = raw.providerObservations.map(normalizeObservationReference);
  requireCanonicalOrder(providerObservations, (value) => value.providerIdentity, "provider observations");
  if (providerObservations.length < policy.minimumProviderCount
      || new Set(providerObservations.map((value) => value.providerIdentity)).size !== providerObservations.length
      || new Set(providerObservations.map((value) => value.observationDigest)).size !== providerObservations.length) {
    throw new Error("provider observation quorum is invalid");
  }
  const normalized = Object.freeze({
    schema: raw.schema,
    preflightId: digest(raw.preflightId, "preflightId"),
    environment: raw.environment,
    chainId: decimal(raw.chainId, "record.chainId", { positive: true }),
    verifyingContract: address(raw.verifyingContract, "record.verifyingContract"),
    reviewedBuildCommit: raw.reviewedBuildCommit,
    independentReviewDigest: digest(raw.independentReviewDigest, "record.independentReviewDigest"),
    inputDigest: digest(raw.inputDigest, "record.inputDigest"),
    planDigest: digest(raw.planDigest, "record.planDigest"),
    deployer: address(raw.deployer, "record.deployer"),
    startingNonce: decimal(raw.startingNonce, "record.startingNonce"),
    anchorBlockNumber: decimal(raw.anchorBlockNumber, "record.anchorBlockNumber", { positive: true }),
    anchorBlockHash: digest(raw.anchorBlockHash, "record.anchorBlockHash"),
    providerObservations: Object.freeze(providerObservations),
    preparedAt,
    validUntil,
  });
  for (const field of [
    "chainId",
    "verifyingContract",
    "reviewedBuildCommit",
    "independentReviewDigest",
    "inputDigest",
    "planDigest",
  ]) {
    if (normalized[field] !== policy[field]) throw new Error(`preflight record ${field} does not match policy`);
  }
  for (const field of ["deployer", "startingNonce"]) {
    if (normalized[field] !== plan[field]) throw new Error(`preflight record ${field} does not match the deployment plan`);
  }
  const providerApprovers = policy.approvers.filter((value) => value.role === "provider");
  if (providerApprovers.length !== providerObservations.length
      || providerApprovers.some((value, index) => value.approverId !== providerObservations[index].providerIdentity)) {
    throw new Error("provider observations do not exactly match provider approvers");
  }
  return normalized;
}

function normalizeObservedRole(raw, name, expected) {
  const normalized = normalizePlanRole(raw, name);
  if (canonical(normalized) !== canonical(expected)) throw new Error(`${name} does not match the deployment plan`);
  return normalized;
}

function normalizeObservedBit(raw, expected) {
  exactKeys(raw, BIT_FIELDS, "preflight BIT observation");
  const normalized = Object.freeze({
    proxyAddress: address(raw.proxyAddress, "observed BIT proxy"),
    implementationAddress: address(raw.implementationAddress, "observed BIT implementation"),
    implementationSlot: digest(raw.implementationSlot, "observed BIT implementation slot", { nonzero: false }),
    proxyCodeHash: digest(raw.proxyCodeHash, "observed BIT proxy code hash"),
    implementationCodeHash: digest(raw.implementationCodeHash, "observed BIT implementation code hash"),
    symbol: String(raw.symbol ?? ""),
    decimals: safeInteger(raw.decimals, "observed BIT decimals"),
    paused: raw.paused,
  });
  if (normalized.implementationSlot !== EIP1967_IMPLEMENTATION_SLOT
      || normalized.proxyAddress !== expected.proxyAddress
      || normalized.implementationAddress !== expected.implementationAddress
      || normalized.proxyCodeHash !== expected.proxyCodeHash
      || normalized.implementationCodeHash !== expected.implementationCodeHash
      || normalized.symbol !== expected.symbol
      || normalized.decimals !== expected.decimals
      || normalized.paused !== expected.paused) {
    throw new Error("observed BIT state does not match the deployment plan");
  }
  return normalized;
}

function normalizeObservation(raw, index, record, policy, plan) {
  exactKeys(raw, OBSERVATION_FIELDS, `observations[${index}]`);
  if (raw.schema !== "treeswap.closed-testnet-deployment-preflight-observation.v1"
      || raw.evidenceStatus !== "unreviewed-live-preflight-observation") {
    throw new TypeError(`observations[${index}] schema or status is invalid`);
  }
  const providerIdentity = digest(raw.providerIdentity, `observations[${index}].providerIdentity`);
  const providerLabel = String(raw.providerLabel ?? "");
  if (providerLabel.length === 0 || providerLabel.length > 80) {
    throw new TypeError(`observations[${index}].providerLabel is invalid`);
  }
  if (!COMMIT.test(String(raw.sourceCommit ?? "")) || raw.sourceCommit !== plan.reviewedBuildCommit
      || digest(raw.planDigest, `observations[${index}].planDigest`) !== plan.planDigest
      || digest(raw.inputDigest, `observations[${index}].inputDigest`) !== plan.inputDigest
      || decimal(raw.chainId, `observations[${index}].chainId`, { positive: true }) !== plan.chainId) {
    throw new Error(`observations[${index}] is not bound to the deployment plan`);
  }
  exactKeys(raw.anchorBlock, ["hash", "number", "timestamp"], `observations[${index}].anchorBlock`);
  exactKeys(raw.stateAnchor, ["blockHash", "requireCanonical"], `observations[${index}].stateAnchor`);
  const anchorBlock = Object.freeze({
    number: decimal(raw.anchorBlock.number, `observations[${index}].anchorBlock.number`, { positive: true }),
    hash: digest(raw.anchorBlock.hash, `observations[${index}].anchorBlock.hash`),
    timestamp: safeInteger(raw.anchorBlock.timestamp, `observations[${index}].anchorBlock.timestamp`, { positive: true }),
  });
  if (anchorBlock.number !== record.anchorBlockNumber || anchorBlock.hash !== record.anchorBlockHash
      || digest(raw.stateAnchor.blockHash, `observations[${index}].stateAnchor.blockHash`) !== anchorBlock.hash
      || raw.stateAnchor.requireCanonical !== true) {
    throw new Error(`observations[${index}] is not anchored to the preflight block`);
  }
  const observedAt = canonicalIso(raw.observedAt, `observations[${index}].observedAt`);
  if (observedAt.seconds > record.preparedAt
      || record.preparedAt - observedAt.seconds > policy.maximumObservationAgeSeconds
      || anchorBlock.timestamp > observedAt.seconds
      || record.preparedAt - anchorBlock.timestamp > policy.maximumBlockAgeSeconds) {
    throw new Error(`observations[${index}] is future-dated or stale`);
  }
  exactKeys(
    raw.deployer,
    ["address", "anchoredNonce", "codeEmpty", "pendingNonceAfter", "pendingNonceBefore"],
    `observations[${index}].deployer`,
  );
  const deployer = Object.freeze({
    address: address(raw.deployer.address, `observations[${index}].deployer.address`),
    codeEmpty: raw.deployer.codeEmpty,
    anchoredNonce: decimal(raw.deployer.anchoredNonce, `observations[${index}].deployer.anchoredNonce`),
    pendingNonceBefore: decimal(raw.deployer.pendingNonceBefore, `observations[${index}].deployer.pendingNonceBefore`),
    pendingNonceAfter: decimal(raw.deployer.pendingNonceAfter, `observations[${index}].deployer.pendingNonceAfter`),
  });
  if (deployer.address !== plan.deployer || deployer.codeEmpty !== true
      || deployer.anchoredNonce !== plan.startingNonce
      || deployer.pendingNonceBefore !== plan.startingNonce
      || deployer.pendingNonceAfter !== plan.startingNonce) {
    throw new Error(`observations[${index}] deployer nonce is unsafe or does not match the plan`);
  }
  exactKeys(raw.roles, ["controller", "feeCollector", "guardian"], `observations[${index}].roles`);
  const roles = Object.freeze({
    controller: normalizeObservedRole(raw.roles.controller, `observations[${index}].roles.controller`, plan.roles.controller),
    feeCollector: normalizeObservedRole(
      raw.roles.feeCollector,
      `observations[${index}].roles.feeCollector`,
      plan.roles.feeCollector,
    ),
    guardian: normalizeObservedRole(raw.roles.guardian, `observations[${index}].roles.guardian`, plan.roles.guardian),
  });
  const bit = normalizeObservedBit(raw.bit, plan.bit);
  if (!Array.isArray(raw.deploymentTargets) || raw.deploymentTargets.length !== plan.deploymentTargets.length) {
    throw new Error(`observations[${index}] deployment target set is invalid`);
  }
  const deploymentTargets = raw.deploymentTargets.map((target, targetIndex) => {
    exactKeys(target, DEPLOYMENT_TARGET_FIELDS, `observations[${index}].deploymentTargets[${targetIndex}]`);
    const normalizedTarget = Object.freeze({
      name: String(target.name ?? ""),
      address: address(target.address, `observations[${index}].deploymentTargets[${targetIndex}].address`),
      codeEmpty: target.codeEmpty,
    });
    if (canonical(normalizedTarget) !== canonical(plan.deploymentTargets[targetIndex])) {
      throw new Error(`observations[${index}] predicted deployment target is occupied or changed`);
    }
    return normalizedTarget;
  });
  const normalized = Object.freeze({
    schema: raw.schema,
    evidenceStatus: raw.evidenceStatus,
    observedAt: observedAt.raw,
    providerLabel,
    providerIdentity,
    sourceCommit: raw.sourceCommit,
    chainId: plan.chainId,
    planDigest: plan.planDigest,
    inputDigest: plan.inputDigest,
    anchorBlock,
    stateAnchor: Object.freeze({ blockHash: anchorBlock.hash, requireCanonical: true }),
    deployer,
    deploymentTargets: Object.freeze(deploymentTargets),
    roles,
    bit,
  });
  if (canonical(normalized) !== canonical(raw)) throw new Error(`observations[${index}] is not canonical`);
  return normalized;
}

function normalizeAttestation(raw, index) {
  exactKeys(raw, ["approverId", "role", "signature", "signer"], `attestations[${index}]`);
  if (!APPROVER_ROLES.includes(raw.role)) throw new TypeError(`attestations[${index}].role is invalid`);
  if (!isHexString(raw.signature) || ![64, 65].includes((raw.signature.length - 2) / 2)) {
    throw new TypeError(`attestations[${index}].signature is invalid`);
  }
  return Object.freeze({
    role: raw.role,
    approverId: digest(raw.approverId, `attestations[${index}].approverId`),
    signer: address(raw.signer, `attestations[${index}].signer`),
    signature: raw.signature,
  });
}

export function closedTestnetDeploymentPreflightDomain({ chainId, verifyingContract }) {
  return Object.freeze({
    name: "TreeSwap Closed Testnet Deployment Preflight",
    version: "1",
    chainId: BigInt(decimal(chainId, "domain.chainId", { positive: true })),
    verifyingContract: address(verifyingContract, "domain.verifyingContract"),
  });
}

function normalizeInputs({ plan: rawPlan, policy: rawPolicy, record: rawRecord, observations: rawObservations }) {
  const plan = normalizePlan(rawPlan);
  const policy = normalizePolicy(rawPolicy, plan);
  const record = normalizeRecord(rawRecord, policy, plan);
  if (!Array.isArray(rawObservations) || rawObservations.length !== record.providerObservations.length) {
    throw new Error("preflight requires the exact provider observation set");
  }
  const observations = rawObservations.map((value, index) => normalizeObservation(value, index, record, policy, plan));
  requireCanonicalOrder(observations, (value) => value.providerIdentity, "preflight observations");
  if (new Set(observations.map((value) => value.providerLabel)).size !== observations.length) {
    throw new Error("preflight provider labels must be distinct");
  }
  for (const [index, observation] of observations.entries()) {
    const reference = record.providerObservations[index];
    if (observation.providerIdentity !== reference.providerIdentity || hash(observation) !== reference.observationDigest) {
      throw new Error("preflight observation does not match the signed record");
    }
    if (index > 0) {
      for (const field of ["chainId", "planDigest", "inputDigest"]) {
        if (observation[field] !== observations[0][field]) throw new Error(`preflight observations disagree on ${field}`);
      }
      for (const field of ["anchorBlock", "stateAnchor", "deployer", "deploymentTargets", "roles", "bit"]) {
        if (canonical(observation[field]) !== canonical(observations[0][field])) {
          throw new Error(`preflight observations disagree on ${field}`);
        }
      }
    }
  }
  assertClosedTestnetDeploymentPreflightIsSecretFree({ plan: rawPlan, policy, record, observations });
  return Object.freeze({ plan, policy, record, observations: Object.freeze(observations) });
}

function approvalValue(normalized, role, approverId) {
  return Object.freeze({
    preflightId: normalized.record.preflightId,
    recordDigest: hash(normalized.record),
    policyDigest: hash(normalized.policy),
    role,
    approverId,
    planDigest: normalized.plan.planDigest,
    inputDigest: normalized.plan.inputDigest,
    anchorBlockNumber: normalized.record.anchorBlockNumber,
    anchorBlockHash: normalized.record.anchorBlockHash,
    deployer: normalized.plan.deployer,
    startingNonce: normalized.plan.startingNonce,
  });
}

export function buildClosedTestnetDeploymentPreflightRecord({
  plan: rawPlan,
  policy: rawPolicy,
  observations,
  preflightId,
  preparedAt = Math.floor(Date.now() / 1_000),
}) {
  const plan = normalizePlan(rawPlan);
  const policy = normalizePolicy(rawPolicy, plan);
  const timestamp = safeInteger(preparedAt, "preparedAt", { positive: true });
  if (!Array.isArray(observations) || observations.length < policy.minimumProviderCount || observations.length > 5) {
    throw new Error("preflight record requires the bounded provider quorum");
  }
  const first = observations[0];
  if (!first || typeof first !== "object") throw new TypeError("preflight observation is invalid");
  const providerObservations = observations.map((observation, index) => Object.freeze({
    providerIdentity: digest(observation?.providerIdentity, `observations[${index}].providerIdentity`),
    observationDigest: hash(observation),
  }));
  requireCanonicalOrder(providerObservations, (value) => value.providerIdentity, "provider observations");
  const record = Object.freeze({
    schema: "treeswap.closed-testnet-deployment-preflight-record.v1",
    preflightId: digest(preflightId, "preflightId"),
    environment: policy.environment,
    chainId: policy.chainId,
    verifyingContract: policy.verifyingContract,
    reviewedBuildCommit: policy.reviewedBuildCommit,
    independentReviewDigest: policy.independentReviewDigest,
    inputDigest: policy.inputDigest,
    planDigest: policy.planDigest,
    deployer: plan.deployer,
    startingNonce: plan.startingNonce,
    anchorBlockNumber: decimal(first.anchorBlock?.number, "anchorBlockNumber", { positive: true }),
    anchorBlockHash: digest(first.anchorBlock?.hash, "anchorBlockHash"),
    providerObservations: Object.freeze(providerObservations),
    preparedAt: timestamp,
    validUntil: timestamp + policy.maximumPreflightLifetimeSeconds,
  });
  return normalizeInputs({ plan: rawPlan, policy: rawPolicy, record, observations }).record;
}

export function buildClosedTestnetDeploymentPreflightApprovalMessage({
  plan,
  policy,
  record,
  observations,
  role,
  approverId,
}) {
  const normalized = normalizeInputs({ plan, policy, record, observations });
  if (!APPROVER_ROLES.includes(role)) throw new TypeError("preflight approval role is invalid");
  const normalizedApproverId = digest(approverId, "preflight approverId");
  if (!normalized.policy.approvers.some((value) => value.role === role && value.approverId === normalizedApproverId)) {
    throw new Error("preflight approver is not in policy");
  }
  return Object.freeze({
    domain: closedTestnetDeploymentPreflightDomain(normalized.record),
    types: CLOSED_TESTNET_DEPLOYMENT_PREFLIGHT_APPROVAL_TYPES,
    value: approvalValue(normalized, role, normalizedApproverId),
  });
}

export function assertClosedTestnetDeploymentPreflightIsSecretFree(value) {
  const forbiddenKey = /(email|invoice|macaroon|mnemonic|password|preimage|private.?key|rpc.?url|seed)/i;
  const visit = (entry) => {
    if (Array.isArray(entry)) {
      for (const item of entry) visit(item);
      return;
    }
    if (!entry || typeof entry !== "object") {
      if (typeof entry === "string"
          && (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(entry)
            || /ln(?:bc|bcrt|tb)[0-9a-z]{20,}/i.test(entry)
            || /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(entry)
            || /https?:\/\//i.test(entry))) {
        throw new Error("deployment preflight contains secret or endpoint material");
      }
      return;
    }
    for (const [key, item] of Object.entries(entry)) {
      if (forbiddenKey.test(key)) throw new Error(`deployment preflight contains forbidden field ${key}`);
      visit(item);
    }
  };
  visit(value);
  return true;
}

export function verifyClosedTestnetDeploymentPreflight({
  plan,
  policy,
  record,
  observations,
  attestations,
  now = Math.floor(Date.now() / 1_000),
}) {
  const normalized = normalizeInputs({ plan, policy, record, observations });
  const observedAt = safeInteger(now, "now", { positive: true });
  if (normalized.record.preparedAt > observedAt) throw new Error("deployment preflight is future-dated");
  if (normalized.record.validUntil < observedAt) throw new Error("deployment preflight is expired");
  if (!Array.isArray(attestations) || attestations.length > 6) {
    throw new TypeError("preflight attestations must be a bounded array");
  }
  const normalizedAttestations = attestations.map(normalizeAttestation);
  requireCanonicalOrder(
    normalizedAttestations,
    (value) => `${value.role}:${value.approverId}`,
    "preflight attestations",
  );
  if (normalizedAttestations.length !== normalized.policy.approvers.length) {
    throw new Error("every preflight approver must attest exactly once");
  }
  const domain = closedTestnetDeploymentPreflightDomain(normalized.record);
  const seen = new Set();
  for (const attestation of normalizedAttestations) {
    const key = `${attestation.role}:${attestation.approverId}`;
    if (seen.has(key)) throw new Error("preflight attestation is duplicated");
    seen.add(key);
    const approver = normalized.policy.approvers.find((value) => (
      value.role === attestation.role && value.approverId === attestation.approverId
    ));
    if (!approver || approver.signer !== attestation.signer) {
      throw new Error("preflight attestation does not match an approver");
    }
    const recovered = verifyTypedData(
      domain,
      CLOSED_TESTNET_DEPLOYMENT_PREFLIGHT_APPROVAL_TYPES,
      approvalValue(normalized, attestation.role, attestation.approverId),
      attestation.signature,
    );
    if (recovered !== approver.signer) throw new Error("preflight attestation signature is invalid");
  }
  assertClosedTestnetDeploymentPreflightIsSecretFree({ ...normalized, attestations: normalizedAttestations });
  const result = Object.freeze({
    schema: "treeswap.verified-closed-testnet-deployment-preflight.v1",
    status: "cryptographically-verified-closed-testnet-deployment-preflight",
    scope: "fresh-plan-preflight-only-no-signing-broadcast-gate-opening-or-funding-authorization",
    recordDigest: hash(normalized.record),
    policyDigest: hash(normalized.policy),
    planDigest: normalized.plan.planDigest,
    inputDigest: normalized.plan.inputDigest,
    sourceCommit: normalized.plan.reviewedBuildCommit,
    anchorBlockNumber: normalized.record.anchorBlockNumber,
    anchorBlockHash: normalized.record.anchorBlockHash,
    deployer: normalized.plan.deployer,
    startingNonce: normalized.plan.startingNonce,
    validUntil: normalized.record.validUntil,
    providerCount: normalized.observations.length,
    signingAuthorization: false,
    broadcastAuthorization: false,
    gateOpeningAuthorization: false,
    fundingAuthorization: false,
  });
  verifiedPreflights.add(result);
  return result;
}

export function buildClosedTestnetDeploymentPreflightSummary(verification) {
  if (!verifiedPreflights.has(verification)) throw new Error("deployment preflight provenance is invalid");
  return Object.freeze({
    schema: "treeswap.closed-testnet-deployment-preflight-summary.v1",
    status: verification.status,
    recordDigest: verification.recordDigest,
    policyDigest: verification.policyDigest,
    planDigest: verification.planDigest,
    inputDigest: verification.inputDigest,
    sourceCommit: verification.sourceCommit,
    anchorBlockNumber: verification.anchorBlockNumber,
    anchorBlockHash: verification.anchorBlockHash,
    deployer: verification.deployer,
    startingNonce: verification.startingNonce,
    providerCount: verification.providerCount,
    validUntil: verification.validUntil,
    scope: verification.scope,
    signingAuthorization: false,
    broadcastAuthorization: false,
    gateOpeningAuthorization: false,
    fundingAuthorization: false,
  });
}

export function closedTestnetDeploymentPreflightValueDigest(value) {
  return hash(value);
}
