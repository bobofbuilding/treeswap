import {
  getAddress,
  isHexString,
  keccak256,
  toUtf8Bytes,
  TypedDataEncoder,
} from "ethers";
import { createJsonRpcClient } from "./bit-deployment-observer.mjs";
import {
  RELEASE_APPROVAL_ROLES,
  RELEASE_APPROVAL_TYPES,
  buildReleaseApprovalMessage,
  createErc1271QuorumVerifier,
  erc1271ProviderSetDigest,
  releaseAuthorizationDomain,
  verifiedReleaseAuthorizationBinding,
  verifyReleaseAuthorization,
} from "./release-authorization.mjs";

const BYTES32 = /^0x[0-9a-f]{64}$/;
const ENVIRONMENT_VARIABLE = /^TREESWAP_RELEASE_RPC_[A-Z0-9_]{1,64}_URL$/;
const ZERO_DIGEST = `0x${"00".repeat(32)}`;
const AUTHORIZATION_FIELDS = Object.freeze(["broadcast", "funding", "gateOpening", "signing"]);
const APPROVAL_FIELDS = Object.freeze(["role", "signature", "signatureKind", "signer"]);
const APPROVAL_BUNDLE_FIELDS = Object.freeze([
  "approvals",
  "policyDigest",
  "recordDigest",
  "releaseId",
  "schema",
]);
const APPROVAL_PAYLOAD_FIELDS = Object.freeze(["domain", "message", "primaryType", "types"]);
const PROVIDER_CONFIGURATION_FIELDS = Object.freeze(["providers", "schema"]);
const PROVIDER_FIELDS = Object.freeze(["identity", "urlEnvironmentVariable"]);
const QUALIFIED_EVIDENCE_FIELDS = Object.freeze([
  "adoptionPolicyDigest",
  "deploymentPostflightPolicyDigest",
  "deploymentPostflightRecordDigest",
  "deploymentPromotionPolicyDigest",
  "deploymentPromotionRecordDigest",
  "independentReviewAttestationSetDigest",
  "independentReviewPolicyDigest",
  "independentReviewRecordDigest",
  "gateConfirmerBindingDigest",
  "operationalReadinessAttestationSetDigest",
  "operationalReadinessPolicyDigest",
  "operationalReadinessRecordDigest",
  "publicTestnetPolicyDigest",
  "publicTestnetRecordDigest",
  "qualificationArtifactEvidenceDigest",
  "qualificationArtifactFileDigest",
  "qualificationReviewAttestationDigest",
  "qualificationReviewEvidenceDigest",
  "qualificationReviewPolicyDigest",
  "qualificationReviewRecordDigest",
  "safetyMonitorPolicyDigest",
  "safetyMonitorUpstreamRecordDigest",
]);
const BOOTSTRAP_EVIDENCE_FIELDS = Object.freeze([
  "adoptionPolicyDigest",
  "bootstrapEvidenceDigest",
  "deploymentPostflightPolicyDigest",
  "deploymentPostflightRecordDigest",
  "deploymentPromotionPolicyDigest",
  "deploymentPromotionRecordDigest",
  "independentReviewAttestationSetDigest",
  "independentReviewPolicyDigest",
  "independentReviewRecordDigest",
  "gateConfirmerBindingDigest",
  "operationalReadinessAttestationSetDigest",
  "operationalReadinessPolicyDigest",
  "operationalReadinessRecordDigest",
  "qualificationArtifactEvidenceDigest",
  "qualificationArtifactFileDigest",
  "qualificationReviewAttestationDigest",
  "qualificationReviewEvidenceDigest",
  "qualificationReviewPolicyDigest",
  "qualificationReviewRecordDigest",
  "safetyMonitorPolicyDigest",
  "safetyMonitorUpstreamRecordDigest",
]);
const CANDIDATE_KINDS = Object.freeze({
  "treeswap.prepared-public-testnet-bootstrap-release-candidate.v6": Object.freeze({
    fields: Object.freeze([
      "approval",
      "authorizations",
      "evidence",
      "policy",
      "policyDigest",
      "record",
      "recordDigest",
      "schema",
      "scope",
      "status",
    ]),
    evidenceFields: BOOTSTRAP_EVIDENCE_FIELDS,
    fundingMode: "operator-testnet-bootstrap",
    scope: "tiny-limit-bootstrap-release-preparation-only-no-signing-broadcast-gate-opening-or-funding-authorization",
    status: "deployment-bootstrap-review-and-operations-evidence-verified-awaiting-five-role-release-approvals",
  }),
  "treeswap.prepared-public-testnet-release-candidate.v6": Object.freeze({
    fields: Object.freeze([
      "adoptionSummary",
      "approval",
      "authorizations",
      "evidence",
      "policy",
      "policyDigest",
      "record",
      "recordDigest",
      "schema",
      "scope",
      "status",
    ]),
    evidenceFields: QUALIFIED_EVIDENCE_FIELDS,
    fundingMode: "operator-testnet",
    scope: "release-preparation-only-no-signing-broadcast-gate-opening-or-funding-authorization",
    status: "deployment-campaign-review-and-operations-evidence-verified-awaiting-five-role-release-approvals",
  }),
});
const verifiedProviderSets = new WeakSet();
const approvalReceiptVerifications = new WeakMap();

function exactKeys(value, fields, name) {
  exactDataRecord(value, fields, [], name);
}

function exactDataRecord(value, required, optional, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${name} must be a plain data object`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) {
    throw new TypeError(`${name} fields are not exact data properties`);
  }
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !keys.includes(key)) || keys.some((key) => !allowed.has(key))) {
    throw new TypeError(`${name} fields are not exact`);
  }
  const result = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError(`${name} fields must be enumerable data properties`);
    }
    result[key] = descriptor.value;
  }
  return Object.freeze(result);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function snapshotPlainData(value, name, state = { depth: 0, counter: { value: 0 } }) {
  state.counter.value += 1;
  if (state.counter.value > 4_096 || state.depth > 32) {
    throw new RangeError(`${name} is outside the bounded data policy`);
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (!value || typeof value !== "object") {
    throw new TypeError(`${name} contains an unsupported value`);
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || value.length > 128) {
      throw new TypeError(`${name} contains an unsupported array`);
    }
    const keys = Reflect.ownKeys(value);
    const expected = [...Array(value.length).keys()].map(String).concat("length");
    if (keys.length !== expected.length
        || keys.some((key) => typeof key !== "string" || !expected.includes(key))) {
      throw new TypeError(`${name} array fields are not exact`);
    }
    const result = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
        throw new TypeError(`${name}[${index}] must be an enumerable data property`);
      }
      result.push(snapshotPlainData(descriptor.value, `${name}[${index}]`, {
        depth: state.depth + 1,
        counter: state.counter,
      }));
    }
    return Object.freeze(result);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${name} contains an unsupported object`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length > 128 || keys.some((key) => typeof key !== "string")) {
    throw new TypeError(`${name} object fields are outside policy`);
  }
  const result = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError(`${name}.${key} must be an enumerable data property`);
    }
    Object.defineProperty(result, key, {
      configurable: false,
      enumerable: true,
      writable: false,
      value: snapshotPlainData(descriptor.value, `${name}.${key}`, {
        depth: state.depth + 1,
        counter: state.counter,
      }),
    });
  }
  return Object.freeze(result);
}

function canonicalJson(value) {
  return JSON.stringify(canonical(value));
}

function hash(value) {
  return keccak256(toUtf8Bytes(canonicalJson(value))).toLowerCase();
}

function digest(value, name, { allowZero = false } = {}) {
  const normalized = String(value ?? "").toLowerCase();
  if (!BYTES32.test(normalized) || (!allowZero && normalized === ZERO_DIGEST)) {
    throw new TypeError(`${name} must be a ${allowZero ? "" : "nonzero "}lowercase bytes32 digest`);
  }
  return normalized;
}

function canonicalAddress(value, name) {
  try {
    return getAddress(value);
  } catch {
    throw new TypeError(`${name} must be a canonical address`);
  }
}

function falseAuthorizations(value, name) {
  exactKeys(value, AUTHORIZATION_FIELDS, name);
  for (const field of AUTHORIZATION_FIELDS) {
    if (value[field] !== false) throw new Error(`${name}.${field} must remain false`);
  }
  return Object.freeze({ broadcast: false, funding: false, gateOpening: false, signing: false });
}

function requirePlainObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
}

function expectedApproval(record, policy) {
  const message = buildReleaseApprovalMessage(record, policy);
  const domain = releaseAuthorizationDomain(record);
  return Object.freeze({
    primaryType: "ReleaseApproval",
    domain: Object.freeze({ ...domain, chainId: domain.chainId.toString() }),
    types: RELEASE_APPROVAL_TYPES,
    message,
  });
}

export function inspectPreparedPublicTestnetReleaseCandidate(input) {
  const candidate = snapshotPlainData(input, "prepared release candidate");
  requirePlainObject(candidate, "prepared release candidate");
  const kind = CANDIDATE_KINDS[candidate.schema];
  if (!kind) throw new TypeError("prepared release candidate schema is invalid");
  exactKeys(candidate, kind.fields, "prepared release candidate");
  if (candidate.status !== kind.status || candidate.scope !== kind.scope) {
    throw new Error("prepared release candidate status or scope is invalid");
  }
  falseAuthorizations(candidate.authorizations, "prepared release candidate authorizations");
  exactKeys(candidate.evidence, kind.evidenceFields, "prepared release candidate evidence");
  for (const field of kind.evidenceFields) {
    digest(candidate.evidence[field], `prepared release candidate evidence.${field}`);
  }
  if (kind.fundingMode === "operator-testnet") {
    requirePlainObject(candidate.adoptionSummary, "prepared release candidate adoption summary");
  }
  if (candidate.record?.fundingMode !== kind.fundingMode) {
    throw new Error("prepared release candidate schema does not match its funding mode");
  }

  const approval = expectedApproval(candidate.record, candidate.policy);
  for (const role of ["controller", "guardian"]) {
    if (candidate.policy?.approvers?.[role]?.signatureKind !== "erc1271") {
      throw new Error(`prepared release candidate ${role} approval must use ERC-1271`);
    }
  }
  for (const role of ["lightningOperator", "securityReviewer", "incidentCommander"]) {
    if (candidate.policy?.approvers?.[role]?.signatureKind !== "eip712") {
      throw new Error(`prepared release candidate ${role} approval must use EIP-712`);
    }
  }
  const recordDigest = digest(candidate.recordDigest, "prepared release candidate recordDigest");
  const policyDigest = digest(candidate.policyDigest, "prepared release candidate policyDigest");
  if (recordDigest !== approval.message.recordDigest || policyDigest !== approval.message.policyDigest) {
    throw new Error("prepared release candidate digest does not match its record and policy");
  }
  exactKeys(candidate.approval, APPROVAL_PAYLOAD_FIELDS, "prepared release candidate approval payload");
  if (canonicalJson(candidate.approval) !== canonicalJson(approval)) {
    throw new Error("prepared release candidate approval payload is inconsistent");
  }

  return Object.freeze({
    candidate,
    candidateSchema: candidate.schema,
    message: approval.message,
    domain: approval.domain,
    recordDigest,
    policyDigest,
  });
}

function currentTime(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive safe integer`);
  return value;
}

export function buildPublicTestnetReleaseRoleApprovalPayload(input) {
  const source = exactDataRecord(
    input,
    ["candidate", "role"],
    ["now"],
    "release role approval payload input",
  );
  const inspected = inspectPreparedPublicTestnetReleaseCandidate(source.candidate);
  const role = source.role;
  if (!RELEASE_APPROVAL_ROLES.includes(role)) throw new TypeError("release approval role is invalid");
  const preparedAt = currentTime(
    source.now ?? Math.floor(Date.now() / 1_000),
    "release approval payload preparation time",
  );
  if (preparedAt < inspected.candidate.record.approvalBlockTimestamp) {
    throw new Error("release approval payload cannot be prepared before its approval block timestamp");
  }
  if (preparedAt > inspected.candidate.record.validUntil) {
    throw new Error("release approval payload cannot be prepared after release expiry");
  }
  const approver = inspected.candidate.policy.approvers[role];
  const signer = canonicalAddress(approver?.address, `release ${role} signer`);
  if (!["eip712", "erc1271"].includes(approver?.signatureKind)) {
    throw new TypeError(`release ${role} signature kind is invalid`);
  }
  return Object.freeze({
    schema: "treeswap.public-testnet-release-role-approval-payload.v1",
    status: "exact-role-payload-prepared-for-independent-external-signing",
    scope: "payload-only-no-private-key-access-signing-broadcast-gate-opening-or-funding-authorization",
    candidateSchema: inspected.candidateSchema,
    role,
    signer,
    signatureKind: approver.signatureKind,
    releaseId: inspected.message.releaseId,
    recordDigest: inspected.recordDigest,
    policyDigest: inspected.policyDigest,
    primaryType: "ReleaseApproval",
    domain: inspected.domain,
    types: RELEASE_APPROVAL_TYPES,
    message: inspected.message,
    typedDigest: TypedDataEncoder.hash(
      releaseAuthorizationDomain(inspected.candidate.record),
      RELEASE_APPROVAL_TYPES,
      inspected.message,
    ).toLowerCase(),
    authorizations: Object.freeze({ broadcast: false, funding: false, gateOpening: false, signing: false }),
  });
}

function normalizeApprovalBundle(input, inspected) {
  const source = snapshotPlainData(input, "release approval bundle");
  exactKeys(source, APPROVAL_BUNDLE_FIELDS, "release approval bundle");
  if (source.schema !== "treeswap.public-testnet-release-approvals.v1") {
    throw new TypeError("release approval bundle schema is invalid");
  }
  if (digest(source.releaseId, "release approval bundle releaseId") !== inspected.message.releaseId
      || digest(source.recordDigest, "release approval bundle recordDigest") !== inspected.recordDigest
      || digest(source.policyDigest, "release approval bundle policyDigest") !== inspected.policyDigest) {
    throw new Error("release approval bundle does not match the prepared candidate");
  }
  if (!Array.isArray(source.approvals) || source.approvals.length !== RELEASE_APPROVAL_ROLES.length) {
    throw new Error("release approval bundle must contain exactly five role approvals");
  }
  const approvals = new Map();
  for (const [index, raw] of source.approvals.entries()) {
    exactKeys(raw, APPROVAL_FIELDS, `release approval ${index}`);
    if (!RELEASE_APPROVAL_ROLES.includes(raw.role)) throw new TypeError("release approval role is invalid");
    if (approvals.has(raw.role)) throw new Error(`duplicate ${raw.role} approval`);
    if (!["eip712", "erc1271"].includes(raw.signatureKind)) {
      throw new TypeError(`${raw.role} release signature kind is invalid`);
    }
    if (!isHexString(raw.signature) || raw.signature === "0x" || raw.signature.length > 16_386) {
      throw new TypeError(`${raw.role} release signature is malformed or oversized`);
    }
    if (raw.signatureKind === "eip712" && raw.signature.length !== 132) {
      throw new TypeError(`${raw.role} EIP-712 release signature must be 65 bytes`);
    }
    approvals.set(raw.role, Object.freeze({
      role: raw.role,
      signer: canonicalAddress(raw.signer, `${raw.role} release signer`),
      signatureKind: raw.signatureKind,
      signature: raw.signature.toLowerCase(),
    }));
  }
  return Object.freeze({
    schema: source.schema,
    releaseId: inspected.message.releaseId,
    recordDigest: inspected.recordDigest,
    policyDigest: inspected.policyDigest,
    approvals: Object.freeze(RELEASE_APPROVAL_ROLES.map((role) => approvals.get(role))),
  });
}

export function inspectPublicTestnetReleaseApprovalBundle(input) {
  const source = exactDataRecord(
    input,
    ["approvalBundle", "candidate"],
    [],
    "release approval bundle inspection input",
  );
  const inspected = inspectPreparedPublicTestnetReleaseCandidate(source.candidate);
  const normalized = normalizeApprovalBundle(source.approvalBundle, inspected);
  return Object.freeze({
    releaseId: normalized.releaseId,
    recordDigest: normalized.recordDigest,
    policyDigest: normalized.policyDigest,
    approvalCount: normalized.approvals.length,
    approvalBundleDigest: hash(normalized),
  });
}

export function createPublicTestnetReleaseApprovalProviderSet(input) {
  const source = exactDataRecord(
    input,
    ["configuration", "expectedProviderCount", "expectedProviderSetDigest"],
    ["environment", "fetchImpl"],
    "release approval provider-set input",
  );
  const configuration = snapshotPlainData(
    source.configuration,
    "release approval provider configuration",
  );
  const environment = source.environment ?? process.env;
  const fetchImpl = source.fetchImpl ?? globalThis.fetch;
  const expectedProviderCount = source.expectedProviderCount;
  exactKeys(configuration, PROVIDER_CONFIGURATION_FIELDS, "release approval provider configuration");
  if (configuration.schema !== "treeswap.public-testnet-release-approval-providers.v1") {
    throw new TypeError("release approval provider configuration schema is invalid");
  }
  if (!Number.isSafeInteger(expectedProviderCount) || expectedProviderCount < 2 || expectedProviderCount > 8) {
    throw new RangeError("expected release approval provider count is outside two to eight");
  }
  if (!Array.isArray(configuration.providers) || configuration.providers.length !== expectedProviderCount) {
    throw new Error("release approval provider count does not match the candidate");
  }
  if (typeof source.expectedProviderSetDigest !== "string") {
    throw new TypeError("expected release approval provider-set digest must be a string");
  }
  const expectedDigest = digest(
    source.expectedProviderSetDigest,
    "expected release approval provider-set digest",
  );
  const identities = new Set();
  const variableNames = new Set();
  const urls = new Set();
  const origins = new Set();
  const providers = configuration.providers.map((provider, index) => {
    exactKeys(provider, PROVIDER_FIELDS, `release approval provider ${index}`);
    const identity = digest(provider.identity, `release approval provider ${index} identity`);
    if (identities.has(identity)) throw new Error("release approval provider identities must be distinct");
    identities.add(identity);
    const variableName = String(provider.urlEnvironmentVariable ?? "");
    if (!ENVIRONMENT_VARIABLE.test(variableName)) {
      throw new TypeError("release approval provider URL environment-variable name is invalid");
    }
    if (variableNames.has(variableName)) throw new Error("release approval provider URL variables must be distinct");
    variableNames.add(variableName);
    const rpcUrl = environment?.[variableName];
    if (typeof rpcUrl !== "string" || rpcUrl.length === 0 || rpcUrl.length > 4_096) {
      throw new Error("a release approval provider URL environment variable is missing or oversized");
    }
    let parsed;
    try {
      parsed = new URL(rpcUrl);
    } catch {
      throw new TypeError("a release approval provider URL is invalid");
    }
    if (urls.has(parsed.href) || origins.has(parsed.origin)) {
      throw new Error("release approval providers must use distinct RPC URLs and origins");
    }
    urls.add(parsed.href);
    origins.add(parsed.origin);
    return Object.freeze({ identity, rpcCall: createJsonRpcClient(rpcUrl, fetchImpl) });
  });
  const providerSetDigest = erc1271ProviderSetDigest([...identities]);
  if (providerSetDigest !== expectedDigest) {
    throw new Error("release approval provider identities do not match the candidate");
  }
  const providerSet = Object.freeze({
    providers: Object.freeze(providers),
    providerCount: providers.length,
    providerSetDigest,
  });
  verifiedProviderSets.add(providerSet);
  return providerSet;
}

export function verifiedPublicTestnetReleaseApprovalProviderSet(providerSet) {
  if (!verifiedProviderSets.has(providerSet)) {
    throw new TypeError("release approval provider set was not configured by this process");
  }
  return providerSet;
}

export async function verifyPublicTestnetReleaseApprovals(input) {
  const source = exactDataRecord(
    input,
    ["approvalBundle", "candidate", "providers"],
    ["now"],
    "release approval verification input",
  );
  const inspected = inspectPreparedPublicTestnetReleaseCandidate(source.candidate);
  const approvalBundle = normalizeApprovalBundle(source.approvalBundle, inspected);
  const verifiedAt = currentTime(
    source.now ?? Math.floor(Date.now() / 1_000),
    "release approval verification time",
  );
  const expectedContracts = RELEASE_APPROVAL_ROLES
    .map((role) => inspected.candidate.policy.approvers[role])
    .filter((approver) => approver.signatureKind === "erc1271")
    .map((approver) => Object.freeze({ address: approver.address, codeHash: approver.codeHash }));
  const verifyContractSignature = createErc1271QuorumVerifier({
    providers: source.providers,
    chainId: inspected.candidate.record.chainId,
    anchor: {
      number: Number(inspected.candidate.record.approvalBlockNumber),
      hash: inspected.candidate.record.approvalBlockHash,
      timestamp: inspected.candidate.record.approvalBlockTimestamp,
    },
    expectedContracts,
  });
  const verification = await verifyReleaseAuthorization({
    record: inspected.candidate.record,
    policy: inspected.candidate.policy,
    approvals: approvalBundle.approvals,
    verifyContractSignature,
    now: verifiedAt,
  });
  if (!verification.valid) {
    throw new Error(`release approvals are invalid: ${verification.reasons.join("; ")}`);
  }
  const binding = verifiedReleaseAuthorizationBinding(verification);
  if (binding.recordDigest !== inspected.recordDigest || binding.policyDigest !== inspected.policyDigest) {
    throw new Error("verified release authorization binding changed unexpectedly");
  }
  const receipt = Object.freeze({
    schema: "treeswap.public-testnet-release-approval-verification-receipt.v1",
    status: "five-release-approvals-verified-no-capabilities-activated",
    scope: "verification-receipt-only-no-signing-broadcast-gate-opening-or-funding-authorization",
    verifiedAt,
    candidateSchema: inspected.candidateSchema,
    releaseId: binding.releaseId,
    environment: binding.environment,
    fundingMode: binding.fundingMode,
    recordDigest: binding.recordDigest,
    policyDigest: binding.policyDigest,
    typedDigest: verification.typedDigest,
    approvalBundleDigest: hash(approvalBundle),
    approvalCount: approvalBundle.approvals.length,
    approvalAnchor: Object.freeze({
      blockNumber: inspected.candidate.record.approvalBlockNumber,
      blockHash: inspected.candidate.record.approvalBlockHash,
      blockTimestamp: inspected.candidate.record.approvalBlockTimestamp,
    }),
    providerQuorum: Object.freeze({
      count: inspected.candidate.record.counts.independentEvmProviders,
      digest: inspected.candidate.record.approvalProviderSetDigest,
    }),
    provenance: Object.freeze({
      candidateArtifactSelfConsistencyVerified: true,
      upstreamEvidenceReverifiedFromReceipt: false,
      activationProvenance: false,
    }),
    authorizations: Object.freeze({ broadcast: false, funding: false, gateOpening: false, signing: false }),
  });
  approvalReceiptVerifications.set(receipt, verification);
  return receipt;
}

export function verifiedPublicTestnetReleaseApprovalVerification(receipt) {
  const verification = approvalReceiptVerifications.get(receipt);
  if (!verification) {
    throw new TypeError("release approval receipt was not verified by this process");
  }
  return verification;
}
