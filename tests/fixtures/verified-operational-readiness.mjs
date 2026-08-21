import { Wallet, id } from "ethers";
import {
  OPERATIONAL_READINESS_ROLES,
  REQUIRED_OPERATIONAL_DRILLS,
  buildOperationalReadinessAttestationMessage,
  verifyOperationalReadinessEvidence,
} from "../../lib/operational-readiness-evidence.mjs";
import { buildServiceIsolationReleaseEvidence } from "../../lib/service-isolation-evidence.mjs";
import { createVerifiedServiceIsolationFixture } from "./verified-service-isolation.mjs";

export function canonical(values, selector) {
  return [...values].sort((left, right) => selector(left).localeCompare(selector(right)));
}

function walletForRole(role, options) {
  if (role === "lightning-operator" && options.lightningOperatorWallet) return options.lightningOperatorWallet;
  if (role === "incident-commander" && options.incidentCommanderWallet) return options.incidentCommanderWallet;
  if (role === "monitoring-operator" && options.monitoringOperatorWallet) return options.monitoringOperatorWallet;
  return new Wallet(id(`operational readiness ${role} signer`));
}

export function fixture({
  deployment,
  upstream,
  fundingMode,
  serviceIsolation,
  protocolVersion = "1.0.0-testnet.1",
  preparedAt,
  lightningOperatorWallet,
  incidentCommanderWallet,
  monitoringOperatorWallet,
}) {
  if (!deployment?.verification || !upstream?.candidate || !serviceIsolation?.verification
      || !Number.isSafeInteger(preparedAt)) {
    throw new TypeError("verified deployment, upstream evidence, service isolation, and preparedAt are required");
  }
  const options = { lightningOperatorWallet, incidentCommanderWallet, monitoringOperatorWallet };
  const wallets = new Map();
  const participants = OPERATIONAL_READINESS_ROLES.map((role, index) => {
    const wallet = walletForRole(role, options);
    wallets.set(wallet.address, wallet);
    const upstreamMonitor = role === "monitoring-operator"
      ? upstream.candidate.record.participants.find((participant) => (
          participant.role === "monitor" && participant.signer === wallet.address
        ))
      : null;
    return {
      role,
      operatorId: upstreamMonitor?.operatorId ?? id(`operational readiness ${role} identity`).toLowerCase(),
      organizationId: id(`operational readiness organization ${index % 2}`).toLowerCase(),
      signer: wallet.address,
      evidenceDigest: id(`operational readiness ${role} identity evidence`).toLowerCase(),
    };
  });
  const operatorIds = canonical(participants.map((participant) => participant.operatorId), (value) => value);
  const artifacts = fundingMode === "operator-testnet"
    ? {
        alertDelivery: id("operational alert delivery evidence").toLowerCase(),
        backupRestore: upstream.candidate.record.artifacts.backupRestore,
        incidentDrills: upstream.candidate.record.artifacts.incidentDrills,
        lossAllocation: id("operational loss allocation policy").toLowerCase(),
        monitoring: upstream.candidate.record.artifacts.monitoring,
        privacyRetention: id("operational privacy and deletion evidence").toLowerCase(),
        providerQuorum: upstream.candidate.record.artifacts.providerQuorum,
        reconciliation: upstream.candidate.record.reconciliation.reconciliationDigest,
        serviceIsolation: serviceIsolation.releaseEvidence?.evidenceDigest
          ?? buildServiceIsolationReleaseEvidence(serviceIsolation.verification).evidenceDigest,
        solverOperations: upstream.candidate.record.artifacts.solverOperations,
        supportPolicy: id("operational support and escalation policy").toLowerCase(),
        testQualification: upstream.candidate.record.artifacts.testQualification,
      }
    : {
        alertDelivery: id("bootstrap operational alert delivery evidence").toLowerCase(),
        backupRestore: upstream.candidate.record.artifacts.backupRestore,
        incidentDrills: upstream.candidate.record.artifacts.incidentDrills,
        lossAllocation: id("bootstrap operational loss allocation policy").toLowerCase(),
        monitoring: upstream.candidate.record.artifacts.monitoring,
        privacyRetention: id("bootstrap operational privacy and deletion evidence").toLowerCase(),
        providerQuorum: upstream.candidate.record.artifacts.providerQuorum,
        reconciliation: id("bootstrap operational zero-liability reconciliation").toLowerCase(),
        serviceIsolation: serviceIsolation.releaseEvidence?.evidenceDigest
          ?? buildServiceIsolationReleaseEvidence(serviceIsolation.verification).evidenceDigest,
        solverOperations: upstream.candidate.record.artifacts.solverOperations,
        supportPolicy: id("bootstrap operational support and escalation policy").toLowerCase(),
        testQualification: upstream.candidate.record.artifacts.testQualification,
      };
  const scenarioEvidence = new Map(
    fundingMode === "operator-testnet"
      ? upstream.candidate.record.scenarios.map((scenario) => [scenario.name, scenario.evidenceDigest])
      : [],
  );
  const record = {
    schema: "treeswap.operational-readiness-evidence.v2",
    operationsId: id(`operational readiness:${fundingMode}:${preparedAt}`).toLowerCase(),
    environment: "public-testnet",
    fundingMode,
    chainId: deployment.verification.record.chainId,
    verifyingContract: deployment.verification.record.verifyingContract,
    reviewedBuildCommit: deployment.verification.record.reviewedBuildCommit,
    protocolVersion,
    deploymentManifestDigest: deployment.verification.record.manifestDigest,
    preparedAt,
    validUntil: preparedAt + 3_600,
    participants,
    alertChannelEvidenceDigests: fundingMode === "operator-testnet"
      ? [...upstream.candidate.record.alertChannelEvidenceDigests]
      : [...upstream.candidate.record.alertChannelEvidenceDigests],
    artifacts,
    drills: REQUIRED_OPERATIONAL_DRILLS.map((name, index) => {
      const primaryOperatorId = participants[index % participants.length].operatorId;
      return {
        name,
        status: "passed",
        startedAt: preparedAt - 1_000 + index * 10,
        finishedAt: preparedAt - 999 + index * 10,
        primaryOperatorId,
        observerOperatorIds: operatorIds.filter((operatorId) => operatorId !== primaryOperatorId).slice(0, 2),
        evidenceDigest: scenarioEvidence.get(name) ?? id(`bootstrap operational drill:${name}`).toLowerCase(),
      };
    }),
  };
  const policy = {
    schema: "treeswap.operational-readiness-evidence-policy.v2",
    environment: record.environment,
    fundingMode: record.fundingMode,
    chainId: record.chainId,
    verifyingContract: record.verifyingContract,
    reviewedBuildCommit: record.reviewedBuildCommit,
    protocolVersion: record.protocolVersion,
    deploymentManifestDigest: record.deploymentManifestDigest,
    maximumEvidenceAgeSeconds: 3_600,
    maximumEvidenceLifetimeSeconds: 86_400,
    maximumDrillAgeSeconds: 2_592_000,
    maximumDrillDurationSeconds: 86_400,
    minimumAlertChannels: 2,
    minimumOrganizations: 2,
    requiredDrills: [...REQUIRED_OPERATIONAL_DRILLS],
  };
  return {
    attestations: [],
    policy,
    record,
    wallets,
    serviceIsolationVerification: serviceIsolation.verification,
  };
}

export async function sign(value) {
  value.attestations = [];
  for (const participant of value.record.participants) {
    const typed = buildOperationalReadinessAttestationMessage({
      record: value.record,
      policy: value.policy,
      serviceIsolationVerification: value.serviceIsolationVerification,
      role: participant.role,
      operatorId: participant.operatorId,
    });
    const wallet = value.wallets.get(participant.signer);
    value.attestations.push({
      role: participant.role,
      operatorId: participant.operatorId,
      signer: participant.signer,
      signature: await wallet.signTypedData(typed.domain, typed.types, typed.value),
    });
  }
  value.attestations = canonical(value.attestations, (attestation) => attestation.role);
  return value;
}

export async function createVerifiedOperationalReadinessFixture(options) {
  const serviceIsolation = options.serviceIsolation ?? await createVerifiedServiceIsolationFixture({
    deployment: options.deployment,
    protocolVersion: options.protocolVersion,
    preparedAt: options.preparedAt,
    now: options.now,
    lightningOperatorWallet: options.lightningOperatorWallet,
    securityReviewerWallet: options.securityReviewerWallet,
  });
  const candidate = await sign(fixture({ ...options, serviceIsolation }));
  const verification = verifyOperationalReadinessEvidence({
    ...candidate,
    now: options.now ?? candidate.record.preparedAt + 60,
  });
  return Object.freeze({ candidate, verification, serviceIsolation });
}
