import {
  getAddress,
  isHexString,
  keccak256,
  toUtf8Bytes,
  verifyTypedData,
} from "ethers";
import { EIP1967_IMPLEMENTATION_SLOT } from "./bit-deployment-observer.mjs";
import {
  assertClosedTestnetDeploymentPreflightIsSecretFree,
  buildClosedTestnetDeploymentPreflightSummary,
  verifyClosedTestnetDeploymentPreflight,
} from "./closed-testnet-deployment-preflight.mjs";
import {
  assertExactDeploymentManifestShape,
  validateDeploymentManifest,
} from "./deployment-policy.mjs";

const BYTES32 = /^0x[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const DECIMAL = /^(?:0|[1-9][0-9]{0,77})$/;
const ZERO_DIGEST = `0x${"00".repeat(32)}`;
const UINT64_MAX = (1n << 64n) - 1n;
const APPROVER_ROLES = Object.freeze(["contract-reviewer", "operations-reviewer", "provider"]);

const POLICY_FIELDS = Object.freeze([
  "approvers",
  "chainId",
  "deploymentPolicyDigest",
  "environment",
  "independentReviewDigest",
  "inputDigest",
  "maximumObservationAgeSeconds",
  "maximumPostflightLifetimeSeconds",
  "minimumProviderCount",
  "planDigest",
  "preflightPolicyDigest",
  "preflightRecordDigest",
  "reviewedBuildCommit",
  "schema",
  "verifyingContract",
]);
const RECORD_FIELDS = Object.freeze([
  "chainId",
  "deploymentPolicyDigest",
  "environment",
  "finalizedBlockHash",
  "finalizedBlockNumber",
  "independentReviewDigest",
  "inputDigest",
  "manifestDigest",
  "planDigest",
  "postflightId",
  "preparedAt",
  "preflightPolicyDigest",
  "preflightRecordDigest",
  "providerObservations",
  "reviewedBuildCommit",
  "schema",
  "validUntil",
  "verifyingContract",
]);
const OBSERVATION_FIELDS = Object.freeze([
  "chainId",
  "controllerActions",
  "deployer",
  "deploymentPolicyDigest",
  "deployments",
  "evidenceStatus",
  "finalizedBlock",
  "independentReviewDigest",
  "inputDigest",
  "manifest",
  "manifestDigest",
  "observedAt",
  "planDigest",
  "preflightAnchor",
  "preflightPolicyDigest",
  "preflightRecordDigest",
  "providerFinalizedHead",
  "providerIdentity",
  "providerLabel",
  "reviewedBuildCommit",
  "schema",
  "stateAnchor",
]);
const RECEIPT_FIELDS = Object.freeze([
  "blockHash",
  "blockNumber",
  "blockTimestamp",
  "status",
  "transactionIndex",
]);
const DEPLOYMENT_FIELDS = Object.freeze([
  "dataHash",
  "expectedContractAddress",
  "from",
  "kind",
  "name",
  "nonce",
  "receipt",
  "to",
  "transactionHash",
  "valueWei",
]);
const CONTROLLER_ACTION_FIELDS = Object.freeze([
  "actionDigest",
  "dataHash",
  "name",
  "operation",
  "receipt",
  "safeAddress",
  "safeExecutionSuccess",
  "to",
  "transactionHash",
  "valueWei",
]);
const DEPLOYMENT_POLICY_FIELDS = Object.freeze([
  "absoluteMaxFeeBps",
  "absoluteMaxPriceDeviationBps",
  "bitImplementationAddress",
  "bitProxyAddress",
  "chainId",
  "codeHashes",
  "independentReviewDigest",
  "maxOpenDurationSeconds",
  "minResumeDelaySeconds",
  "referenceSatsPerBit",
  "reviewedBuildCommit",
]);
const CODE_HASH_FIELDS = Object.freeze([
  "bitImplementation",
  "bitProxy",
  "controller",
  "feeCollector",
  "gate",
  "guardian",
  "paymentHashRegistry",
  "userEscrow",
  "vault",
]);
const PREFLIGHT_BUNDLE_FIELDS = Object.freeze([
  "attestations",
  "observations",
  "plan",
  "policy",
  "record",
]);

const verifiedPostflights = new WeakSet();

export const CLOSED_TESTNET_DEPLOYMENT_POSTFLIGHT_APPROVAL_TYPES = Object.freeze({
  DeploymentPostflightApproval: Object.freeze([
    Object.freeze({ name: "postflightId", type: "bytes32" }),
    Object.freeze({ name: "recordDigest", type: "bytes32" }),
    Object.freeze({ name: "policyDigest", type: "bytes32" }),
    Object.freeze({ name: "role", type: "string" }),
    Object.freeze({ name: "approverId", type: "bytes32" }),
    Object.freeze({ name: "planDigest", type: "bytes32" }),
    Object.freeze({ name: "preflightRecordDigest", type: "bytes32" }),
    Object.freeze({ name: "finalizedBlockNumber", type: "uint64" }),
    Object.freeze({ name: "finalizedBlockHash", type: "bytes32" }),
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
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function canonicalEqual(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function hash(value) {
  return keccak256(toUtf8Bytes(JSON.stringify(canonical(value)))).toLowerCase();
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

function decimal(value, name, { maximum = null, positive = false } = {}) {
  const normalized = String(value ?? "");
  if (!DECIMAL.test(normalized)) throw new TypeError(`${name} must be a canonical decimal string`);
  const parsed = BigInt(normalized);
  if ((positive && parsed === 0n) || (maximum !== null && parsed > maximum)) {
    throw new RangeError(`${name} is outside policy`);
  }
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

function normalizeDeploymentPolicy(raw) {
  exactKeys(raw, DEPLOYMENT_POLICY_FIELDS, "deployment policy");
  exactKeys(raw.codeHashes, CODE_HASH_FIELDS, "deployment policy codeHashes");
  return Object.freeze(canonical(raw));
}

function normalizeReceipt(raw, name) {
  exactKeys(raw, RECEIPT_FIELDS, name);
  return Object.freeze({
    blockNumber: decimal(raw.blockNumber, `${name}.blockNumber`, { maximum: UINT64_MAX, positive: true }),
    blockHash: digest(raw.blockHash, `${name}.blockHash`),
    blockTimestamp: safeInteger(raw.blockTimestamp, `${name}.blockTimestamp`, { positive: true }),
    transactionIndex: decimal(raw.transactionIndex, `${name}.transactionIndex`, { maximum: UINT64_MAX }),
    status: decimal(raw.status, `${name}.status`, { maximum: 1n }),
  });
}

function position(receipt) {
  return (BigInt(receipt.blockNumber) << 64n) + BigInt(receipt.transactionIndex);
}

function normalizePlan(raw) {
  if (!raw || raw.schema !== "treeswap.closed-testnet-deployment-plan.v1"
      || raw.environment !== "public-testnet"
      || raw.scope !== "unsigned-public-testnet-plan-no-signing-broadcast-or-funding-authorization"
      || raw.network?.chainId !== "11155111" || raw.network?.name !== "sepolia"
      || raw.network?.mainnetAssets !== false || Object.values(raw.permissions ?? {}).some((value) => value !== false)) {
    throw new TypeError("postflight requires the exact unsigned Sepolia deployment plan");
  }
  const { planDigest, ...body } = raw;
  if (hash(body) !== digest(planDigest, "planDigest")) throw new Error("deployment plan digest is invalid");
  if (!COMMIT.test(String(raw.source?.reviewedBuildCommit ?? ""))) throw new TypeError("plan source commit is invalid");
  if (!Array.isArray(raw.deploymentTransactions) || raw.deploymentTransactions.length !== 4
      || !Array.isArray(raw.controllerSafeActions) || raw.controllerSafeActions.length !== 3) {
    throw new Error("deployment plan execution sequence is invalid");
  }
  const deployer = address(raw.deployer?.address, "plan deployer");
  const startingNonce = decimal(raw.deployer?.startingNonce, "plan starting nonce", { maximum: UINT64_MAX });
  const deploymentNames = ["gate", "paymentHashRegistry", "vault", "userEscrow"];
  const deployments = raw.deploymentTransactions.map((transaction, index) => {
    if (!transaction || transaction.kind !== "unsigned-contract-creation"
        || transaction.name !== deploymentNames[index] || transaction.chainId !== raw.network.chainId
        || address(transaction.from, `deploymentTransactions[${index}].from`) !== deployer
        || transaction.to !== null || transaction.valueWei !== "0"
        || decimal(transaction.nonce, `deploymentTransactions[${index}].nonce`, { maximum: UINT64_MAX })
          !== String(BigInt(startingNonce) + BigInt(index))
        || !isHexString(transaction.data) || keccak256(transaction.data).toLowerCase() !== transaction.initCodeHash) {
      throw new Error("deployment plan transaction sequence is invalid");
    }
    return Object.freeze({
      kind: transaction.kind,
      name: transaction.name,
      from: deployer,
      to: null,
      nonce: transaction.nonce,
      valueWei: "0",
      dataHash: transaction.initCodeHash,
      expectedContractAddress: address(transaction.expectedContractAddress, `${transaction.name} address`),
    });
  });
  const actionNames = ["register-vault", "register-user-escrow", "seal-registry"];
  const actions = raw.controllerSafeActions.map((action, index) => {
    if (!action || action.kind !== "unsigned-controller-safe-call" || action.name !== actionNames[index]
        || action.sequence !== index || action.valueWei !== "0" || action.operation !== "CALL"
        || address(action.safeAddress, `controllerSafeActions[${index}].safeAddress`)
          !== address(raw.roles?.controller?.address, "controller address")
        || !isHexString(action.data) || keccak256(action.data).toLowerCase() !== action.dataHash) {
      throw new Error("deployment plan controller action sequence is invalid");
    }
    return Object.freeze({
      name: action.name,
      safeAddress: address(action.safeAddress, `${action.name} safe`),
      to: address(action.to, `${action.name} target`),
      valueWei: "0",
      operation: "CALL",
      dataHash: digest(action.dataHash, `${action.name} dataHash`),
      actionDigest: digest(action.actionDigest, `${action.name} actionDigest`),
    });
  });
  if (new Set(deployments.map((value) => value.expectedContractAddress.toLowerCase())).size !== 4) {
    throw new Error("deployment plan contract addresses are duplicated");
  }
  return Object.freeze({
    raw,
    planDigest: String(planDigest).toLowerCase(),
    inputDigest: digest(raw.inputDigest, "plan inputDigest"),
    chainId: raw.network.chainId,
    reviewedBuildCommit: raw.source.reviewedBuildCommit,
    independentReviewDigest: digest(raw.source.independentReviewDigest, "plan independentReviewDigest"),
    deployer,
    startingNonce,
    deployments: Object.freeze(deployments),
    actions: Object.freeze(actions),
    addresses: Object.freeze({
      bitProxy: address(raw.bit?.proxyAddress, "BIT proxy"),
      controller: address(raw.roles?.controller?.address, "controller"),
      feeCollector: address(raw.roles?.feeCollector?.address, "fee collector"),
      gate: deployments[0].expectedContractAddress,
      guardian: address(raw.roles?.guardian?.address, "guardian"),
      paymentHashRegistry: deployments[1].expectedContractAddress,
      vault: deployments[2].expectedContractAddress,
      userEscrow: deployments[3].expectedContractAddress,
    }),
  });
}

function verifyPreflight(raw) {
  exactKeys(raw, PREFLIGHT_BUNDLE_FIELDS, "deployment preflight bundle");
  const plan = normalizePlan(raw.plan);
  const preparedAt = safeInteger(raw.record?.preparedAt, "preflight preparedAt", { positive: true });
  const verification = verifyClosedTestnetDeploymentPreflight({
    plan: raw.plan,
    policy: raw.policy,
    record: raw.record,
    observations: raw.observations,
    attestations: raw.attestations,
    now: preparedAt,
  });
  const summary = buildClosedTestnetDeploymentPreflightSummary(verification);
  if (summary.planDigest !== plan.planDigest || summary.inputDigest !== plan.inputDigest) {
    throw new Error("verified preflight does not match the deployment plan");
  }
  assertClosedTestnetDeploymentPreflightIsSecretFree(raw);
  return Object.freeze({
    raw,
    plan,
    summary,
    anchorTimestamp: safeInteger(raw.observations?.[0]?.anchorBlock?.timestamp, "preflight anchor timestamp", {
      positive: true,
    }),
    preparedAt,
    validUntil: safeInteger(raw.record?.validUntil, "preflight validUntil", { positive: true }),
  });
}

export function normalizeClosedTestnetDeploymentPostflightContext({ preflight, deploymentPolicy }) {
  const normalizedPreflight = verifyPreflight(preflight);
  const normalizedDeploymentPolicy = normalizeDeploymentPolicy(deploymentPolicy);
  if (normalizedDeploymentPolicy.chainId !== Number(normalizedPreflight.plan.chainId)
      || normalizedDeploymentPolicy.reviewedBuildCommit !== normalizedPreflight.plan.reviewedBuildCommit
      || String(normalizedDeploymentPolicy.independentReviewDigest).toLowerCase()
        !== normalizedPreflight.plan.independentReviewDigest) {
    throw new Error("deployment policy does not match the signed deployment plan");
  }
  return Object.freeze({
    preflight: normalizedPreflight,
    deploymentPolicy: normalizedDeploymentPolicy,
    deploymentPolicyDigest: hash(normalizedDeploymentPolicy),
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

function preflightApprovers(context) {
  return context.preflight.raw.policy.approvers.map((value) => ({
    role: value.role,
    approverId: String(value.approverId).toLowerCase(),
    signer: address(value.signer, "preflight approver signer"),
  }));
}

function normalizePolicy(raw, context) {
  exactKeys(raw, POLICY_FIELDS, "deployment postflight policy");
  if (raw.schema !== "treeswap.closed-testnet-deployment-postflight-policy.v1"
      || raw.environment !== "public-testnet" || raw.chainId !== context.preflight.plan.chainId) {
    throw new TypeError("deployment postflight policy schema, environment, or chain is invalid");
  }
  const minimumProviderCount = safeInteger(raw.minimumProviderCount, "minimumProviderCount", { positive: true });
  const maximumObservationAgeSeconds = safeInteger(
    raw.maximumObservationAgeSeconds,
    "maximumObservationAgeSeconds",
    { positive: true },
  );
  const maximumPostflightLifetimeSeconds = safeInteger(
    raw.maximumPostflightLifetimeSeconds,
    "maximumPostflightLifetimeSeconds",
    { positive: true },
  );
  if (minimumProviderCount < 2 || minimumProviderCount > 5) {
    throw new Error("postflight policy must require two to five providers");
  }
  if (maximumObservationAgeSeconds > 3_600) throw new Error("postflight observations may not be older than one hour");
  if (maximumPostflightLifetimeSeconds > 86_400) throw new Error("deployment postflight may not remain valid over one day");
  if (!Array.isArray(raw.approvers) || raw.approvers.length > 7) {
    throw new TypeError("postflight approvers must be a bounded array");
  }
  const approvers = raw.approvers.map(normalizeApprover);
  requireCanonicalOrder(approvers, (value) => `${value.role}:${value.approverId}`, "postflight approvers");
  const ids = new Set();
  const signers = new Set();
  const counts = new Map(APPROVER_ROLES.map((role) => [role, 0]));
  for (const approver of approvers) {
    if (ids.has(approver.approverId)) throw new Error("postflight approver identities must be globally distinct");
    ids.add(approver.approverId);
    const signer = approver.signer.toLowerCase();
    if (signers.has(signer)) throw new Error("postflight approver signers must be globally distinct");
    signers.add(signer);
    counts.set(approver.role, counts.get(approver.role) + 1);
  }
  if (counts.get("provider") !== minimumProviderCount
      || counts.get("contract-reviewer") !== 1 || counts.get("operations-reviewer") !== 1) {
    throw new Error("postflight requires its provider quorum and exactly one contract and operations reviewer");
  }
  const requiredPrior = preflightApprovers(context)
    .filter((value) => value.role === "provider" || value.role === "operations-reviewer")
    .sort((left, right) => `${left.role}:${left.approverId}`.localeCompare(`${right.role}:${right.approverId}`));
  const retained = approvers
    .filter((value) => value.role === "provider" || value.role === "operations-reviewer")
    .sort((left, right) => `${left.role}:${left.approverId}`.localeCompare(`${right.role}:${right.approverId}`));
  if (!canonicalEqual(requiredPrior, retained)) {
    throw new Error("postflight must retain the exact preflight provider and operations approvers");
  }
  const normalized = Object.freeze({
    schema: raw.schema,
    environment: raw.environment,
    chainId: raw.chainId,
    verifyingContract: address(raw.verifyingContract, "postflight verifyingContract"),
    reviewedBuildCommit: String(raw.reviewedBuildCommit ?? ""),
    independentReviewDigest: digest(raw.independentReviewDigest, "policy independentReviewDigest"),
    inputDigest: digest(raw.inputDigest, "policy inputDigest"),
    planDigest: digest(raw.planDigest, "policy planDigest"),
    preflightPolicyDigest: digest(raw.preflightPolicyDigest, "policy preflightPolicyDigest"),
    preflightRecordDigest: digest(raw.preflightRecordDigest, "policy preflightRecordDigest"),
    deploymentPolicyDigest: digest(raw.deploymentPolicyDigest, "policy deploymentPolicyDigest"),
    minimumProviderCount,
    maximumObservationAgeSeconds,
    maximumPostflightLifetimeSeconds,
    approvers: Object.freeze(approvers),
  });
  const expected = {
    verifyingContract: context.preflight.plan.addresses.gate,
    reviewedBuildCommit: context.preflight.plan.reviewedBuildCommit,
    independentReviewDigest: context.preflight.plan.independentReviewDigest,
    inputDigest: context.preflight.plan.inputDigest,
    planDigest: context.preflight.plan.planDigest,
    preflightPolicyDigest: context.preflight.summary.policyDigest,
    preflightRecordDigest: context.preflight.summary.recordDigest,
    deploymentPolicyDigest: context.deploymentPolicyDigest,
  };
  for (const [field, value] of Object.entries(expected)) {
    if (normalized[field] !== value) throw new Error(`postflight policy ${field} does not match its evidence`);
  }
  return normalized;
}

function normalizeProviderReference(raw, index) {
  exactKeys(raw, ["observationDigest", "providerIdentity"], `providerObservations[${index}]`);
  return Object.freeze({
    providerIdentity: digest(raw.providerIdentity, `providerObservations[${index}].providerIdentity`),
    observationDigest: digest(raw.observationDigest, `providerObservations[${index}].observationDigest`),
  });
}

function normalizeRecord(raw, policy, context) {
  exactKeys(raw, RECORD_FIELDS, "deployment postflight record");
  if (raw.schema !== "treeswap.closed-testnet-deployment-postflight-record.v1"
      || raw.environment !== policy.environment || raw.chainId !== policy.chainId) {
    throw new TypeError("deployment postflight record schema, environment, or chain is invalid");
  }
  const preparedAt = safeInteger(raw.preparedAt, "postflight preparedAt", { positive: true });
  const validUntil = safeInteger(raw.validUntil, "postflight validUntil", { positive: true });
  if (validUntil <= preparedAt || validUntil - preparedAt > policy.maximumPostflightLifetimeSeconds) {
    throw new Error("postflight validity is reversed or exceeds policy");
  }
  if (!Array.isArray(raw.providerObservations)) throw new TypeError("postflight provider observations are required");
  const providerObservations = raw.providerObservations.map(normalizeProviderReference);
  requireCanonicalOrder(providerObservations, (value) => value.providerIdentity, "postflight provider observations");
  if (providerObservations.length !== policy.minimumProviderCount
      || new Set(providerObservations.map((value) => value.providerIdentity)).size !== providerObservations.length
      || new Set(providerObservations.map((value) => value.observationDigest)).size !== providerObservations.length) {
    throw new Error("postflight provider observation quorum is invalid");
  }
  const normalized = Object.freeze({
    schema: raw.schema,
    postflightId: digest(raw.postflightId, "postflightId"),
    environment: raw.environment,
    chainId: raw.chainId,
    verifyingContract: address(raw.verifyingContract, "record verifyingContract"),
    reviewedBuildCommit: String(raw.reviewedBuildCommit ?? ""),
    independentReviewDigest: digest(raw.independentReviewDigest, "record independentReviewDigest"),
    inputDigest: digest(raw.inputDigest, "record inputDigest"),
    planDigest: digest(raw.planDigest, "record planDigest"),
    preflightPolicyDigest: digest(raw.preflightPolicyDigest, "record preflightPolicyDigest"),
    preflightRecordDigest: digest(raw.preflightRecordDigest, "record preflightRecordDigest"),
    deploymentPolicyDigest: digest(raw.deploymentPolicyDigest, "record deploymentPolicyDigest"),
    manifestDigest: digest(raw.manifestDigest, "record manifestDigest"),
    finalizedBlockNumber: decimal(raw.finalizedBlockNumber, "record finalizedBlockNumber", {
      maximum: UINT64_MAX,
      positive: true,
    }),
    finalizedBlockHash: digest(raw.finalizedBlockHash, "record finalizedBlockHash"),
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
    "preflightPolicyDigest",
    "preflightRecordDigest",
    "deploymentPolicyDigest",
  ]) {
    if (normalized[field] !== policy[field]) throw new Error(`postflight record ${field} does not match policy`);
  }
  if (normalized.planDigest !== context.preflight.plan.planDigest) throw new Error("postflight record plan is invalid");
  return normalized;
}

function normalizeObservation(raw, index, record, policy, context) {
  const name = `observations[${index}]`;
  exactKeys(raw, OBSERVATION_FIELDS, name);
  if (raw.schema !== "treeswap.closed-testnet-deployment-postflight-observation.v1"
      || raw.evidenceStatus !== "unreviewed-finalized-deployment-execution") {
    throw new TypeError(`${name} schema or status is invalid`);
  }
  const providerIdentity = digest(raw.providerIdentity, `${name}.providerIdentity`);
  const providerLabel = String(raw.providerLabel ?? "");
  if (providerLabel.length === 0 || providerLabel.length > 80) throw new TypeError(`${name}.providerLabel is invalid`);
  const observedAt = canonicalIso(raw.observedAt, `${name}.observedAt`);
  if (observedAt.seconds > record.preparedAt || record.preparedAt - observedAt.seconds > policy.maximumObservationAgeSeconds) {
    throw new Error(`${name} is future-dated or stale`);
  }
  exactKeys(raw.providerFinalizedHead, ["hash", "number"], `${name}.providerFinalizedHead`);
  exactKeys(raw.finalizedBlock, ["hash", "number", "timestamp"], `${name}.finalizedBlock`);
  exactKeys(raw.stateAnchor, ["blockHash", "requireCanonical"], `${name}.stateAnchor`);
  const finalizedBlock = Object.freeze({
    number: decimal(raw.finalizedBlock.number, `${name}.finalizedBlock.number`, {
      maximum: UINT64_MAX,
      positive: true,
    }),
    hash: digest(raw.finalizedBlock.hash, `${name}.finalizedBlock.hash`),
    timestamp: safeInteger(raw.finalizedBlock.timestamp, `${name}.finalizedBlock.timestamp`, { positive: true }),
  });
  const providerFinalizedHead = Object.freeze({
    number: decimal(raw.providerFinalizedHead.number, `${name}.providerFinalizedHead.number`, {
      maximum: UINT64_MAX,
      positive: true,
    }),
    hash: digest(raw.providerFinalizedHead.hash, `${name}.providerFinalizedHead.hash`),
  });
  exactKeys(raw.preflightAnchor, ["hash", "number", "timestamp"], `${name}.preflightAnchor`);
  const preflightAnchor = Object.freeze({
    number: decimal(raw.preflightAnchor.number, `${name}.preflightAnchor.number`, {
      maximum: UINT64_MAX,
      positive: true,
    }),
    hash: digest(raw.preflightAnchor.hash, `${name}.preflightAnchor.hash`),
    timestamp: safeInteger(raw.preflightAnchor.timestamp, `${name}.preflightAnchor.timestamp`, { positive: true }),
  });
  if (preflightAnchor.number !== String(context.preflight.raw.record.anchorBlockNumber)
      || preflightAnchor.hash !== String(context.preflight.raw.record.anchorBlockHash).toLowerCase()
      || preflightAnchor.timestamp !== context.preflight.anchorTimestamp) {
    throw new Error(`${name} did not re-prove the signed preflight anchor`);
  }
  if (BigInt(providerFinalizedHead.number) < BigInt(finalizedBlock.number)
      || raw.stateAnchor.requireCanonical !== true
      || digest(raw.stateAnchor.blockHash, `${name}.stateAnchor.blockHash`) !== finalizedBlock.hash
      || finalizedBlock.number !== record.finalizedBlockNumber || finalizedBlock.hash !== record.finalizedBlockHash
      || finalizedBlock.timestamp > observedAt.seconds + 15) {
    throw new Error(`${name} does not prove the exact canonical finalized block`);
  }
  exactKeys(raw.deployer, ["address", "anchoredNonce", "codeEmpty", "pendingNonceAfter", "pendingNonceBefore"], `${name}.deployer`);
  const expectedNonce = String(BigInt(context.preflight.plan.startingNonce) + 4n);
  const deployer = Object.freeze({
    address: address(raw.deployer.address, `${name}.deployer.address`),
    codeEmpty: raw.deployer.codeEmpty,
    anchoredNonce: decimal(raw.deployer.anchoredNonce, `${name}.deployer.anchoredNonce`, { maximum: UINT64_MAX }),
    pendingNonceBefore: decimal(raw.deployer.pendingNonceBefore, `${name}.deployer.pendingNonceBefore`, {
      maximum: UINT64_MAX,
    }),
    pendingNonceAfter: decimal(raw.deployer.pendingNonceAfter, `${name}.deployer.pendingNonceAfter`, {
      maximum: UINT64_MAX,
    }),
  });
  if (deployer.address !== context.preflight.plan.deployer || deployer.codeEmpty !== true
      || deployer.anchoredNonce !== expectedNonce || deployer.pendingNonceBefore !== expectedNonce
      || deployer.pendingNonceAfter !== expectedNonce) {
    throw new Error(`${name} deployer state does not prove the exact four-transaction sequence`);
  }
  if (!Array.isArray(raw.deployments) || raw.deployments.length !== 4) {
    throw new Error(`${name} deployment receipt sequence is invalid`);
  }
  const deployments = raw.deployments.map((value, receiptIndex) => {
    exactKeys(value, DEPLOYMENT_FIELDS, `${name}.deployments[${receiptIndex}]`);
    const expected = context.preflight.plan.deployments[receiptIndex];
    const normalized = Object.freeze({
      kind: value.kind,
      name: value.name,
      transactionHash: digest(value.transactionHash, `${name}.deployments[${receiptIndex}].transactionHash`),
      from: address(value.from, `${name}.deployments[${receiptIndex}].from`),
      to: value.to,
      nonce: decimal(value.nonce, `${name}.deployments[${receiptIndex}].nonce`, { maximum: UINT64_MAX }),
      valueWei: decimal(value.valueWei, `${name}.deployments[${receiptIndex}].valueWei`),
      dataHash: digest(value.dataHash, `${name}.deployments[${receiptIndex}].dataHash`),
      expectedContractAddress: address(
        value.expectedContractAddress,
        `${name}.deployments[${receiptIndex}].expectedContractAddress`,
      ),
      receipt: normalizeReceipt(value.receipt, `${name}.deployments[${receiptIndex}].receipt`),
    });
    for (const field of ["kind", "name", "from", "to", "nonce", "valueWei", "dataHash", "expectedContractAddress"]) {
      if (normalized[field] !== expected[field]) throw new Error(`${name} deployment receipt does not match the plan`);
    }
    if (normalized.receipt.status !== "1") throw new Error(`${name} deployment transaction did not succeed`);
    return normalized;
  });
  if (!Array.isArray(raw.controllerActions) || raw.controllerActions.length !== 3) {
    throw new Error(`${name} controller receipt sequence is invalid`);
  }
  const controllerActions = raw.controllerActions.map((value, receiptIndex) => {
    exactKeys(value, CONTROLLER_ACTION_FIELDS, `${name}.controllerActions[${receiptIndex}]`);
    const expected = context.preflight.plan.actions[receiptIndex];
    const normalized = Object.freeze({
      name: value.name,
      transactionHash: digest(value.transactionHash, `${name}.controllerActions[${receiptIndex}].transactionHash`),
      safeAddress: address(value.safeAddress, `${name}.controllerActions[${receiptIndex}].safeAddress`),
      to: address(value.to, `${name}.controllerActions[${receiptIndex}].to`),
      valueWei: decimal(value.valueWei, `${name}.controllerActions[${receiptIndex}].valueWei`),
      operation: value.operation,
      dataHash: digest(value.dataHash, `${name}.controllerActions[${receiptIndex}].dataHash`),
      actionDigest: digest(value.actionDigest, `${name}.controllerActions[${receiptIndex}].actionDigest`),
      safeExecutionSuccess: value.safeExecutionSuccess,
      receipt: normalizeReceipt(value.receipt, `${name}.controllerActions[${receiptIndex}].receipt`),
    });
    for (const field of ["name", "safeAddress", "to", "valueWei", "operation", "dataHash", "actionDigest"]) {
      if (normalized[field] !== expected[field]) throw new Error(`${name} controller receipt does not match the plan`);
    }
    if (normalized.safeExecutionSuccess !== true || normalized.receipt.status !== "1") {
      throw new Error(`${name} controller action did not succeed through the reviewed Safe`);
    }
    return normalized;
  });
  const sequence = [...deployments, ...controllerActions];
  if (new Set(sequence.map((value) => value.transactionHash)).size !== 7
      || sequence.some((value, sequenceIndex) => sequenceIndex > 0
        && position(value.receipt) <= position(sequence[sequenceIndex - 1].receipt))) {
    throw new Error(`${name} execution receipts are duplicated or out of order`);
  }
  for (const value of sequence) {
    if (value.receipt.blockTimestamp < context.preflight.anchorTimestamp
        || value.receipt.blockTimestamp > context.preflight.validUntil
        || BigInt(value.receipt.blockNumber) > BigInt(finalizedBlock.number)) {
      throw new Error(`${name} execution occurred outside the signed preflight or finalized window`);
    }
  }
  if (finalizedBlock.timestamp < sequence.at(-1).receipt.blockTimestamp) {
    throw new Error(`${name} finalized state predates its execution receipts`);
  }
  assertExactDeploymentManifestShape(raw.manifest);
  if (raw.manifest.bit.implementationSlot !== EIP1967_IMPLEMENTATION_SLOT) {
    throw new Error(`${name} manifest uses the wrong implementation slot`);
  }
  const manifestResult = validateDeploymentManifest(raw.manifest, context.deploymentPolicy);
  if (!manifestResult.approved) throw new Error(`${name} manifest is not approved: ${manifestResult.reasons.join("; ")}`);
  const manifestDigest = hash(raw.manifest);
  if (digest(raw.manifestDigest, `${name}.manifestDigest`) !== manifestDigest || manifestDigest !== record.manifestDigest) {
    throw new Error(`${name} manifest digest does not match the signed record`);
  }
  const expectedAddresses = context.preflight.plan.addresses;
  for (const [field, expected] of [
    ["controller", expectedAddresses.controller],
    ["guardian", expectedAddresses.guardian],
    ["feeCollector", expectedAddresses.feeCollector],
  ]) {
    if (address(raw.manifest[field].address, `${name}.manifest.${field}.address`) !== expected) {
      throw new Error(`${name} manifest role address does not match the deployment plan`);
    }
  }
  for (const [path, expected] of [
    ["gate", expectedAddresses.gate],
    ["paymentHashRegistry", expectedAddresses.paymentHashRegistry],
    ["vault", expectedAddresses.vault],
    ["userEscrow", expectedAddresses.userEscrow],
  ]) {
    if (address(raw.manifest[path].address, `${name}.manifest.${path}.address`) !== expected) {
      throw new Error(`${name} manifest contract address does not match the deployment plan`);
    }
  }
  const normalized = Object.freeze({
    schema: raw.schema,
    evidenceStatus: raw.evidenceStatus,
    observedAt: observedAt.raw,
    providerLabel,
    providerIdentity,
    reviewedBuildCommit: String(raw.reviewedBuildCommit ?? ""),
    independentReviewDigest: digest(raw.independentReviewDigest, `${name}.independentReviewDigest`),
    chainId: decimal(raw.chainId, `${name}.chainId`, { maximum: UINT64_MAX, positive: true }),
    inputDigest: digest(raw.inputDigest, `${name}.inputDigest`),
    planDigest: digest(raw.planDigest, `${name}.planDigest`),
    preflightPolicyDigest: digest(raw.preflightPolicyDigest, `${name}.preflightPolicyDigest`),
    preflightRecordDigest: digest(raw.preflightRecordDigest, `${name}.preflightRecordDigest`),
    deploymentPolicyDigest: digest(raw.deploymentPolicyDigest, `${name}.deploymentPolicyDigest`),
    preflightAnchor,
    providerFinalizedHead,
    finalizedBlock,
    stateAnchor: Object.freeze({ blockHash: finalizedBlock.hash, requireCanonical: true }),
    deployer,
    deployments: Object.freeze(deployments),
    controllerActions: Object.freeze(controllerActions),
    manifest: Object.freeze(canonical(raw.manifest)),
    manifestDigest,
  });
  const expectedBindings = {
    reviewedBuildCommit: context.preflight.plan.reviewedBuildCommit,
    independentReviewDigest: context.preflight.plan.independentReviewDigest,
    chainId: context.preflight.plan.chainId,
    inputDigest: context.preflight.plan.inputDigest,
    planDigest: context.preflight.plan.planDigest,
    preflightPolicyDigest: context.preflight.summary.policyDigest,
    preflightRecordDigest: context.preflight.summary.recordDigest,
    deploymentPolicyDigest: context.deploymentPolicyDigest,
  };
  for (const [field, value] of Object.entries(expectedBindings)) {
    if (normalized[field] !== value) throw new Error(`${name} ${field} is not bound to the signed deployment package`);
  }
  if (!canonicalEqual(normalized, raw)) throw new Error(`${name} is not canonical`);
  return normalized;
}

function normalizeInputs({ preflight, deploymentPolicy, policy: rawPolicy, record: rawRecord, observations: rawObservations }) {
  const context = normalizeClosedTestnetDeploymentPostflightContext({ preflight, deploymentPolicy });
  const policy = normalizePolicy(rawPolicy, context);
  const record = normalizeRecord(rawRecord, policy, context);
  if (!Array.isArray(rawObservations) || rawObservations.length !== policy.minimumProviderCount) {
    throw new Error("postflight requires the exact provider observation set");
  }
  const observations = rawObservations.map((value, index) => (
    normalizeObservation(value, index, record, policy, context)
  ));
  requireCanonicalOrder(observations, (value) => value.providerIdentity, "postflight observations");
  if (new Set(observations.map((value) => value.providerLabel)).size !== observations.length) {
    throw new Error("postflight provider labels must be distinct");
  }
  for (const [index, observation] of observations.entries()) {
    const reference = record.providerObservations[index];
    if (observation.providerIdentity !== reference.providerIdentity || hash(observation) !== reference.observationDigest) {
      throw new Error("postflight observation does not match the signed record");
    }
    if (index > 0) {
      for (const field of [
        "reviewedBuildCommit",
        "independentReviewDigest",
        "chainId",
        "inputDigest",
        "planDigest",
        "preflightPolicyDigest",
        "preflightRecordDigest",
        "deploymentPolicyDigest",
        "preflightAnchor",
        "finalizedBlock",
        "deployer",
        "deployments",
        "controllerActions",
        "manifest",
        "manifestDigest",
      ]) {
        if (!canonicalEqual(observation[field], observations[0][field])) {
          throw new Error(`postflight providers disagree on ${field}`);
        }
      }
    }
  }
  assertClosedTestnetDeploymentPostflightIsSecretFree({
    preflight,
    deploymentPolicy: context.deploymentPolicy,
    policy,
    record,
    observations,
  });
  return Object.freeze({ context, policy, record, observations: Object.freeze(observations) });
}

export function closedTestnetDeploymentPostflightDomain({ chainId, verifyingContract }) {
  return Object.freeze({
    name: "TreeSwap Closed Testnet Deployment Postflight",
    version: "1",
    chainId: BigInt(chainId),
    verifyingContract: address(verifyingContract, "postflight domain verifyingContract"),
  });
}

function approvalValue(normalized, role, approverId) {
  return Object.freeze({
    postflightId: normalized.record.postflightId,
    recordDigest: hash(normalized.record),
    policyDigest: hash(normalized.policy),
    role,
    approverId,
    planDigest: normalized.record.planDigest,
    preflightRecordDigest: normalized.record.preflightRecordDigest,
    finalizedBlockNumber: BigInt(normalized.record.finalizedBlockNumber),
    finalizedBlockHash: normalized.record.finalizedBlockHash,
  });
}

export function buildClosedTestnetDeploymentPostflightRecord({
  preflight,
  deploymentPolicy,
  policy: rawPolicy,
  observations,
  postflightId,
  preparedAt = Math.floor(Date.now() / 1_000),
}) {
  const context = normalizeClosedTestnetDeploymentPostflightContext({ preflight, deploymentPolicy });
  const policy = normalizePolicy(rawPolicy, context);
  if (!Array.isArray(observations) || observations.length !== policy.minimumProviderCount) {
    throw new Error("postflight record requires the exact provider quorum");
  }
  const first = observations[0];
  const providerObservations = observations.map((observation, index) => Object.freeze({
    providerIdentity: digest(observation?.providerIdentity, `observations[${index}].providerIdentity`),
    observationDigest: hash(observation),
  }));
  requireCanonicalOrder(providerObservations, (value) => value.providerIdentity, "postflight provider observations");
  const record = {
    schema: "treeswap.closed-testnet-deployment-postflight-record.v1",
    postflightId: digest(postflightId, "postflightId"),
    environment: policy.environment,
    chainId: policy.chainId,
    verifyingContract: policy.verifyingContract,
    reviewedBuildCommit: policy.reviewedBuildCommit,
    independentReviewDigest: policy.independentReviewDigest,
    inputDigest: policy.inputDigest,
    planDigest: policy.planDigest,
    preflightPolicyDigest: policy.preflightPolicyDigest,
    preflightRecordDigest: policy.preflightRecordDigest,
    deploymentPolicyDigest: policy.deploymentPolicyDigest,
    manifestDigest: digest(first?.manifestDigest, "observations[0].manifestDigest"),
    finalizedBlockNumber: decimal(first?.finalizedBlock?.number, "observations[0].finalizedBlock.number", {
      maximum: UINT64_MAX,
      positive: true,
    }),
    finalizedBlockHash: digest(first?.finalizedBlock?.hash, "observations[0].finalizedBlock.hash"),
    providerObservations,
    preparedAt: safeInteger(preparedAt, "preparedAt", { positive: true }),
    validUntil: safeInteger(preparedAt, "preparedAt", { positive: true }) + policy.maximumPostflightLifetimeSeconds,
  };
  return normalizeInputs({ preflight, deploymentPolicy, policy, record, observations }).record;
}

export function buildClosedTestnetDeploymentPostflightApprovalMessage({
  preflight,
  deploymentPolicy,
  policy,
  record,
  observations,
  role,
  approverId,
}) {
  const normalized = normalizeInputs({ preflight, deploymentPolicy, policy, record, observations });
  if (!APPROVER_ROLES.includes(role)) throw new TypeError("postflight approval role is invalid");
  const normalizedApproverId = digest(approverId, "postflight approverId");
  if (!normalized.policy.approvers.some((value) => value.role === role && value.approverId === normalizedApproverId)) {
    throw new Error("postflight approver is not in policy");
  }
  return Object.freeze({
    domain: closedTestnetDeploymentPostflightDomain(normalized.policy),
    types: CLOSED_TESTNET_DEPLOYMENT_POSTFLIGHT_APPROVAL_TYPES,
    value: approvalValue(normalized, role, normalizedApproverId),
  });
}

export function assertClosedTestnetDeploymentPostflightIsSecretFree(value) {
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
            || /https?:\/\//i.test(entry)
            || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(entry))) {
        throw new Error("deployment postflight contains secret or endpoint material");
      }
      return;
    }
    for (const [key, item] of Object.entries(entry)) {
      if (forbiddenKey.test(key)) throw new Error(`deployment postflight contains forbidden field ${key}`);
      visit(item);
    }
  };
  visit(value);
  return true;
}

export function verifyClosedTestnetDeploymentPostflight({
  preflight,
  deploymentPolicy,
  policy,
  record,
  observations,
  attestations,
  now = Math.floor(Date.now() / 1_000),
}) {
  const normalized = normalizeInputs({ preflight, deploymentPolicy, policy, record, observations });
  const observedAt = safeInteger(now, "verification time", { positive: true });
  if (normalized.record.preparedAt > observedAt) throw new Error("deployment postflight is future-dated");
  if (normalized.record.validUntil < observedAt) throw new Error("deployment postflight is expired");
  if (!Array.isArray(attestations) || attestations.length > 7) {
    throw new TypeError("postflight attestations must be a bounded array");
  }
  const normalizedAttestations = attestations.map((attestation, index) => {
    exactKeys(attestation, ["approverId", "role", "signature", "signer"], `attestations[${index}]`);
    return Object.freeze({
      role: attestation.role,
      approverId: digest(attestation.approverId, `attestations[${index}].approverId`),
      signer: address(attestation.signer, `attestations[${index}].signer`),
      signature: String(attestation.signature ?? ""),
    });
  });
  requireCanonicalOrder(normalizedAttestations, (value) => `${value.role}:${value.approverId}`, "postflight attestations");
  if (normalizedAttestations.length !== normalized.policy.approvers.length) {
    throw new Error("every postflight approver must attest exactly once");
  }
  const domain = closedTestnetDeploymentPostflightDomain(normalized.policy);
  const seen = new Set();
  for (const attestation of normalizedAttestations) {
    const key = `${attestation.role}:${attestation.approverId}`;
    if (seen.has(key)) throw new Error("postflight attestation is duplicated");
    seen.add(key);
    const approver = normalized.policy.approvers.find((value) => (
      value.role === attestation.role && value.approverId === attestation.approverId
    ));
    if (!approver || approver.signer !== attestation.signer) {
      throw new Error("postflight attestation does not match an approver");
    }
    const recovered = verifyTypedData(
      domain,
      CLOSED_TESTNET_DEPLOYMENT_POSTFLIGHT_APPROVAL_TYPES,
      approvalValue(normalized, attestation.role, attestation.approverId),
      attestation.signature,
    );
    if (recovered !== approver.signer) throw new Error("postflight attestation signature is invalid");
  }
  assertClosedTestnetDeploymentPostflightIsSecretFree({ ...normalized, attestations: normalizedAttestations });
  const result = Object.freeze({
    schema: "treeswap.verified-closed-testnet-deployment-postflight.v2",
    status: "cryptographically-verified-finalized-deployment-execution",
    scope: "candidate-closed-testnet-deployment-evidence-no-signing-gate-opening-or-funding-authorization",
    recordDigest: hash(normalized.record),
    policyDigest: hash(normalized.policy),
    planDigest: normalized.record.planDigest,
    inputDigest: normalized.record.inputDigest,
    preflightPolicyDigest: normalized.record.preflightPolicyDigest,
    preflightRecordDigest: normalized.record.preflightRecordDigest,
    deploymentPolicyDigest: normalized.record.deploymentPolicyDigest,
    manifestDigest: normalized.record.manifestDigest,
    environment: normalized.record.environment,
    chainId: normalized.record.chainId,
    verifyingContract: normalized.record.verifyingContract,
    sourceCommit: normalized.record.reviewedBuildCommit,
    finalizedBlockNumber: normalized.record.finalizedBlockNumber,
    finalizedBlockHash: normalized.record.finalizedBlockHash,
    preparedAt: normalized.record.preparedAt,
    validUntil: normalized.record.validUntil,
    approverSetDigest: hash(normalized.policy.approvers),
    providerSetDigest: hash(normalized.record.providerObservations.map((value) => value.providerIdentity)),
    providerCount: normalized.observations.length,
    deploymentTransactionCount: normalized.observations[0].deployments.length,
    controllerActionCount: normalized.observations[0].controllerActions.length,
    signingAuthorization: false,
    gateOpeningAuthorization: false,
    fundingAuthorization: false,
  });
  verifiedPostflights.add(result);
  return result;
}

export function buildClosedTestnetDeploymentPostflightSummary(verification) {
  if (!verifiedPostflights.has(verification)) throw new Error("deployment postflight provenance is invalid");
  return Object.freeze({
    schema: "treeswap.closed-testnet-deployment-postflight-summary.v2",
    status: verification.status,
    scope: verification.scope,
    recordDigest: verification.recordDigest,
    policyDigest: verification.policyDigest,
    planDigest: verification.planDigest,
    inputDigest: verification.inputDigest,
    preflightPolicyDigest: verification.preflightPolicyDigest,
    preflightRecordDigest: verification.preflightRecordDigest,
    deploymentPolicyDigest: verification.deploymentPolicyDigest,
    manifestDigest: verification.manifestDigest,
    environment: verification.environment,
    chainId: verification.chainId,
    verifyingContract: verification.verifyingContract,
    sourceCommit: verification.sourceCommit,
    finalizedBlockNumber: verification.finalizedBlockNumber,
    finalizedBlockHash: verification.finalizedBlockHash,
    preparedAt: verification.preparedAt,
    validUntil: verification.validUntil,
    approverSetDigest: verification.approverSetDigest,
    providerSetDigest: verification.providerSetDigest,
    providerCount: verification.providerCount,
    deploymentTransactionCount: verification.deploymentTransactionCount,
    controllerActionCount: verification.controllerActionCount,
    signingAuthorization: false,
    gateOpeningAuthorization: false,
    fundingAuthorization: false,
  });
}

export function closedTestnetDeploymentPostflightValueDigest(value) {
  return hash(value);
}
