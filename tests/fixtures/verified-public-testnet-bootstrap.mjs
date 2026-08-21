import { Wallet, id } from "ethers";
import {
  buildPublicTestnetBootstrapAttestationMessage,
  verifyPublicTestnetBootstrapEvidence,
} from "../../lib/public-testnet-bootstrap-evidence.mjs";

const ROLES = ["evm-provider", "lightning-observer", "monitor", "relay", "solver"];

export function canonical(values, selector) {
  return [...values].sort((left, right) => selector(left).localeCompare(selector(right)));
}

export function fixture({ deployment, preparedAt }) {
  if (!deployment?.verification || !Number.isSafeInteger(preparedAt)) {
    throw new TypeError("verified deployment and preparedAt are required");
  }
  const wallets = new Map();
  const participants = [];
  const providerApprovers = deployment.candidate.approvers.filter((value) => value.role === "provider");
  for (const provider of providerApprovers) {
    wallets.set(provider.signer, provider.wallet);
    participants.push({
      role: "evm-provider",
      operatorId: provider.approverId,
      signer: provider.signer,
      evidenceDigest: id(`bootstrap retained provider evidence:${provider.approverId}`).toLowerCase(),
    });
  }
  for (const role of ROLES.filter((value) => value !== "evm-provider")) {
    for (let index = 0; index < 2; index += 1) {
      const wallet = new Wallet(id(`bootstrap ${role} wallet ${index}`));
      wallets.set(wallet.address, wallet);
      participants.push({
        role,
        operatorId: id(`bootstrap ${role} operator ${index}`).toLowerCase(),
        signer: wallet.address,
        evidenceDigest: id(`bootstrap retained ${role} evidence ${index}`).toLowerCase(),
      });
    }
  }
  const record = {
    schema: "treeswap.public-testnet-bootstrap-evidence.v2",
    bootstrapId: id(`bootstrap operator roster:${preparedAt}`).toLowerCase(),
    environment: "public-testnet",
    chainId: deployment.verification.record.chainId,
    verifyingContract: deployment.verification.record.verifyingContract,
    reviewedBuildCommit: deployment.verification.record.reviewedBuildCommit,
    deploymentManifestDigest: deployment.verification.record.manifestDigest,
    preparedAt,
    validUntil: preparedAt + 3_600,
    participants: canonical(participants, (value) => `${value.role}:${value.operatorId}`),
    alertChannelEvidenceDigests: canonical([
      id("bootstrap alert channel one evidence").toLowerCase(),
      id("bootstrap alert channel two evidence").toLowerCase(),
    ], (value) => value),
    artifacts: {
      admissionPolicy: id("bootstrap admission policy").toLowerCase(),
      backupRestore: id("bootstrap backup restore drill").toLowerCase(),
      feeSchedule: id("bootstrap fee schedule").toLowerCase(),
      findingsDisposition: id("bootstrap findings disposition").toLowerCase(),
      incidentDrills: id("bootstrap incident drills").toLowerCase(),
      monitoring: id("bootstrap monitoring evidence").toLowerCase(),
      providerQuorum: id("bootstrap provider quorum evidence").toLowerCase(),
      riskPolicy: id("bootstrap risk policy").toLowerCase(),
      solverOperations: id("bootstrap solver operations").toLowerCase(),
      testQualification: id("bootstrap qualification evidence").toLowerCase(),
    },
    features: {
      lpShares: false,
      mainnetAssets: false,
      makerRewards: false,
      operatorOwnedTestInventory: true,
      partialFills: false,
      publicLpDeposits: false,
      promisedYield: false,
      rewards: false,
    },
  };
  const policy = {
    schema: "treeswap.public-testnet-bootstrap-evidence-policy.v2",
    environment: record.environment,
    chainId: record.chainId,
    verifyingContract: record.verifyingContract,
    reviewedBuildCommit: record.reviewedBuildCommit,
    deploymentManifestDigest: record.deploymentManifestDigest,
    maximumEvidenceAgeSeconds: 3_600,
    maximumEvidenceLifetimeSeconds: 86_400,
    minimumCounts: {
      alertChannels: 2,
      evmProviders: 2,
      lightningObservers: 2,
      monitors: 2,
      relays: 2,
      solvers: 2,
    },
  };
  return { attestations: [], policy, record, wallets };
}

export async function sign(value) {
  value.attestations = [];
  for (const participant of value.record.participants) {
    const typed = buildPublicTestnetBootstrapAttestationMessage({
      record: value.record,
      policy: value.policy,
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
  value.attestations = canonical(value.attestations, (item) => `${item.role}:${item.operatorId}`);
  return value;
}

export async function createVerifiedPublicTestnetBootstrapFixture({ deployment, preparedAt, now = preparedAt + 60 }) {
  const candidate = await sign(fixture({ deployment, preparedAt }));
  const verification = verifyPublicTestnetBootstrapEvidence({ ...candidate, now });
  return Object.freeze({ candidate, verification });
}
