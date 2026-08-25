import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  Interface,
  TypedDataEncoder,
  Wallet,
  id,
  keccak256,
  recoverAddress,
} from "ethers";
import {
  activateReleaseCapabilities,
  buildReleaseApprovalMessage,
  erc1271ProviderSetDigest,
  RELEASE_APPROVAL_ROLES,
  RELEASE_APPROVAL_TYPES,
  releaseAuthorizationDomain,
} from "../lib/release-authorization.mjs";
import {
  buildPublicTestnetReleaseRoleApprovalPayload,
  createPublicTestnetReleaseApprovalProviderSet,
  inspectPreparedPublicTestnetReleaseCandidate,
  verifyPublicTestnetReleaseApprovals,
} from "../lib/public-testnet-release-approval.mjs";

const execFileAsync = promisify(execFile);
const NOW = 2_100_000_000;
const ZERO = `0x${"00".repeat(32)}`;
const CONTROLLER = "0x1111111111111111111111111111111111111111";
const GUARDIAN = "0x2222222222222222222222222222222222222222";
const GATE = "0x3333333333333333333333333333333333333333";
const BLOCK_HASH = id("release approval ceremony block").toLowerCase();
const CONTRACT_CODE = "0x60006000";
const CONTRACT_CODE_HASH = keccak256(CONTRACT_CODE).toLowerCase();
const PROVIDER_ONE = id("ceremony provider one").toLowerCase();
const PROVIDER_TWO = id("ceremony provider two").toLowerCase();
const ERC1271 = new Interface([
  "function isValidSignature(bytes32 digest, bytes signature) view returns (bytes4)",
]);
const controllerOwner = new Wallet(`0x${"14".padStart(64, "0")}`);
const guardianOwner = new Wallet(`0x${"15".padStart(64, "0")}`);
const lightningOperator = new Wallet(`0x${"11".padStart(64, "0")}`);
const securityReviewer = new Wallet(`0x${"12".padStart(64, "0")}`);
const incidentCommander = new Wallet(`0x${"13".padStart(64, "0")}`);

const evidenceFields = [
  "admissionPolicy",
  "backupRestore",
  "deploymentManifest",
  "deploymentPostflight",
  "deploymentPromotion",
  "feeSchedule",
  "findingsDisposition",
  "incidentDrills",
  "lossAllocation",
  "monitoring",
  "providerQuorum",
  "publicTestnet",
  "riskPolicy",
  "solverOperations",
  "supportPolicy",
  "testQualification",
];
const reviewFields = ["contracts", "coordinator", "identityPrivacy", "lightning", "operations"];
const qualifiedEvidenceFields = [
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
];

function digests(fields, prefix) {
  return Object.fromEntries(fields.map((field) => [field, id(`${prefix}:${field}`).toLowerCase()]));
}

function releaseRecord(now = NOW, overrides = {}) {
  return {
    schema: "treeswap.release-record.v2",
    releaseId: id(`approval ceremony release:${now}`).toLowerCase(),
    protocolVersion: "1.0.0-testnet.1",
    environment: "public-testnet",
    fundingMode: "operator-testnet",
    chainId: "11155111",
    verifyingContract: GATE,
    approvalBlockNumber: "100",
    approvalBlockHash: BLOCK_HASH,
    approvalBlockTimestamp: now,
    approvalProviderSetDigest: erc1271ProviderSetDigest([PROVIDER_ONE, PROVIDER_TWO]),
    reviewedBuildCommit: "b".repeat(40),
    priorReleaseDigest: ZERO,
    evidenceDigests: digests(evidenceFields, `release evidence:${now}`),
    reviewDigests: digests(reviewFields, `release review:${now}`),
    counts: {
      alertChannels: 2,
      independentEvmProviders: 2,
      independentLightningObservers: 2,
      independentMonitors: 2,
      independentRelays: 2,
      independentSolvers: 2,
      multisigOwnerCount: 3,
      multisigThreshold: 2,
    },
    limits: {
      maxDailyLightningSats: "100000",
      maxEpochSats: "50000",
      maxInFlightSats: "10000",
      maxPriceBandBps: "500",
      maxRoutingFeeSats: "100",
      maxSwapSats: "5000",
      minBitReserveWei: "1000000000000000000",
      minLightningReserveSats: "25000",
    },
    features: {
      lpShares: false,
      makerRewards: false,
      partialFills: false,
      promisedYield: false,
      publicLpDeposits: false,
      publicPermissionlessExecution: true,
      webSolverFunding: true,
    },
    validFrom: now - 60,
    validUntil: now + 3_500,
    ...overrides,
  };
}

function releasePolicy(record, overrides = {}) {
  return {
    schema: "treeswap.release-policy.v2",
    environment: record.environment,
    chainId: record.chainId,
    verifyingContract: record.verifyingContract,
    reviewedBuildCommit: record.reviewedBuildCommit,
    deploymentManifestDigest: record.evidenceDigests.deploymentManifest,
    deploymentPostflightDigest: record.evidenceDigests.deploymentPostflight,
    deploymentPromotionDigest: record.evidenceDigests.deploymentPromotion,
    admissionPolicyDigest: record.evidenceDigests.admissionPolicy,
    riskPolicyDigest: record.evidenceDigests.riskPolicy,
    feeScheduleDigest: record.evidenceDigests.feeSchedule,
    maximumReleaseLifetimeSeconds: 3_600,
    maximumRuntimeObservationAgeSeconds: 30,
    minimumCounts: structuredClone(record.counts),
    limitPolicy: {
      maximums: {
        maxDailyLightningSats: "100000",
        maxEpochSats: "50000",
        maxInFlightSats: "10000",
        maxPriceBandBps: "500",
        maxRoutingFeeSats: "100",
        maxSwapSats: "5000",
      },
      minimumReserves: {
        minBitReserveWei: "1000000000000000000",
        minLightningReserveSats: "25000",
      },
    },
    approvers: {
      controller: { address: CONTROLLER, codeHash: CONTRACT_CODE_HASH, signatureKind: "erc1271" },
      guardian: { address: GUARDIAN, codeHash: CONTRACT_CODE_HASH, signatureKind: "erc1271" },
      lightningOperator: { address: lightningOperator.address, codeHash: ZERO, signatureKind: "eip712" },
      securityReviewer: { address: securityReviewer.address, codeHash: ZERO, signatureKind: "eip712" },
      incidentCommander: { address: incidentCommander.address, codeHash: ZERO, signatureKind: "eip712" },
    },
    ...overrides,
  };
}

function preparedCandidate(now = NOW, recordOverrides = {}) {
  const record = releaseRecord(now, recordOverrides);
  const policy = releasePolicy(record);
  const message = buildReleaseApprovalMessage(record, policy);
  const domain = releaseAuthorizationDomain(record);
  return {
    schema: "treeswap.prepared-public-testnet-release-candidate.v6",
    status: "deployment-campaign-review-and-operations-evidence-verified-awaiting-five-role-release-approvals",
    scope: "release-preparation-only-no-signing-broadcast-gate-opening-or-funding-authorization",
    authorizations: { signing: false, broadcast: false, gateOpening: false, funding: false },
    recordDigest: message.recordDigest,
    policyDigest: message.policyDigest,
    record,
    policy,
    evidence: digests(qualifiedEvidenceFields, `candidate evidence:${now}`),
    adoptionSummary: { status: "fixture-only-not-upstream-verification" },
    approval: {
      primaryType: "ReleaseApproval",
      domain: { ...domain, chainId: domain.chainId.toString() },
      types: RELEASE_APPROVAL_TYPES,
      message,
    },
  };
}

async function approvalBundle(candidate) {
  const domain = releaseAuthorizationDomain(candidate.record);
  const message = buildReleaseApprovalMessage(candidate.record, candidate.policy);
  const typedDigest = TypedDataEncoder.hash(domain, RELEASE_APPROVAL_TYPES, message);
  return {
    schema: "treeswap.public-testnet-release-approvals.v1",
    releaseId: message.releaseId,
    recordDigest: message.recordDigest,
    policyDigest: message.policyDigest,
    approvals: [
      {
        role: "controller",
        signer: CONTROLLER,
        signatureKind: "erc1271",
        signature: controllerOwner.signingKey.sign(typedDigest).serialized,
      },
      {
        role: "guardian",
        signer: GUARDIAN,
        signatureKind: "erc1271",
        signature: guardianOwner.signingKey.sign(typedDigest).serialized,
      },
      {
        role: "lightningOperator",
        signer: lightningOperator.address,
        signatureKind: "eip712",
        signature: await lightningOperator.signTypedData(domain, RELEASE_APPROVAL_TYPES, message),
      },
      {
        role: "securityReviewer",
        signer: securityReviewer.address,
        signatureKind: "eip712",
        signature: await securityReviewer.signTypedData(domain, RELEASE_APPROVAL_TYPES, message),
      },
      {
        role: "incidentCommander",
        signer: incidentCommander.address,
        signatureKind: "eip712",
        signature: await incidentCommander.signTypedData(domain, RELEASE_APPROVAL_TYPES, message),
      },
    ],
  };
}

function rpcHandler(candidate, { badBlock = false, badChain = false, badCode = false } = {}) {
  const expectedOwners = {
    [CONTROLLER.toLowerCase()]: controllerOwner.address,
    [GUARDIAN.toLowerCase()]: guardianOwner.address,
  };
  return async (method, params) => {
    if (method === "eth_chainId") return badChain ? "0x1" : "0xaa36a7";
    if (method === "eth_getBlockByNumber") {
      return {
        number: "0x64",
        hash: badBlock ? id("wrong canonical block").toLowerCase() : candidate.record.approvalBlockHash,
        timestamp: `0x${candidate.record.approvalBlockTimestamp.toString(16)}`,
      };
    }
    if (method === "eth_getCode") return badCode ? "0x6001" : CONTRACT_CODE;
    if (method === "eth_call") {
      const [signedDigest, signature] = ERC1271.decodeFunctionData("isValidSignature", params[0].data);
      const expectedOwner = expectedOwners[String(params[0].to).toLowerCase()];
      let valid = false;
      try {
        valid = recoverAddress(signedDigest, signature) === expectedOwner;
      } catch {
        valid = false;
      }
      return ERC1271.encodeFunctionResult("isValidSignature", [valid ? "0x1626ba7e" : "0xffffffff"]);
    }
    throw new Error(`unexpected RPC method ${method}`);
  };
}

function providers(candidate, options = {}) {
  const rpcCall = rpcHandler(candidate, options);
  return [
    { identity: PROVIDER_ONE, rpcCall },
    { identity: PROVIDER_TWO, rpcCall },
  ];
}

test("prepares the exact policy-bound payload for each release role", () => {
  const candidate = preparedCandidate();
  const inspected = inspectPreparedPublicTestnetReleaseCandidate(structuredClone(candidate));
  assert.equal(inspected.recordDigest, candidate.recordDigest);
  assert.equal(inspected.policyDigest, candidate.policyDigest);
  assert.equal(inspected.candidate.record.fundingMode, "operator-testnet");
  for (const role of RELEASE_APPROVAL_ROLES) {
    const payload = buildPublicTestnetReleaseRoleApprovalPayload({ candidate, role, now: NOW });
    assert.equal(payload.role, role);
    assert.equal(payload.signer, candidate.policy.approvers[role].address);
    assert.equal(payload.signatureKind, candidate.policy.approvers[role].signatureKind);
    assert.deepEqual(payload.message, candidate.approval.message);
    assert.equal(
      payload.typedDigest,
      TypedDataEncoder.hash(
        releaseAuthorizationDomain(candidate.record),
        RELEASE_APPROVAL_TYPES,
        candidate.approval.message,
      ).toLowerCase(),
    );
    assert.equal(payload.authorizations.signing, false);
    assert.equal(payload.authorizations.funding, false);
  }
  assert.throws(
    () => buildPublicTestnetReleaseRoleApprovalPayload({ candidate, role: "treasury", now: NOW }),
    /role is invalid/,
  );
  assert.throws(
    () => buildPublicTestnetReleaseRoleApprovalPayload({ candidate, role: "controller", now: NOW + 3_601 }),
    /after release expiry/,
  );
});

test("rejects candidate artifact mutation and authority smuggling", () => {
  const candidate = preparedCandidate();
  const changedRecord = structuredClone(candidate);
  changedRecord.record.limits.maxSwapSats = "4999";
  assert.throws(() => inspectPreparedPublicTestnetReleaseCandidate(changedRecord), /digest does not match/);

  const changedDomain = structuredClone(candidate);
  changedDomain.approval.domain.chainId = "1";
  assert.throws(() => inspectPreparedPublicTestnetReleaseCandidate(changedDomain), /payload is inconsistent/);

  const authority = structuredClone(candidate);
  authority.authorizations.funding = true;
  assert.throws(() => inspectPreparedPublicTestnetReleaseCandidate(authority), /must remain false/);

  const extra = structuredClone(candidate);
  extra.activate = true;
  assert.throws(() => inspectPreparedPublicTestnetReleaseCandidate(extra), /fields are not exact/);

  for (const schema of [
    "treeswap.prepared-public-testnet-release-candidate.v2",
    "treeswap.prepared-public-testnet-release-candidate.v3",
    "treeswap.prepared-public-testnet-release-candidate.v4",
    "treeswap.prepared-public-testnet-release-candidate.v5",
  ]) {
    const legacy = structuredClone(candidate);
    legacy.schema = schema;
    assert.throws(() => inspectPreparedPublicTestnetReleaseCandidate(legacy), /schema is invalid/);
  }

  const wrongMode = structuredClone(candidate);
  wrongMode.record.fundingMode = "operator-testnet-bootstrap";
  assert.throws(() => inspectPreparedPublicTestnetReleaseCandidate(wrongMode), /funding mode|publicTestnet evidence/i);

  const downgradedController = structuredClone(candidate);
  downgradedController.policy.approvers.controller = {
    address: controllerOwner.address,
    codeHash: ZERO,
    signatureKind: "eip712",
  };
  const downgradedMessage = buildReleaseApprovalMessage(
    downgradedController.record,
    downgradedController.policy,
  );
  downgradedController.recordDigest = downgradedMessage.recordDigest;
  downgradedController.policyDigest = downgradedMessage.policyDigest;
  downgradedController.approval.message = downgradedMessage;
  assert.throws(
    () => inspectPreparedPublicTestnetReleaseCandidate(downgradedController),
    /controller approval must use ERC-1271/,
  );
});

test("verifies all five approvals but emits no reusable activation provenance", async () => {
  const candidate = preparedCandidate();
  const approvals = await approvalBundle(candidate);
  const receipt = await verifyPublicTestnetReleaseApprovals({
    candidate,
    approvalBundle: approvals,
    providers: providers(candidate),
    now: NOW,
  });
  assert.equal(receipt.status, "five-release-approvals-verified-no-capabilities-activated");
  assert.equal(receipt.approvalCount, 5);
  assert.equal(receipt.providerQuorum.count, 2);
  assert.equal(receipt.providerQuorum.digest, candidate.record.approvalProviderSetDigest);
  assert.equal(receipt.provenance.candidateArtifactSelfConsistencyVerified, true);
  assert.equal(receipt.provenance.upstreamEvidenceReverifiedFromReceipt, false);
  assert.equal(receipt.provenance.activationProvenance, false);
  assert.equal(receipt.authorizations.funding, false);
  assert.throws(() => activateReleaseCapabilities({ verification: receipt, now: NOW }), /not verified by this process/);
  const serialized = JSON.stringify(receipt);
  for (const approval of approvals.approvals) assert.equal(serialized.includes(approval.signature), false);
  assert.equal(serialized.includes("https://"), false);

  const reversed = { ...approvals, approvals: [...approvals.approvals].reverse() };
  const second = await verifyPublicTestnetReleaseApprovals({
    candidate,
    approvalBundle: reversed,
    providers: providers(candidate),
    now: NOW,
  });
  assert.equal(second.approvalBundleDigest, receipt.approvalBundleDigest);
});

test("fails closed on missing, substituted, replayed, expired, or non-canonical approvals", async () => {
  const candidate = preparedCandidate();
  const approvals = await approvalBundle(candidate);
  const missing = { ...approvals, approvals: approvals.approvals.slice(0, 4) };
  await assert.rejects(
    verifyPublicTestnetReleaseApprovals({ candidate, approvalBundle: missing, providers: providers(candidate), now: NOW }),
    /exactly five/,
  );

  const duplicate = structuredClone(approvals);
  duplicate.approvals[4] = structuredClone(duplicate.approvals[3]);
  await assert.rejects(
    verifyPublicTestnetReleaseApprovals({ candidate, approvalBundle: duplicate, providers: providers(candidate), now: NOW }),
    /duplicate securityReviewer/,
  );

  const wrongSigner = structuredClone(approvals);
  wrongSigner.approvals.find((value) => value.role === "lightningOperator").signer = Wallet.createRandom().address;
  await assert.rejects(
    verifyPublicTestnetReleaseApprovals({ candidate, approvalBundle: wrongSigner, providers: providers(candidate), now: NOW }),
    /identity does not match policy/,
  );

  const wrongSignature = structuredClone(approvals);
  wrongSignature.approvals.find((value) => value.role === "guardian").signature = controllerOwner.signingKey
    .sign(TypedDataEncoder.hash(
      releaseAuthorizationDomain(candidate.record),
      RELEASE_APPROVAL_TYPES,
      candidate.approval.message,
    )).serialized;
  await assert.rejects(
    verifyPublicTestnetReleaseApprovals({ candidate, approvalBundle: wrongSignature, providers: providers(candidate), now: NOW }),
    /guardian ERC-1271 signature is invalid/,
  );

  const replay = preparedCandidate(NOW + 10);
  await assert.rejects(
    verifyPublicTestnetReleaseApprovals({ candidate: replay, approvalBundle: approvals, providers: providers(replay), now: NOW + 10 }),
    /does not match the prepared candidate/,
  );

  await assert.rejects(
    verifyPublicTestnetReleaseApprovals({
      candidate,
      approvalBundle: approvals,
      providers: providers(candidate),
      now: candidate.record.validUntil + 1,
    }),
    /expired/,
  );
  await assert.rejects(
    verifyPublicTestnetReleaseApprovals({
      candidate,
      approvalBundle: approvals,
      providers: providers(candidate, { badBlock: true }),
      now: NOW,
    }),
    /ERC-1271 signature is invalid/,
  );
});

test("resolves only the candidate-bound secret-free provider configuration", () => {
  const candidate = preparedCandidate();
  const configuration = {
    schema: "treeswap.public-testnet-release-approval-providers.v1",
    providers: [
      { identity: PROVIDER_ONE, urlEnvironmentVariable: "TREESWAP_RELEASE_RPC_ONE_URL" },
      { identity: PROVIDER_TWO, urlEnvironmentVariable: "TREESWAP_RELEASE_RPC_TWO_URL" },
    ],
  };
  const providerSet = createPublicTestnetReleaseApprovalProviderSet({
    configuration,
    environment: {
      TREESWAP_RELEASE_RPC_ONE_URL: "https://one.example/rpc/private-token",
      TREESWAP_RELEASE_RPC_TWO_URL: "https://two.example/rpc/private-token",
    },
    expectedProviderCount: 2,
    expectedProviderSetDigest: candidate.record.approvalProviderSetDigest,
  });
  assert.equal(providerSet.providerCount, 2);
  assert.equal(providerSet.providerSetDigest, candidate.record.approvalProviderSetDigest);
  assert.equal(JSON.stringify(providerSet).includes("private-token"), false);

  assert.throws(
    () => createPublicTestnetReleaseApprovalProviderSet({
      configuration,
      environment: {
        TREESWAP_RELEASE_RPC_ONE_URL: "https://same.example/one",
        TREESWAP_RELEASE_RPC_TWO_URL: "https://same.example/two",
      },
      expectedProviderCount: 2,
      expectedProviderSetDigest: candidate.record.approvalProviderSetDigest,
    }),
    /distinct RPC URLs and origins/,
  );
  const substituted = structuredClone(configuration);
  substituted.providers[1].identity = id("attacker provider").toLowerCase();
  assert.throws(
    () => createPublicTestnetReleaseApprovalProviderSet({
      configuration: substituted,
      environment: {
        TREESWAP_RELEASE_RPC_ONE_URL: "https://one.example/rpc",
        TREESWAP_RELEASE_RPC_TWO_URL: "https://two.example/rpc",
      },
      expectedProviderCount: 2,
      expectedProviderSetDigest: candidate.record.approvalProviderSetDigest,
    }),
    /do not match the candidate/,
  );
});

async function startRpcServer(candidate) {
  const handleRpc = rpcHandler(candidate);
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", async () => {
      try {
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const result = await handleRpc(payload.method, payload.params);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result }));
      } catch {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "request rejected" }));
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}/rpc/private-token`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

test("operator CLIs prepare a role payload and write a private non-authorizing receipt", async () => {
  const now = Math.floor(Date.now() / 1_000);
  const candidate = preparedCandidate(now - 5, {
    validFrom: now - 60,
    validUntil: now + 600,
  });
  const approvals = await approvalBundle(candidate);
  const first = await startRpcServer(candidate);
  const second = await startRpcServer(candidate);
  const directory = await mkdtemp(join(tmpdir(), "treeswap-release-approval-"));
  try {
    const candidatePath = join(directory, "candidate.json");
    const approvalsPath = join(directory, "approvals.json");
    const providersPath = join(directory, "providers.json");
    const receiptPath = join(directory, "receipt.json");
    await writeFile(candidatePath, `${JSON.stringify(candidate)}\n`);
    await writeFile(approvalsPath, `${JSON.stringify(approvals)}\n`);
    await writeFile(providersPath, `${JSON.stringify({
      schema: "treeswap.public-testnet-release-approval-providers.v1",
      providers: [
        { identity: PROVIDER_ONE, urlEnvironmentVariable: "TREESWAP_RELEASE_RPC_ONE_URL" },
        { identity: PROVIDER_TWO, urlEnvironmentVariable: "TREESWAP_RELEASE_RPC_TWO_URL" },
      ],
    })}\n`);

    const prepared = await execFileAsync(process.execPath, [
      "scripts/prepare-public-testnet-release-approval.mjs",
      "--candidate", candidatePath,
      "--role", "securityReviewer",
    ], { encoding: "utf8" });
    const payload = JSON.parse(prepared.stdout);
    assert.equal(payload.role, "securityReviewer");
    assert.equal(payload.signingAuthorization, undefined);
    assert.equal(payload.authorizations.signing, false);

    const args = [
      "scripts/verify-public-testnet-release-approvals.mjs",
      "--candidate", candidatePath,
      "--approvals", approvalsPath,
      "--providers", providersPath,
      "--out", receiptPath,
    ];
    const environment = {
      ...process.env,
      TREESWAP_RELEASE_RPC_ONE_URL: first.url,
      TREESWAP_RELEASE_RPC_TWO_URL: second.url,
    };
    const verified = await execFileAsync(process.execPath, args, { encoding: "utf8", env: environment });
    const summary = JSON.parse(verified.stdout);
    assert.equal(summary.fundingAuthorization, false);
    assert.equal(summary.signingAuthorization, false);
    assert.equal(summary.approvalCount, 5);
    assert.equal((await stat(receiptPath)).mode & 0o777, 0o600);
    const receiptSource = await readFile(receiptPath, "utf8");
    const receipt = JSON.parse(receiptSource);
    assert.equal(receipt.authorizations.funding, false);
    assert.equal(receipt.provenance.activationProvenance, false);
    assert.equal(receiptSource.includes("private-token"), false);
    for (const approval of approvals.approvals) assert.equal(receiptSource.includes(approval.signature), false);
    await assert.rejects(
      execFileAsync(process.execPath, args, { encoding: "utf8", env: environment }),
      /EEXIST|exist/i,
    );
  } finally {
    await Promise.all([first.close(), second.close()]);
    await rm(directory, { recursive: true, force: true });
  }
});
