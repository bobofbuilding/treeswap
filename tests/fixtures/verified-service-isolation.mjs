import { Wallet, id } from "ethers";
import {
  REQUIRED_ISOLATED_SERVICES,
  SERVICE_ISOLATION_ATTESTATION_ROLES,
  SERVICE_ISOLATION_REQUIREMENTS,
  buildServiceIsolationAttestationMessage,
  buildServiceIsolationReleaseEvidence,
  verifyServiceIsolationEvidence,
} from "../../lib/service-isolation-evidence.mjs";

function canonical(values, selector) {
  return [...values].sort((left, right) => selector(left).localeCompare(selector(right)));
}

export function fixture({
  deployment,
  protocolVersion = "1.0.0-testnet.1",
  preparedAt,
  infrastructureOperatorWallet,
  lightningOperatorWallet,
  securityReviewerWallet,
}) {
  if (!deployment?.verification || !Number.isSafeInteger(preparedAt)) {
    throw new TypeError("verified deployment and preparedAt are required");
  }
  const wallets = new Map();
  const participants = SERVICE_ISOLATION_ATTESTATION_ROLES.map((role, index) => {
    const wallet = (role === "infrastructure-operator" && infrastructureOperatorWallet)
      || (role === "lightning-operator" && lightningOperatorWallet)
      || (role === "security-reviewer" && securityReviewerWallet)
      || new Wallet(id(`service isolation ${role} signer`));
    wallets.set(wallet.address, wallet);
    return {
      role,
      operatorId: id(`service isolation ${role} identity`).toLowerCase(),
      organizationId: id(`service isolation organization ${index % 2}`).toLowerCase(),
      signer: wallet.address,
      evidenceDigest: id(`service isolation ${role} identity evidence`).toLowerCase(),
    };
  });
  const participantByRole = new Map(participants.map((value) => [value.role, value]));
  const services = REQUIRED_ISOLATED_SERVICES.map((role) => {
    const requirement = SERVICE_ISOLATION_REQUIREMENTS[role];
    const hasCredentials = requirement.credentialClasses.length > 0;
    return {
      role,
      serviceId: id(`service isolation service:${role}`).toLowerCase(),
      trustDomainId: id(`service isolation trust domain:${role}`).toLowerCase(),
      operatorId: participantByRole.get(requirement.operatorRole).operatorId,
      networkZone: requirement.networkZone,
      publicIngress: requirement.publicIngress,
      encryptedTransport: true,
      credentialClasses: [...requirement.credentialClasses],
      credentialSetDigest: hasCredentials
        ? id(`service isolation credential set:${role}`).toLowerCase()
        : `0x${"00".repeat(32)}`,
      networkPolicyDigest: id(`service isolation network policy:${role}`).toLowerCase(),
      deploymentEvidenceDigest: id(`service isolation deployment evidence:${role}`).toLowerCase(),
      credentialReviewedAt: hasCredentials ? preparedAt - 600 : 0,
      credentialExpiresAt: hasCredentials ? preparedAt + 86_400 : 0,
    };
  });
  const record = {
    schema: "treeswap.service-isolation-evidence.v1",
    isolationId: id(`service isolation:${preparedAt}`).toLowerCase(),
    environment: "public-testnet",
    chainId: deployment.verification.record.chainId,
    verifyingContract: deployment.verification.record.verifyingContract,
    reviewedBuildCommit: deployment.verification.record.reviewedBuildCommit,
    protocolVersion,
    deploymentManifestDigest: deployment.verification.record.manifestDigest,
    preparedAt,
    validUntil: preparedAt + 3_600,
    participants,
    services,
  };
  const policy = {
    schema: "treeswap.service-isolation-evidence-policy.v1",
    environment: record.environment,
    chainId: record.chainId,
    verifyingContract: record.verifyingContract,
    reviewedBuildCommit: record.reviewedBuildCommit,
    protocolVersion: record.protocolVersion,
    deploymentManifestDigest: record.deploymentManifestDigest,
    maximumEvidenceAgeSeconds: 3_600,
    maximumEvidenceLifetimeSeconds: 86_400,
    maximumCredentialLifetimeSeconds: 2_592_000,
    minimumOrganizations: 2,
    requiredServices: [...REQUIRED_ISOLATED_SERVICES],
  };
  return { attestations: [], policy, record, wallets };
}

export async function sign(value) {
  value.attestations = [];
  for (const participant of value.record.participants) {
    const typed = buildServiceIsolationAttestationMessage({
      record: value.record,
      policy: value.policy,
      role: participant.role,
      operatorId: participant.operatorId,
    });
    value.attestations.push({
      role: participant.role,
      operatorId: participant.operatorId,
      signer: participant.signer,
      signature: await value.wallets.get(participant.signer).signTypedData(
        typed.domain,
        typed.types,
        typed.value,
      ),
    });
  }
  value.attestations = canonical(value.attestations, (attestation) => attestation.role);
  return value;
}

export async function createVerifiedServiceIsolationFixture(options) {
  const candidate = await sign(fixture(options));
  const verification = verifyServiceIsolationEvidence({
    ...candidate,
    now: options.now ?? candidate.record.preparedAt + 60,
  });
  return Object.freeze({
    candidate,
    verification,
    releaseEvidence: buildServiceIsolationReleaseEvidence(verification),
  });
}
