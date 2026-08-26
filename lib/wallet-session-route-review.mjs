import { createHash } from "node:crypto";
import {
  getAddress,
  isHexString,
  keccak256,
  toUtf8Bytes,
  verifyTypedData,
} from "ethers";

const BYTES32 = /^0x[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const BRANCH = /^[A-Za-z0-9](?:[A-Za-z0-9._/-]{0,126}[A-Za-z0-9])?$/;
const MAXIMUM_ARTIFACT_BYTES = 1_000_000;
const MAXIMUM_FILE_BYTES = 500_000;
const MAXIMUM_REVIEW_LIFETIME_SECONDS = 24 * 60 * 60;
const ZERO_BYTES32 = `0x${"00".repeat(32)}`;

export const WALLET_SESSION_ROUTE_REVIEW_ROLES = Object.freeze([
  "application-security-reviewer",
  "platform-data-isolation-reviewer",
]);

export const WALLET_SESSION_ROUTE_REVIEW_FILES = Object.freeze([
  ".env.example",
  ".openai/hosting.json",
  "app/api/auth/session/route.ts",
  "app/api/internal/wallet-session-read/route.ts",
  "db/schema.ts",
  "docs/CONTRACT_INTENT_WALLET.md",
  "docs/THREAT_MODEL.md",
  "docs/WALLET_SESSION_READER.md",
  "docs/WALLET_SESSION_ROUTE_DEPLOYMENT_PREFLIGHT.md",
  "docs/WALLET_SESSION_ROUTE_DEPLOYMENT_POSTFLIGHT.md",
  "docs/WALLET_SESSION_ROUTE_REVIEW.md",
  "lib/contract-intent-wallet-edge-perimeter.mjs",
  "lib/contract-intent-wallet-session-reader.mjs",
  "lib/contract-intent-wallet-session-route.mjs",
  "lib/contract-intent-wallet-siwe-edge.mjs",
  "lib/contract-intent-wallet-store.mjs",
  "lib/private-https-address.mjs",
  "lib/rfq-delivery.mjs",
  "lib/solver-endpoint-transport.mjs",
  "lib/wallet-session-route-review-source.mjs",
  "lib/wallet-session-route-review.mjs",
  "lib/wallet-session-route-deployment-preflight.mjs",
  "lib/wallet-session-route-deployment-postflight.mjs",
  "scripts/prepare-wallet-session-route-deployment-postflight-attestation.mjs",
  "scripts/prepare-wallet-session-route-deployment-preflight-attestation.mjs",
  "scripts/prepare-wallet-session-route-review-attestation.mjs",
  "scripts/prepare-wallet-session-route-review.mjs",
  "scripts/verify-wallet-session-route-deployment-preflight.mjs",
  "scripts/verify-wallet-session-route-deployment-postflight.mjs",
  "scripts/verify-wallet-session-route-review.mjs",
  "tests/contract-intent-wallet-edge-perimeter.test.mjs",
  "tests/contract-intent-wallet-session-reader.test.mjs",
  "tests/contract-intent-wallet-session-route.test.mjs",
  "tests/rfq-delivery.test.mjs",
  "tests/solver-endpoint-transport.test.mjs",
  "tests/fixtures/verified-wallet-session-route-review.mjs",
  "tests/fixtures/verified-wallet-session-route-deployment-preflight.mjs",
  "tests/wallet-session-route-deployment-postflight.test.mjs",
  "tests/wallet-session-route-deployment-preflight.test.mjs",
  "tests/wallet-session-route-review.test.mjs",
]);

export const WALLET_SESSION_ROUTE_REVIEW_CONTROLS = Object.freeze({
  "application-security-reviewer": Object.freeze([
    "closed-test-mode-is-not-configurably-bypassable",
    "signed-request-and-response-are-bound-to-one-short-lived-read",
    "unknown-expired-forged-and-replayed-material-cannot-gain-dispatch-authority",
    "fixed-d1-query-is-read-only-bounded-and-fails-closed",
    "current-and-retiring-credential-slots-are-distinct-and-time-bounded",
    "errors-status-and-tests-do-not-disclose-wallet-session-or-key-identifiers",
    "deployment-preflight-and-postflight-signatures-preserve-causal-role-separation",
    "browser-wallet-lightning-settlement-and-funding-authority-are-absent",
  ]),
  "platform-data-isolation-reviewer": Object.freeze([
    "d1-is-the-only-session-authority-and-is-resolved-from-the-platform-binding",
    "route-credentials-are-server-runtime-values-with-no-browser-or-process-env-fallback",
    "request-and-response-bodies-have-no-application-log-trace-or-analytics-hook",
    "cache-cookie-server-timing-indexing-and-framing-responses-are-fail-closed",
    "route-initialization-and-d1-or-clock-failure-remain-inert-or-halted",
    "isolate-local-state-and-version-overlap-are-explicit-unresolved-deployment-risks",
    "postflight-separates-accountable-claims-from-direct-platform-proof",
    "live-body-log-version-retirement-and-access-policy-evidence-remain-required",
  ]),
});

const ARTIFACT_FIELDS = Object.freeze([
  "fileSetDigest",
  "files",
  "repository",
  "routePath",
  "schema",
  "scope",
  "sourceBranch",
  "sourceCommit",
  "status",
]);
const FILE_FIELDS = Object.freeze(["bytes", "path", "sha256"]);
const POLICY_FIELDS = Object.freeze([
  "artifactFileDigest",
  "deploymentEvidenceRequired",
  "environment",
  "maximumReviewLifetimeSeconds",
  "reviewApprovers",
  "reviewScope",
  "schema",
  "sourceBranch",
  "sourceCommit",
]);
const APPROVER_FIELDS = Object.freeze([
  "identityEvidenceDigest",
  "organizationId",
  "reviewerId",
  "role",
  "signer",
]);
const REPORT_FIELDS = Object.freeze([
  "controlSetDigest",
  "findingCounts",
  "findingsDispositionDigest",
  "reportDigest",
  "reviewId",
  "reviewedAt",
  "role",
  "schema",
  "status",
  "validUntil",
]);
const FINDING_FIELDS = Object.freeze([
  "critical",
  "high",
  "informational",
  "low",
  "medium",
  "open",
]);
const ATTESTATION_FIELDS = Object.freeze(["reviewerId", "role", "signature", "signer"]);
const verifiedReviews = new WeakSet();

export const WALLET_SESSION_ROUTE_REVIEW_APPROVAL_TYPES = Object.freeze({
  WalletSessionRouteReviewApproval: Object.freeze([
    Object.freeze({ name: "artifactFileDigest", type: "bytes32" }),
    Object.freeze({ name: "fileSetDigest", type: "bytes32" }),
    Object.freeze({ name: "recordDigest", type: "bytes32" }),
    Object.freeze({ name: "policyDigest", type: "bytes32" }),
    Object.freeze({ name: "sourceCommit", type: "bytes20" }),
    Object.freeze({ name: "reviewerRole", type: "bytes32" }),
    Object.freeze({ name: "reviewerId", type: "bytes32" }),
    Object.freeze({ name: "reviewedAt", type: "uint64" }),
    Object.freeze({ name: "validUntil", type: "uint64" }),
  ]),
});

function exactRecord(value, fields, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${name} must be a plain data object`);
  }
  const keys = Reflect.ownKeys(value);
  const expected = [...fields].sort();
  if (keys.some((key) => typeof key !== "string") || keys.length !== expected.length
      || [...keys].sort().some((key, index) => key !== expected[index])) {
    throw new TypeError(`${name} fields are not exact`);
  }
  const result = Object.create(null);
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor || !Object.hasOwn(descriptor, "value") || descriptor.enumerable !== true) {
      throw new TypeError(`${name} fields must be enumerable data properties`);
    }
    result[field] = descriptor.value;
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

function valueDigest(value) {
  return keccak256(toUtf8Bytes(JSON.stringify(canonical(value)))).toLowerCase();
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function digest(value, name) {
  const normalized = String(value ?? "").toLowerCase();
  if (!BYTES32.test(normalized) || normalized === ZERO_BYTES32) {
    throw new TypeError(`${name} must be a nonzero lowercase bytes32 digest`);
  }
  return normalized;
}

function sha256Digest(value, name) {
  const normalized = String(value ?? "").toLowerCase();
  if (!SHA256.test(normalized) || normalized === `sha256:${"00".repeat(32)}`) {
    throw new TypeError(`${name} must be a nonzero lowercase SHA-256 digest`);
  }
  return normalized;
}

function bytes32FromSha256(value, name) {
  return `0x${sha256Digest(value, name).slice("sha256:".length)}`;
}

function sourceCommit(value, name) {
  const normalized = String(value ?? "");
  if (!COMMIT.test(normalized)) throw new TypeError(`${name} must be a lowercase Git commit`);
  return normalized;
}

function sourceBranch(value) {
  const normalized = String(value ?? "");
  if (!BRANCH.test(normalized) || normalized.includes("..") || normalized.includes("//")
      || normalized.startsWith("-") || normalized.endsWith(".") || normalized.endsWith("/")) {
    throw new TypeError("wallet session route review source branch is invalid");
  }
  return normalized;
}

function address(value, name) {
  try {
    return getAddress(value);
  } catch {
    throw new TypeError(`${name} must be an Ethereum address`);
  }
}

function safeInteger(value, name, { positive = false, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0) || value > maximum) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function exactRoleOrder(values, name) {
  if (!Array.isArray(values) || values.length !== WALLET_SESSION_ROUTE_REVIEW_ROLES.length
      || values.some((value, index) => value.role !== WALLET_SESSION_ROUTE_REVIEW_ROLES[index])) {
    throw new Error(`${name} must contain both exact reviewer roles in canonical order`);
  }
}

function distinct(values, selector, name) {
  if (new Set(values.map(selector)).size !== values.length) throw new Error(`${name} must be distinct`);
}

export function walletSessionRouteReviewControlSetDigest(role) {
  if (!WALLET_SESSION_ROUTE_REVIEW_ROLES.includes(role)) {
    throw new TypeError("wallet session route reviewer role is invalid");
  }
  return valueDigest(WALLET_SESSION_ROUTE_REVIEW_CONTROLS[role]);
}

function normalizeSourceFiles(sourceFiles) {
  if (!sourceFiles || typeof sourceFiles !== "object" || Array.isArray(sourceFiles)) {
    throw new TypeError("wallet session route review source files must be an object");
  }
  const prototype = Object.getPrototypeOf(sourceFiles);
  const keys = Reflect.ownKeys(sourceFiles);
  if ((prototype !== Object.prototype && prototype !== null)
      || keys.some((key) => typeof key !== "string")
      || keys.length !== WALLET_SESSION_ROUTE_REVIEW_FILES.length
      || [...keys].sort().some((key, index) => key !== [...WALLET_SESSION_ROUTE_REVIEW_FILES].sort()[index])) {
    throw new Error("wallet session route review requires the exact source file set");
  }
  return WALLET_SESSION_ROUTE_REVIEW_FILES.map((path) => {
    const descriptor = Object.getOwnPropertyDescriptor(sourceFiles, path);
    if (!descriptor || !Object.hasOwn(descriptor, "value") || descriptor.enumerable !== true) {
      throw new TypeError(`wallet session route review source ${path} must be an enumerable data property`);
    }
    const value = descriptor.value;
    if (!(typeof value === "string" || value instanceof Uint8Array || Buffer.isBuffer(value))) {
      throw new TypeError(`wallet session route review source ${path} is invalid`);
    }
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    if (bytes.byteLength === 0 || bytes.byteLength > MAXIMUM_FILE_BYTES) {
      throw new Error(`wallet session route review source ${path} is empty or too large`);
    }
    return Object.freeze({ path, bytes: bytes.byteLength, sha256: sha256(bytes) });
  });
}

export function buildWalletSessionRouteReviewArtifact({ sourceBranch: branch, sourceCommit: commit, sourceFiles }) {
  const files = normalizeSourceFiles(sourceFiles);
  const artifact = Object.freeze({
    schema: "treeswap.wallet-session-route-review-artifact.v1",
    status: "exact-published-repository-route-scope-prepared-for-independent-review",
    scope: "repository-route-review-only-no-deployment-signing-dispatch-settlement-or-funding-authority",
    repository: "https://github.com/bobofbuilding/treeswap",
    sourceBranch: sourceBranch(branch),
    sourceCommit: sourceCommit(commit, "wallet session route review source commit"),
    routePath: "/api/internal/wallet-session-read",
    files,
    fileSetDigest: sha256(Buffer.from(JSON.stringify(files))),
  });
  assertWalletSessionRouteReviewIsSecretFree(artifact);
  return artifact;
}

export function serializeWalletSessionRouteReviewArtifact(artifact) {
  const normalized = normalizeArtifact(artifact);
  return Buffer.from(`${JSON.stringify(normalized, null, 2)}\n`);
}

export function hashWalletSessionRouteReviewArtifactFile(bytes) {
  const raw = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []);
  if (raw.byteLength === 0 || raw.byteLength > MAXIMUM_ARTIFACT_BYTES) {
    throw new Error("wallet session route review artifact is empty or too large");
  }
  return sha256(raw);
}

function normalizeArtifact(raw) {
  const source = exactRecord(raw, ARTIFACT_FIELDS, "wallet session route review artifact");
  if (source.schema !== "treeswap.wallet-session-route-review-artifact.v1"
      || source.status !== "exact-published-repository-route-scope-prepared-for-independent-review"
      || source.scope !== "repository-route-review-only-no-deployment-signing-dispatch-settlement-or-funding-authority"
      || source.repository !== "https://github.com/bobofbuilding/treeswap"
      || source.routePath !== "/api/internal/wallet-session-read") {
    throw new Error("wallet session route review artifact identity is invalid");
  }
  if (!Array.isArray(source.files) || source.files.length !== WALLET_SESSION_ROUTE_REVIEW_FILES.length) {
    throw new Error("wallet session route review artifact file set is incomplete");
  }
  const files = source.files.map((rawFile, index) => {
    const file = exactRecord(rawFile, FILE_FIELDS, `wallet session route review file ${index}`);
    if (file.path !== WALLET_SESSION_ROUTE_REVIEW_FILES[index]) {
      throw new Error("wallet session route review artifact file order or path is invalid");
    }
    return Object.freeze({
      path: file.path,
      bytes: safeInteger(file.bytes, `${file.path} bytes`, { positive: true, maximum: MAXIMUM_FILE_BYTES }),
      sha256: sha256Digest(file.sha256, `${file.path} digest`),
    });
  });
  distinct(files, (file) => file.sha256, "wallet session route review file digests");
  const fileSetDigest = sha256Digest(source.fileSetDigest, "wallet session route review file-set digest");
  if (fileSetDigest !== sha256(Buffer.from(JSON.stringify(files)))) {
    throw new Error("wallet session route review file-set digest is invalid");
  }
  return Object.freeze({
    schema: source.schema,
    status: source.status,
    scope: source.scope,
    repository: source.repository,
    sourceBranch: sourceBranch(source.sourceBranch),
    sourceCommit: sourceCommit(source.sourceCommit, "artifact source commit"),
    routePath: source.routePath,
    files,
    fileSetDigest,
  });
}

function parseArtifactFile(bytes) {
  const raw = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []);
  const artifactFileDigest = hashWalletSessionRouteReviewArtifactFile(raw);
  let parsed;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new Error("wallet session route review artifact is not valid JSON");
  }
  const artifact = normalizeArtifact(parsed);
  if (!raw.equals(serializeWalletSessionRouteReviewArtifact(artifact))) {
    throw new Error("wallet session route review artifact bytes are not canonical");
  }
  return Object.freeze({ artifact, artifactFileDigest });
}

function normalizePolicy(raw, artifact, artifactFileDigest) {
  const source = exactRecord(raw, POLICY_FIELDS, "wallet session route review policy");
  if (source.schema !== "treeswap.wallet-session-route-review-policy.v1"
      || source.environment !== "closed-test"
      || source.reviewScope !== "repository-only"
      || source.deploymentEvidenceRequired !== true) {
    throw new Error("wallet session route review policy identity is invalid");
  }
  if (source.sourceBranch !== artifact.sourceBranch || source.sourceCommit !== artifact.sourceCommit
      || String(source.artifactFileDigest).toLowerCase() !== artifactFileDigest) {
    throw new Error("wallet session route review policy does not bind the exact artifact");
  }
  const maximumReviewLifetimeSeconds = safeInteger(
    source.maximumReviewLifetimeSeconds,
    "wallet session route review maximum lifetime",
    { positive: true, maximum: MAXIMUM_REVIEW_LIFETIME_SECONDS },
  );
  if (!Array.isArray(source.reviewApprovers)) {
    throw new TypeError("wallet session route review approvers must be an array");
  }
  const reviewApprovers = source.reviewApprovers.map((rawApprover, index) => {
    const approver = exactRecord(rawApprover, APPROVER_FIELDS, `wallet session route reviewer ${index}`);
    return Object.freeze({
      role: String(approver.role ?? ""),
      reviewerId: digest(approver.reviewerId, `reviewApprovers[${index}].reviewerId`),
      organizationId: digest(approver.organizationId, `reviewApprovers[${index}].organizationId`),
      identityEvidenceDigest: digest(
        approver.identityEvidenceDigest,
        `reviewApprovers[${index}].identityEvidenceDigest`,
      ),
      signer: address(approver.signer, `reviewApprovers[${index}].signer`),
    });
  });
  exactRoleOrder(reviewApprovers, "wallet session route review policy");
  distinct(reviewApprovers, (value) => value.reviewerId, "wallet session route reviewer identities");
  distinct(reviewApprovers, (value) => value.organizationId, "wallet session route reviewer organizations");
  distinct(reviewApprovers, (value) => value.identityEvidenceDigest, "wallet session route identity evidence");
  distinct(reviewApprovers, (value) => value.signer.toLowerCase(), "wallet session route reviewer signers");
  const commitments = reviewApprovers.flatMap((value) => [
    value.reviewerId,
    value.organizationId,
    value.identityEvidenceDigest,
  ]);
  if (new Set(commitments).size !== commitments.length) {
    throw new Error("wallet session route reviewer commitments must be globally distinct");
  }
  return Object.freeze({
    schema: source.schema,
    environment: source.environment,
    reviewScope: source.reviewScope,
    deploymentEvidenceRequired: source.deploymentEvidenceRequired,
    sourceBranch: artifact.sourceBranch,
    sourceCommit: artifact.sourceCommit,
    artifactFileDigest,
    maximumReviewLifetimeSeconds,
    reviewApprovers: Object.freeze(reviewApprovers),
  });
}

function normalizeReports(raw, policy) {
  if (!Array.isArray(raw)) throw new TypeError("wallet session route review reports must be an array");
  const reports = raw.map((rawReport, index) => {
    const report = exactRecord(rawReport, REPORT_FIELDS, `wallet session route report ${index}`);
    if (report.schema !== "treeswap.wallet-session-route-review-report.v1"
        || report.status !== "repository-scope-passed-no-open-findings") {
      throw new Error(`wallet session route report ${index} identity or status is invalid`);
    }
    const findingSource = exactRecord(report.findingCounts, FINDING_FIELDS, `report ${index} finding counts`);
    const findingCounts = Object.freeze(Object.fromEntries(FINDING_FIELDS.map((field) => [
      field,
      safeInteger(findingSource[field], `report ${index} ${field} findings`, { maximum: 10_000 }),
    ])));
    if (findingCounts.open !== 0) throw new Error("wallet session route review cannot pass with open findings");
    const reviewedAt = safeInteger(report.reviewedAt, `report ${index} reviewedAt`, { positive: true });
    const validUntil = safeInteger(report.validUntil, `report ${index} validUntil`, { positive: true });
    if (validUntil <= reviewedAt || validUntil - reviewedAt > policy.maximumReviewLifetimeSeconds) {
      throw new Error("wallet session route review report validity exceeds policy");
    }
    const role = String(report.role ?? "");
    const controlSetDigest = digest(report.controlSetDigest, `report ${index} control-set digest`);
    if (controlSetDigest !== walletSessionRouteReviewControlSetDigest(role)) {
      throw new Error("wallet session route review report does not cover the exact role controls");
    }
    return Object.freeze({
      schema: report.schema,
      status: report.status,
      role,
      reviewId: digest(report.reviewId, `report ${index} reviewId`),
      reportDigest: digest(report.reportDigest, `report ${index} reportDigest`),
      findingsDispositionDigest: digest(
        report.findingsDispositionDigest,
        `report ${index} findingsDispositionDigest`,
      ),
      controlSetDigest,
      findingCounts,
      reviewedAt,
      validUntil,
    });
  });
  exactRoleOrder(reports, "wallet session route review reports");
  const reportCommitments = reports.flatMap((value) => [
    value.reviewId,
    value.reportDigest,
    value.findingsDispositionDigest,
  ]);
  if (new Set(reportCommitments).size !== reportCommitments.length) {
    throw new Error("wallet session route report commitments must be globally distinct");
  }
  return Object.freeze(reports);
}

export function assertWalletSessionRouteReviewIsSecretFree(value) {
  const forbiddenKey = /(?:authorization(?!s)|cookie|email|invoice|macaroon|mnemonic|password|preimage|private.?key|rpc.?url|secret|session.?token|token.?hash|wallet.?address)/i;
  const visit = (entry) => {
    if (Array.isArray(entry)) {
      for (const item of entry) visit(item);
      return;
    }
    if (!entry || typeof entry !== "object") {
      if (typeof entry === "string"
          && (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(entry)
            || /ln(?:bc|bcrt|tb)[0-9a-z]{20,}/i.test(entry)
            || (/https?:\/\//i.test(entry)
              && entry !== "https://github.com/bobofbuilding/treeswap"))) {
        throw new Error("wallet session route review contains secret or unrestricted endpoint material");
      }
      return;
    }
    const prototype = Object.getPrototypeOf(entry);
    const keys = Reflect.ownKeys(entry);
    if ((prototype !== Object.prototype && prototype !== null)
        || keys.some((key) => typeof key !== "string")) {
      throw new Error("wallet session route review contains non-data material");
    }
    for (const key of keys) {
      if (forbiddenKey.test(key)) throw new Error(`wallet session route review contains forbidden field ${key}`);
      const descriptor = Object.getOwnPropertyDescriptor(entry, key);
      if (!descriptor || !Object.hasOwn(descriptor, "value") || descriptor.enumerable !== true) {
        throw new Error("wallet session route review contains non-data material");
      }
      visit(descriptor.value);
    }
  };
  visit(value);
  return true;
}

export function prepareWalletSessionRouteReviewCandidate({ artifactFileBytes, policy, reports }) {
  const parsed = parseArtifactFile(artifactFileBytes);
  const normalizedPolicy = normalizePolicy(policy, parsed.artifact, parsed.artifactFileDigest);
  const normalizedReports = normalizeReports(reports, normalizedPolicy);
  const record = Object.freeze({
    schema: "treeswap.wallet-session-route-independent-review-record.v1",
    status: "exact-repository-route-scope-awaiting-two-independent-attestations",
    scope: "repository-review-only-live-deployment-and-operations-evidence-still-required",
    environment: normalizedPolicy.environment,
    sourceBranch: parsed.artifact.sourceBranch,
    sourceCommit: parsed.artifact.sourceCommit,
    artifactFileDigest: parsed.artifactFileDigest,
    fileSetDigest: parsed.artifact.fileSetDigest,
    reviewerSetDigest: valueDigest(normalizedPolicy.reviewApprovers),
    reportsDigest: valueDigest(normalizedReports),
    reports: normalizedReports,
  });
  const candidate = Object.freeze({
    schema: "treeswap.prepared-wallet-session-route-independent-review.v1",
    status: "repository-route-reconstructed-awaiting-two-independent-reviewer-attestations",
    scope: "review-only-no-deployment-signing-dispatch-settlement-gate-opening-or-funding-authorization",
    recordDigest: valueDigest(record),
    policyDigest: valueDigest(normalizedPolicy),
    record,
    policy: normalizedPolicy,
    artifact: parsed.artifact,
  });
  assertWalletSessionRouteReviewIsSecretFree(candidate);
  return candidate;
}

export function walletSessionRouteReviewDomain(candidate) {
  return Object.freeze({
    name: "TreeSwap Wallet Session Route Review",
    version: "1",
    salt: bytes32FromSha256(candidate.record.artifactFileDigest, "artifact file digest"),
  });
}

export function buildWalletSessionRouteReviewApprovalMessage({ artifactFileBytes, policy, reports, role }) {
  const candidate = prepareWalletSessionRouteReviewCandidate({ artifactFileBytes, policy, reports });
  const reviewer = candidate.policy.reviewApprovers.find((value) => value.role === role);
  const report = candidate.record.reports.find((value) => value.role === role);
  if (!reviewer || !report) throw new Error("wallet session route reviewer role is not in the exact package");
  return Object.freeze({
    domain: walletSessionRouteReviewDomain(candidate),
    types: WALLET_SESSION_ROUTE_REVIEW_APPROVAL_TYPES,
    value: Object.freeze({
      artifactFileDigest: bytes32FromSha256(candidate.record.artifactFileDigest, "artifact file digest"),
      fileSetDigest: bytes32FromSha256(candidate.record.fileSetDigest, "file-set digest"),
      recordDigest: candidate.recordDigest,
      policyDigest: candidate.policyDigest,
      sourceCommit: `0x${candidate.record.sourceCommit}`,
      reviewerRole: keccak256(toUtf8Bytes(role)).toLowerCase(),
      reviewerId: reviewer.reviewerId,
      reviewedAt: report.reviewedAt,
      validUntil: report.validUntil,
    }),
  });
}

function normalizeAttestations(raw) {
  if (!Array.isArray(raw)) throw new TypeError("wallet session route review attestations must be an array");
  const attestations = raw.map((rawAttestation, index) => {
    const attestation = exactRecord(
      rawAttestation,
      ATTESTATION_FIELDS,
      `wallet session route review attestation ${index}`,
    );
    if (!isHexString(attestation.signature)
        || ![64, 65].includes((attestation.signature.length - 2) / 2)) {
      throw new TypeError(`wallet session route review attestation ${index} signature is invalid`);
    }
    return Object.freeze({
      role: String(attestation.role ?? ""),
      reviewerId: digest(attestation.reviewerId, `attestations[${index}].reviewerId`),
      signer: address(attestation.signer, `attestations[${index}].signer`),
      signature: attestation.signature.toLowerCase(),
    });
  });
  exactRoleOrder(attestations, "wallet session route review attestations");
  distinct(attestations, (value) => value.reviewerId, "wallet session route attestation identities");
  distinct(attestations, (value) => value.signer.toLowerCase(), "wallet session route attestation signers");
  return Object.freeze(attestations);
}

export function verifyWalletSessionRouteReview({
  artifactFileBytes,
  policy,
  reports,
  attestations,
  observedAt = Math.floor(Date.now() / 1_000),
}) {
  const candidate = prepareWalletSessionRouteReviewCandidate({ artifactFileBytes, policy, reports });
  const now = safeInteger(observedAt, "wallet session route review observation time", { positive: true });
  const normalizedAttestations = normalizeAttestations(attestations);
  for (let index = 0; index < normalizedAttestations.length; index += 1) {
    const attestation = normalizedAttestations[index];
    const reviewer = candidate.policy.reviewApprovers[index];
    const report = candidate.record.reports[index];
    if (now < report.reviewedAt) throw new Error("wallet session route review is from the future");
    if (now > report.validUntil) throw new Error("wallet session route review is expired");
    if (attestation.role !== reviewer.role || attestation.reviewerId !== reviewer.reviewerId
        || attestation.signer !== reviewer.signer) {
      throw new Error("wallet session route review attestation does not match its policy-pinned reviewer");
    }
    const typed = buildWalletSessionRouteReviewApprovalMessage({
      artifactFileBytes,
      policy,
      reports,
      role: reviewer.role,
    });
    let recovered;
    try {
      recovered = getAddress(verifyTypedData(typed.domain, typed.types, typed.value, attestation.signature));
    } catch {
      throw new Error("wallet session route review attestation signature is invalid");
    }
    if (recovered !== reviewer.signer) {
      throw new Error("wallet session route review attestation signature is invalid");
    }
  }
  const attestationDigest = valueDigest(normalizedAttestations.map((value) => ({
    role: value.role,
    reviewerId: value.reviewerId,
    signer: value.signer,
    signatureDigest: valueDigest(value.signature),
  })));
  const result = Object.freeze({
    schema: "treeswap.verified-wallet-session-route-independent-review.v1",
    status: "two-independent-repository-review-attestations-verified-deployment-evidence-still-required",
    scope: "repository-review-only-no-deployment-signing-dispatch-settlement-gate-opening-or-funding-authorization",
    evidenceDigest: valueDigest({
      schema: "treeswap.wallet-session-route-review-evidence-binding.v1",
      recordDigest: candidate.recordDigest,
      policyDigest: candidate.policyDigest,
      attestationDigest,
    }),
    recordDigest: candidate.recordDigest,
    policyDigest: candidate.policyDigest,
    attestationDigest,
    record: candidate.record,
    policy: candidate.policy,
    reviewerCount: candidate.policy.reviewApprovers.length,
    verifiedAt: now,
    externalEvidence: Object.freeze({
      deployedRoute: false,
      d1AccessPolicy: false,
      bodyLoggingDisabled: false,
      versionRetirement: false,
      monitoringAndIncidentDrills: false,
    }),
    authorizations: Object.freeze({
      deployment: false,
      signing: false,
      dispatch: false,
      settlement: false,
      gateOpening: false,
      funding: false,
    }),
  });
  assertWalletSessionRouteReviewIsSecretFree(result);
  verifiedReviews.add(result);
  return result;
}

export function buildWalletSessionRouteReviewSummary(verification) {
  if (!verifiedReviews.has(verification)) {
    throw new Error("wallet session route review verification provenance is invalid");
  }
  return Object.freeze({
    schema: "treeswap.wallet-session-route-independent-review-summary.v1",
    status: verification.status,
    scope: verification.scope,
    evidenceDigest: verification.evidenceDigest,
    recordDigest: verification.recordDigest,
    policyDigest: verification.policyDigest,
    attestationDigest: verification.attestationDigest,
    sourceBranch: verification.record.sourceBranch,
    sourceCommit: verification.record.sourceCommit,
    artifactFileDigest: verification.record.artifactFileDigest,
    fileSetDigest: verification.record.fileSetDigest,
    reviewerSetDigest: verification.record.reviewerSetDigest,
    reportsDigest: verification.record.reportsDigest,
    reviewerCount: verification.reviewerCount,
    verifiedAt: verification.verifiedAt,
    externalEvidence: verification.externalEvidence,
    authorizations: verification.authorizations,
  });
}

export function buildWalletSessionRouteReviewDeploymentEvidence(verification) {
  if (!verifiedReviews.has(verification)) {
    throw new Error("wallet session route review verification provenance is invalid");
  }
  return Object.freeze({
    schema: "treeswap.wallet-session-route-review-deployment-evidence.v1",
    status: verification.status,
    scope: "reviewed-repository-route-input-only-live-deployment-evidence-still-required",
    evidenceDigest: verification.evidenceDigest,
    recordDigest: verification.recordDigest,
    policyDigest: verification.policyDigest,
    sourceBranch: verification.record.sourceBranch,
    sourceCommit: verification.record.sourceCommit,
    artifactFileDigest: verification.record.artifactFileDigest,
    fileSetDigest: verification.record.fileSetDigest,
    reviewerSetDigest: verification.record.reviewerSetDigest,
    reportsDigest: verification.record.reportsDigest,
    reviewers: verification.policy.reviewApprovers,
    reviewedAt: Math.max(...verification.record.reports.map((report) => report.reviewedAt)),
    validUntil: Math.min(...verification.record.reports.map((report) => report.validUntil)),
    verifiedAt: verification.verifiedAt,
    externalEvidence: verification.externalEvidence,
    authorizations: verification.authorizations,
  });
}
