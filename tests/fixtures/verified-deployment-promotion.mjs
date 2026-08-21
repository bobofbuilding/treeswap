import { id, keccak256, toUtf8Bytes } from "ethers";
import {
  POSTFLIGHT_NOW,
  POSTFLIGHT_REVIEW_ARTIFACTS,
  createVerifiedDeploymentPostflightFixture,
} from "./verified-deployment-postflight.mjs";
import {
  buildDeploymentPromotionApprovalMessage,
  verifyDeploymentManifestPromotion,
} from "../../lib/deployment-manifest-promotion.mjs";

export const NOW = POSTFLIGHT_NOW + 180;

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

export function hash(value) {
  return keccak256(toUtf8Bytes(JSON.stringify(canonical(value)))).toLowerCase();
}

function reviewArtifacts() {
  return structuredClone(POSTFLIGHT_REVIEW_ARTIFACTS);
}

export async function fixture() {
  const postflight = await createVerifiedDeploymentPostflightFixture();
  const reviews = reviewArtifacts();
  const deploymentManifest = structuredClone(postflight.candidate.observations[0].manifest);
  const providerEntries = postflight.candidate.approvers.filter((value) => value.role === "provider");
  const observations = providerEntries.map((provider, index) => ({
    schema: "treeswap.deployment-observation.v2",
    evidenceStatus: "unreviewed-rpc-observation",
    observedAt: new Date((NOW - 5 + index) * 1_000).toISOString(),
    providerLabel: `promotion-provider-${index + 1}`,
    providerIdentity: provider.approverId,
    sourceCommit: postflight.verification.sourceCommit,
    chainId: Number(postflight.verification.chainId),
    providerFinalizedHead: {
      number: Number(postflight.verification.finalizedBlockNumber) + 1,
      hash: id(`promotion provider head ${index}`).toLowerCase(),
    },
    finalizedBlock: {
      number: Number(postflight.verification.finalizedBlockNumber),
      hash: postflight.verification.finalizedBlockHash,
    },
    stateAnchor: { blockHash: postflight.verification.finalizedBlockHash, requireCanonical: true },
    manifest: structuredClone(deploymentManifest),
    manifestDigest: hash(deploymentManifest),
  }));
  const providerObservations = observations.map((value) => ({
    providerIdentity: value.providerIdentity,
    observationDigest: hash(value),
  }));
  const candidateDeploymentPolicy = structuredClone(postflight.candidate.deploymentPolicy);
  const record = {
    schema: "treeswap.deployment-promotion-record.v2",
    promotionId: id("deployment promotion one").toLowerCase(),
    environment: "public-testnet",
    chainId: postflight.verification.chainId,
    verifyingContract: postflight.verification.verifyingContract,
    reviewedBuildCommit: postflight.verification.sourceCommit,
    deploymentPolicyDigest: hash(candidateDeploymentPolicy),
    manifestDigest: hash(deploymentManifest),
    postflightRecordDigest: postflight.verification.recordDigest,
    postflightPolicyDigest: postflight.verification.policyDigest,
    finalizedBlockNumber: postflight.verification.finalizedBlockNumber,
    finalizedBlockHash: postflight.verification.finalizedBlockHash,
    providerObservations,
    reviewArtifacts: reviews,
    promotedAt: NOW,
    validUntil: NOW + 3_600,
  };
  const approvers = postflight.candidate.approvers.map((value) => ({
    ...value,
    signer: value.wallet.address,
  }));
  const policy = {
    schema: "treeswap.deployment-promotion-policy.v2",
    environment: record.environment,
    chainId: record.chainId,
    verifyingContract: record.verifyingContract,
    reviewedBuildCommit: record.reviewedBuildCommit,
    deploymentPolicyDigest: record.deploymentPolicyDigest,
    manifestDigest: record.manifestDigest,
    postflightRecordDigest: record.postflightRecordDigest,
    postflightPolicyDigest: record.postflightPolicyDigest,
    minimumProviderCount: 2,
    maximumObservationAgeSeconds: 3_600,
    maximumPromotionLifetimeSeconds: 86_400,
    approvers: approvers.map((value) => ({
      role: value.role,
      approverId: value.approverId,
      signer: value.signer,
    })),
  };
  return {
    record,
    policy,
    deploymentPolicy: candidateDeploymentPolicy,
    observations,
    approvers,
    postflightVerification: postflight.verification,
    postflight: postflight.candidate,
    postflightAttestations: postflight.attestations,
  };
}

export async function attestations(candidate = null) {
  candidate ??= await fixture();
  const values = [];
  for (const approver of candidate.approvers) {
    const typed = buildDeploymentPromotionApprovalMessage({
      record: candidate.record,
      policy: candidate.policy,
      deploymentPolicy: candidate.deploymentPolicy,
      observations: candidate.observations,
      postflightVerification: candidate.postflightVerification,
      role: approver.role,
      approverId: approver.approverId,
    });
    values.push({
      role: approver.role,
      approverId: approver.approverId,
      signer: approver.signer,
      signature: await approver.wallet.signTypedData(typed.domain, typed.types, typed.value),
    });
  }
  return values;
}

export async function verify(candidate = null, attestationSet = null, now = NOW) {
  candidate ??= await fixture();
  return verifyDeploymentManifestPromotion({
    ...candidate,
    attestations: attestationSet ?? await attestations(candidate),
    now,
  });
}

export async function createVerifiedDeploymentPromotionFixture() {
  const candidate = await fixture();
  const signed = await attestations(candidate);
  const verification = await verify(candidate, signed);
  return Object.freeze({ candidate, attestations: signed, verification });
}
