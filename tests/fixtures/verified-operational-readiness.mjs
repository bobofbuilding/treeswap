import { Wallet, id } from "ethers";
import {
  OPERATIONAL_READINESS_ROLES,
  REQUIRED_FINALIZED_GATE_CONTROL_DRILLS,
  REQUIRED_GATE_CONFIRMER_SERVICE_ROLES,
  REQUIRED_OPERATIONAL_DRILLS,
  buildOperationalReadinessAttestationMessage,
  operationalGateConfirmerBindingDigest,
  verifyOperationalReadinessEvidence,
} from "../../lib/operational-readiness-evidence.mjs";
import {
  REQUIRED_SAFETY_CHECKS,
  SAFETY_MONITOR_POLICY_SCHEMA,
  safetyMonitorPolicyDigest,
} from "../../lib/safety-observation-attestation.mjs";
import { buildAdoptionPolicyEvidence } from "../../lib/adoption-policy.mjs";
import { buildServiceIsolationReleaseEvidence } from "../../lib/service-isolation-evidence.mjs";
import { createVerifiedServiceIsolationFixture } from "./verified-service-isolation.mjs";

export function canonical(values, selector) {
  return [...values].sort((left, right) => selector(left).localeCompare(selector(right)));
}

function safetyMonitorPolicy({ deployment, upstream, preparedAt }) {
  const route = (name) => ({
    routeId: id(`operational safety route:${name}`).toLowerCase(),
    operatorId: id(`operational safety operator:${name}`).toLowerCase(),
  });
  const collectors = REQUIRED_SAFETY_CHECKS.flatMap((kind) => canonical([0, 1].map((index) => ({
    kind,
    collectorId: id(`operational safety collector:${kind}:${index}`).toLowerCase(),
    operatorId: id(`operational safety collector operator:${kind}:${index}`).toLowerCase(),
    signer: new Wallet(id(`operational safety collector signer:${kind}:${index}`)).address,
  })), (value) => value.collectorId));
  return {
    schema: SAFETY_MONITOR_POLICY_SCHEMA,
    chainId: deployment.verification.record.chainId,
    verifyingContract: deployment.verification.record.verifyingContract,
    releaseRecordDigest: upstream.verification.recordDigest,
    validFrom: preparedAt - 60,
    validUntil: preparedAt + 3_600,
    maximumObservationAgeSeconds: 30,
    quoteClosure: route("quote-closure"),
    guardianBroadcasters: canonical([route("guardian-a"), route("guardian-b")], (value) => value.routeId),
    gateConfirmers: canonical([route("gate-confirmer-a"), route("gate-confirmer-b")], (value) => value.routeId),
    alertRoutes: canonical([route("alert-a"), route("alert-b")], (value) => value.routeId),
    collectors,
  };
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
        lossAllocation: id("operational loss allocation placeholder").toLowerCase(),
        monitoring: upstream.candidate.record.artifacts.monitoring,
        privacyRetention: id("operational privacy placeholder").toLowerCase(),
        providerQuorum: upstream.candidate.record.artifacts.providerQuorum,
        reconciliation: upstream.candidate.record.reconciliation.reconciliationDigest,
        serviceIsolation: serviceIsolation.releaseEvidence?.evidenceDigest
          ?? buildServiceIsolationReleaseEvidence(serviceIsolation.verification).evidenceDigest,
        solverOperations: upstream.candidate.record.artifacts.solverOperations,
        supportPolicy: id("operational support placeholder").toLowerCase(),
        testQualification: upstream.candidate.record.artifacts.testQualification,
      }
    : {
        alertDelivery: id("bootstrap operational alert delivery evidence").toLowerCase(),
        backupRestore: upstream.candidate.record.artifacts.backupRestore,
        incidentDrills: upstream.candidate.record.artifacts.incidentDrills,
        lossAllocation: id("bootstrap operational loss allocation placeholder").toLowerCase(),
        monitoring: upstream.candidate.record.artifacts.monitoring,
        privacyRetention: id("bootstrap operational privacy placeholder").toLowerCase(),
        providerQuorum: upstream.candidate.record.artifacts.providerQuorum,
        reconciliation: id("bootstrap operational zero-liability reconciliation").toLowerCase(),
        serviceIsolation: serviceIsolation.releaseEvidence?.evidenceDigest
          ?? buildServiceIsolationReleaseEvidence(serviceIsolation.verification).evidenceDigest,
        solverOperations: upstream.candidate.record.artifacts.solverOperations,
        supportPolicy: id("bootstrap operational support placeholder").toLowerCase(),
        testQualification: upstream.candidate.record.artifacts.testQualification,
      };
  const scenarioEvidence = new Map(
    fundingMode === "operator-testnet"
      ? upstream.candidate.record.scenarios.map((scenario) => [scenario.name, scenario.evidenceDigest])
      : [],
  );
  const modeLimits = fundingMode === "operator-testnet"
    ? {
        maxDailyLightningSats: "100000",
        maxEpochSats: "50000",
        maxInFlightSats: "10000",
        maxPriceBandBps: "500",
        maxRoutingFeeSats: "100",
        maxSwapSats: "5000",
        minBitReserveWei: "1000000000000000000",
        minLightningReserveSats: "25000",
      }
    : {
        maxDailyLightningSats: "10000",
        maxEpochSats: "5000",
        maxInFlightSats: "1000",
        maxPriceBandBps: "250",
        maxRoutingFeeSats: "50",
        maxSwapSats: "500",
        minBitReserveWei: "1000000000000000000",
        minLightningReserveSats: "25000",
      };
  const upstreamAdmissionPolicy = fundingMode === "operator-testnet"
    ? upstream.candidate.policy.admissionPolicyDigest
    : upstream.candidate.record.artifacts.admissionPolicy;
  const upstreamRiskPolicy = fundingMode === "operator-testnet"
    ? upstream.candidate.policy.riskPolicyDigest
    : upstream.candidate.record.artifacts.riskPolicy;
  const upstreamFeeSchedule = fundingMode === "operator-testnet"
    ? upstream.candidate.policy.feeScheduleDigest
    : upstream.candidate.record.artifacts.feeSchedule;
  const adoptionPolicy = {
    schema: "treeswap.adoption-policy.v1",
    environment: "public-testnet",
    fundingMode,
    chainId: deployment.verification.record.chainId,
    verifyingContract: deployment.verification.record.verifyingContract,
    reviewedBuildCommit: deployment.verification.record.reviewedBuildCommit,
    protocolVersion,
    deploymentManifestDigest: deployment.verification.record.manifestDigest,
    admissionPolicyDigest: upstreamAdmissionPolicy,
    riskPolicyDigest: upstreamRiskPolicy,
    feeScheduleDigest: upstreamFeeSchedule,
    preparedAt,
    validUntil: preparedAt + 3_600,
    supportOwnerId: participants.find((participant) => participant.role === "support-owner").operatorId,
    incidentCommanderId: participants.find((participant) => participant.role === "incident-commander").operatorId,
    limits: modeLimits,
    fees: {
      baseBitToLightningBps: 72,
      baseLightningToBitBps: 18,
      maxFeeBps: 100,
      reserveFloorBps: 2_000,
      scarcityStartsBps: 6_000,
    },
    liveness: {
      bondPolicy: "no-bond-objective-history-only",
      establishedSolverMaxBitToLightningSats: fundingMode === "operator-testnet" ? "5000" : "500",
      lastLookAllowed: false,
      maxActiveFirmQuotesPerSolver: 2,
      maxCapacityAgeSeconds: 30,
      maxConsecutiveFailures: 2,
      maxFirmQuoteTtlSeconds: 30,
      maxGlobalBitToLightningInFlightSats: fundingMode === "operator-testnet" ? "10000" : "1000",
      minimumCompletedFillsForEstablished: 20,
      minimumReliabilityBps: 9_000,
      minimumReliabilitySample: 20,
      partialFillsAllowed: false,
      unknownSolverMaxBitToLightningSats: fundingMode === "operator-testnet" ? "500" : "100",
    },
    lossAllocation: {
      automaticReimbursement: false,
      inventoryOwnerBearsCustodyRisk: true,
      protocolInsuranceFund: false,
      solverBearsLightningDeliveryFailure: true,
      solverPaysLightningRoutingFees: true,
      unresolvedIncidentAction: "halt-and-case-review",
      userBearsOwnWalletAndNetworkFees: true,
    },
    privacy: {
      emailDeliveryEnabled: false,
      onchainLinkageDisclosed: true,
      preimageLoggingAllowed: false,
      pricingRequestRetentionSeconds: 600,
      rawInvoiceLoggingAllowed: false,
      rawTerminalPacketRetentionSeconds: 3_600,
      receiptRetentionSeconds: 2_592_000,
      selectedSolverMayLinkBothLegs: true,
    },
    support: {
      maxIncidentAcknowledgementSeconds: 900,
      maxUserResponseSeconds: 172_800,
      publicIncidentUpdates: true,
      securityUri: "https://github.com/bobofbuilding/treeswap/security/policy",
      statusUri: "https://github.com/bobofbuilding/treeswap/actions",
      supportUri: "https://github.com/bobofbuilding/treeswap/issues",
    },
    upgrades: {
      activeLiabilityMigrationAllowed: false,
      bitImplementationChangeAction: "halt-review-new-observation",
      bitPauseAction: "halt-until-unpaused-and-reviewed",
      emergencyAuthorityMayIncreaseRisk: false,
      treeswapContractChangeAction: "deploy-new-immutable-release",
    },
  };
  const adoption = buildAdoptionPolicyEvidence(adoptionPolicy);
  artifacts.lossAllocation = adoption.lossAllocationDigest;
  artifacts.privacyRetention = adoption.privacyRetentionDigest;
  artifacts.supportPolicy = adoption.supportPolicyDigest;
  const monitorPolicy = safetyMonitorPolicy({ deployment, upstream, preparedAt });
  const monitorPolicyDigest = safetyMonitorPolicyDigest(monitorPolicy);
  const gateConfirmerBindings = REQUIRED_GATE_CONFIRMER_SERVICE_ROLES.map((serviceRole, index) => {
    const service = serviceIsolation.verification.record.services.find((value) => value.role === serviceRole);
    const route = monitorPolicy.gateConfirmers[index];
    return {
      serviceRole,
      serviceId: service.serviceId,
      trustDomainId: service.trustDomainId,
      credentialSetDigest: service.credentialSetDigest,
      networkPolicyDigest: service.networkPolicyDigest,
      deploymentEvidenceDigest: service.deploymentEvidenceDigest,
      routeId: route.routeId,
      operatorId: route.operatorId,
    };
  });
  const gateConfirmerBindingDigest = operationalGateConfirmerBindingDigest(gateConfirmerBindings);
  const record = {
    schema: "treeswap.operational-readiness-evidence.v4",
    operationsId: id(`operational readiness:${fundingMode}:${preparedAt}`).toLowerCase(),
    environment: "public-testnet",
    fundingMode,
    chainId: deployment.verification.record.chainId,
    verifyingContract: deployment.verification.record.verifyingContract,
    reviewedBuildCommit: deployment.verification.record.reviewedBuildCommit,
    protocolVersion,
    deploymentManifestDigest: deployment.verification.record.manifestDigest,
    safetyMonitorPolicyDigest: monitorPolicyDigest,
    preparedAt,
    validUntil: preparedAt + 3_600,
    participants,
    alertChannelEvidenceDigests: fundingMode === "operator-testnet"
      ? [...upstream.candidate.record.alertChannelEvidenceDigests]
      : [...upstream.candidate.record.alertChannelEvidenceDigests],
    artifacts,
    gateConfirmerBindings,
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
        safetyControls: REQUIRED_FINALIZED_GATE_CONTROL_DRILLS.includes(name)
          ? {
              alertsPreservedOnConfirmationFailure: true,
              broadcasterAcceptanceRejected: true,
              bothConfirmersAttempted: true,
              exactFinalizedStateAgreementRequired: true,
              existingExitsPreserved: true,
              gateConfirmerBindingDigest,
              safetyMonitorPolicyDigest: monitorPolicyDigest,
            }
          : null,
      };
    }),
  };
  const policy = {
    schema: "treeswap.operational-readiness-evidence-policy.v4",
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
    requiredFinalizedGateControlDrills: [...REQUIRED_FINALIZED_GATE_CONTROL_DRILLS],
    requiredGateConfirmerServiceRoles: [...REQUIRED_GATE_CONFIRMER_SERVICE_ROLES],
    safetyMonitorPolicyDigest: monitorPolicyDigest,
  };
  return {
    adoptionPolicy,
    attestations: [],
    policy,
    record,
    safetyMonitorPolicy: monitorPolicy,
    wallets,
    serviceIsolationVerification: serviceIsolation.verification,
  };
}

export async function sign(value) {
  value.attestations = [];
  for (const participant of value.record.participants) {
    const typed = buildOperationalReadinessAttestationMessage({
      adoptionPolicy: value.adoptionPolicy,
      record: value.record,
      policy: value.policy,
      safetyMonitorPolicy: value.safetyMonitorPolicy,
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
