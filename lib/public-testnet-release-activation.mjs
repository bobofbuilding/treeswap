import { isAbsolute, resolve } from "node:path";
import { keccak256, toUtf8Bytes } from "ethers";
import { readBoundedJson } from "./closed-testnet-deployment-files.mjs";
import {
  PUBLIC_TESTNET_BOOTSTRAP_RELEASE_EVIDENCE_PATH_FIELDS,
  PUBLIC_TESTNET_RELEASE_EVIDENCE_PATH_FIELDS,
  rebuildPublicTestnetBootstrapReleaseCandidateFromFiles,
  rebuildPublicTestnetReleaseCandidateFromFiles,
} from "./public-testnet-release-files.mjs";
import {
  createPublicTestnetReleaseApprovalProviderSet,
  inspectPreparedPublicTestnetReleaseCandidate,
} from "./public-testnet-release-approval.mjs";
import { activatePublicTestnetRelease } from "./capabilities.mjs";

export const PUBLIC_TESTNET_RELEASE_ACTIVATION_INPUT_SCHEMA =
  "treeswap.public-testnet-release-activation-inputs.v1";
export const PUBLIC_TESTNET_RELEASE_ACTIVATION_PREFLIGHT_SCHEMA =
  "treeswap.public-testnet-release-activation-preflight.v1";

const MANIFEST_FIELDS = Object.freeze([
  "approvalBundle",
  "candidateEvidence",
  "providerConfiguration",
  "reconciliation",
  "reconciliationApprovals",
  "schema",
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

function hasExactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function hash(value) {
  return keccak256(toUtf8Bytes(JSON.stringify(canonical(value)))).toLowerCase();
}

function absolutePath(value, name) {
  const path = String(value ?? "");
  if (path.length === 0 || path.length > 4_096 || !isAbsolute(path) || resolve(path) !== path || path === "/") {
    throw new TypeError(`${name} must be a canonical absolute file path`);
  }
  return path;
}

function normalizeActivationManifest(input) {
  exactKeys(input, MANIFEST_FIELDS, "public-testnet release activation manifest");
  if (input.schema !== PUBLIC_TESTNET_RELEASE_ACTIVATION_INPUT_SCHEMA) {
    throw new TypeError("public-testnet release activation manifest schema is invalid");
  }
  const candidateKind = hasExactKeys(input.candidateEvidence, PUBLIC_TESTNET_RELEASE_EVIDENCE_PATH_FIELDS)
    ? "campaign-qualified"
    : hasExactKeys(input.candidateEvidence, PUBLIC_TESTNET_BOOTSTRAP_RELEASE_EVIDENCE_PATH_FIELDS)
      ? "bootstrap"
      : null;
  if (!candidateKind) {
    throw new TypeError("public-testnet release activation candidate evidence fields are not exact");
  }
  const candidateEvidence = Object.create(null);
  for (const [field, value] of Object.entries(input.candidateEvidence ?? {})) {
    candidateEvidence[field] = absolutePath(value, `candidate evidence ${field}`);
  }
  const manifest = Object.freeze({
    schema: input.schema,
    candidateKind,
    candidateEvidence: Object.freeze(candidateEvidence),
    approvalBundle: absolutePath(input.approvalBundle, "release approval bundle"),
    providerConfiguration: absolutePath(input.providerConfiguration, "release provider configuration"),
    reconciliation: absolutePath(input.reconciliation, "runtime reconciliation"),
    reconciliationApprovals: absolutePath(
      input.reconciliationApprovals,
      "runtime reconciliation approvals",
    ),
  });
  const allPaths = [
    ...Object.values(manifest.candidateEvidence),
    manifest.approvalBundle,
    manifest.providerConfiguration,
    manifest.reconciliation,
    manifest.reconciliationApprovals,
  ];
  if (new Set(allPaths).size !== allPaths.length) {
    throw new Error("public-testnet release activation inputs must use distinct files");
  }
  return manifest;
}

export async function activatePublicTestnetReleaseFromManifest({
  manifestPath,
  environment = process.env,
  fetchImpl = globalThis.fetch,
  now = Math.floor(Date.now() / 1_000),
  timeoutMs = 10_000,
}) {
  const path = absolutePath(manifestPath, "public-testnet release activation manifest");
  const manifest = normalizeActivationManifest(await readBoundedJson(
    path,
    "public-testnet release activation manifest",
    { maximumBytes: 65_536 },
  ));
  const [candidate, approvalBundle, providerConfiguration, reconciliation, reconciliationApprovals] =
    await Promise.all([
      manifest.candidateKind === "bootstrap"
        ? rebuildPublicTestnetBootstrapReleaseCandidateFromFiles(manifest.candidateEvidence)
        : rebuildPublicTestnetReleaseCandidateFromFiles(manifest.candidateEvidence),
      readBoundedJson(manifest.approvalBundle, "public-testnet release approval bundle"),
      readBoundedJson(manifest.providerConfiguration, "public-testnet release provider configuration", {
        maximumBytes: 65_536,
      }),
      readBoundedJson(manifest.reconciliation, "public-testnet runtime reconciliation"),
      readBoundedJson(manifest.reconciliationApprovals, "public-testnet runtime reconciliation approvals"),
    ]);
  const inspected = inspectPreparedPublicTestnetReleaseCandidate(candidate);
  const providerSet = createPublicTestnetReleaseApprovalProviderSet({
    configuration: providerConfiguration,
    environment,
    fetchImpl,
    expectedProviderCount: inspected.candidate.record.counts.independentEvmProviders,
    expectedProviderSetDigest: inspected.candidate.record.approvalProviderSetDigest,
  });
  const activation = await activatePublicTestnetRelease({
    candidate,
    approvalBundle,
    providerSet,
    reconciliation,
    reconciliationApprovals,
    now,
    timeoutMs,
  });
  return Object.freeze({
    manifestDigest: hash(manifest),
    candidate,
    activation,
  });
}

export function buildPublicTestnetReleaseActivationPreflightSummary(result) {
  if (!result || typeof result !== "object" || !result.activation || !result.candidate) {
    throw new TypeError("same-process public-testnet release activation result is required");
  }
  const { activation, candidate } = result;
  if (activation.status !== "same-process-release-and-runtime-verification-active"
      || activation.releaseId !== candidate.record.releaseId) {
    throw new Error("public-testnet release activation result is inconsistent");
  }
  return Object.freeze({
    schema: PUBLIC_TESTNET_RELEASE_ACTIVATION_PREFLIGHT_SCHEMA,
    status: "same-process-release-activation-preflight-passed",
    scope: "non-authorizing-summary-only-no-solver-context-dispatch-gate-opening-or-persisted-funding-capability",
    releaseId: activation.releaseId,
    fundingMode: activation.fundingMode,
    validUntil: activation.validUntil,
    recordDigest: candidate.recordDigest,
    policyDigest: candidate.policyDigest,
    inputManifestDigest: result.manifestDigest,
    approvalBundleDigest: activation.receipt.approvalBundleDigest,
    reconciliationDigest: activation.deployment.reconciliationDigest,
    providerConsensusDigest: activation.providerConsensusDigest,
    runtimeBlockNumber: activation.runtimeBlockNumber,
    runtimeBlockHash: activation.runtimeBlockHash,
    authorizations: Object.freeze({
      signing: false,
      broadcast: false,
      gateOpening: false,
      dispatch: false,
      funding: false,
    }),
  });
}
