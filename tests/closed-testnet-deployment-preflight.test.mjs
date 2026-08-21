import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  Interface,
  Wallet,
  getAddress,
  id,
  keccak256,
  parseEther,
  zeroPadValue,
} from "ethers";
import { EIP1967_IMPLEMENTATION_SLOT } from "../lib/bit-deployment-observer.mjs";
import { buildClosedTestnetDeploymentPlan } from "../lib/closed-testnet-deployment-plan.mjs";
import { observeClosedTestnetDeploymentPreflight } from "../lib/closed-testnet-deployment-preflight-observer.mjs";
import {
  assertClosedTestnetDeploymentPreflightIsSecretFree,
  buildClosedTestnetDeploymentPreflightApprovalMessage,
  buildClosedTestnetDeploymentPreflightRecord,
  buildClosedTestnetDeploymentPreflightSummary,
  closedTestnetDeploymentPreflightValueDigest,
  verifyClosedTestnetDeploymentPreflight,
} from "../lib/closed-testnet-deployment-preflight.mjs";
import { closedTestnetArtifactFixtures } from "./fixtures/closed-testnet-artifacts.mjs";

const NOW = Math.floor(Date.now() / 1_000);
const BLOCK = 8_765_432;
const BLOCK_HASH = id("closed testnet preflight block").toLowerCase();
const ROLE_INTERFACE = new Interface([
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
]);
const BIT_INTERFACE = new Interface([
  "function decimals() view returns (uint8)",
  "function paused() view returns (bool)",
  "function symbol() view returns (string)",
]);

function address(index) {
  return getAddress(`0x${index.toString(16).padStart(40, "0")}`);
}

function role(wallet, owners, codeHash = id(`role ${wallet} runtime`).toLowerCase()) {
  return {
    address: address(wallet),
    ownerAddresses: owners.map(address),
    threshold: 2,
    runtimeCodeHash: codeHash,
  };
}

function risk() {
  return {
    maxFeeBps: "100",
    maxPriceDeviationBps: "1000",
    referenceSatsPerBit: "100",
    epochDurationSeconds: "86400",
    minSettlementWindowSeconds: "1800",
    minClaimBufferSeconds: "900",
    maxLockDurationSeconds: "172800",
    maxSwapAmountWei: parseEther("10").toString(),
    maxEpochVolumeWei: parseEther("100").toString(),
  };
}

function deploymentInput(overrides = {}) {
  return {
    schema: "treeswap.closed-testnet-deployment-input.v1",
    environment: "public-testnet",
    chainId: "11155111",
    reviewedBuildCommit: "1".repeat(40),
    independentReviewDigest: id("preflight independent review").toLowerCase(),
    deployer: address(1),
    startingNonce: "7",
    roles: {
      controller: role(2, [10, 11, 12]),
      feeCollector: role(3, [13, 14, 15]),
      guardian: role(4, [16, 17, 18]),
    },
    bit: {
      tokenBoundary: "reviewed-public-testnet-bit-proxy",
      proxyAddress: address(5),
      implementationAddress: address(6),
      proxyCodeHash: id("preflight BIT proxy").toLowerCase(),
      implementationCodeHash: id("preflight BIT implementation").toLowerCase(),
      symbol: "BIT",
      decimals: 18,
      paused: false,
    },
    gate: { resumeDelaySeconds: 86_400, maxOpenDurationSeconds: 172_800 },
    vaultRisk: risk(),
    userEscrowRisk: risk(),
    ...overrides,
  };
}

async function fixture() {
  const plan = await buildClosedTestnetDeploymentPlan({
    input: deploymentInput(),
    artifacts: closedTestnetArtifactFixtures(),
  });
  const wallets = [
    new Wallet(`0x${"11".repeat(32)}`),
    new Wallet(`0x${"22".repeat(32)}`),
    new Wallet(`0x${"33".repeat(32)}`),
  ];
  const providerIdentities = [id("preflight provider alpha").toLowerCase(), id("preflight provider beta").toLowerCase()]
    .sort();
  const approvers = [
    { role: "operations-reviewer", approverId: id("preflight operations reviewer").toLowerCase(), wallet: wallets[0] },
    { role: "provider", approverId: providerIdentities[0], wallet: wallets[1] },
    { role: "provider", approverId: providerIdentities[1], wallet: wallets[2] },
  ].sort((left, right) => `${left.role}:${left.approverId}`.localeCompare(`${right.role}:${right.approverId}`));
  const policy = {
    schema: "treeswap.closed-testnet-deployment-preflight-policy.v1",
    environment: "public-testnet",
    chainId: plan.network.chainId,
    verifyingContract: plan.deploymentTransactions[0].expectedContractAddress,
    reviewedBuildCommit: plan.source.reviewedBuildCommit,
    independentReviewDigest: plan.source.independentReviewDigest,
    inputDigest: plan.inputDigest,
    planDigest: plan.planDigest,
    minimumProviderCount: 2,
    maximumObservationAgeSeconds: 300,
    maximumBlockAgeSeconds: 300,
    maximumPreflightLifetimeSeconds: 600,
    approvers: approvers.map(({ role: approverRole, approverId, wallet }) => ({
      role: approverRole,
      approverId,
      signer: wallet.address,
    })),
  };
  const observations = providerIdentities.map((providerIdentity, index) => ({
    schema: "treeswap.closed-testnet-deployment-preflight-observation.v1",
    evidenceStatus: "unreviewed-live-preflight-observation",
    observedAt: new Date((NOW - 5 + index) * 1_000).toISOString(),
    providerLabel: `independent-provider-${index + 1}`,
    providerIdentity,
    sourceCommit: plan.source.reviewedBuildCommit,
    chainId: plan.network.chainId,
    planDigest: plan.planDigest,
    inputDigest: plan.inputDigest,
    anchorBlock: { number: String(BLOCK), hash: BLOCK_HASH, timestamp: NOW - 30 },
    stateAnchor: { blockHash: BLOCK_HASH, requireCanonical: true },
    deployer: {
      address: plan.deployer.address,
      codeEmpty: true,
      anchoredNonce: plan.deployer.startingNonce,
      pendingNonceBefore: plan.deployer.startingNonce,
      pendingNonceAfter: plan.deployer.startingNonce,
    },
    deploymentTargets: plan.deploymentTransactions.map((transaction) => ({
      name: transaction.name,
      address: transaction.expectedContractAddress,
      codeEmpty: true,
    })),
    roles: structuredClone(plan.roles),
    bit: {
      proxyAddress: plan.bit.proxyAddress,
      implementationAddress: plan.bit.implementationAddress,
      implementationSlot: EIP1967_IMPLEMENTATION_SLOT,
      proxyCodeHash: plan.bit.proxyCodeHash,
      implementationCodeHash: plan.bit.implementationCodeHash,
      symbol: plan.bit.symbol,
      decimals: plan.bit.decimals,
      paused: plan.bit.paused,
    },
  }));
  const record = {
    schema: "treeswap.closed-testnet-deployment-preflight-record.v1",
    preflightId: id("closed testnet deployment preflight").toLowerCase(),
    environment: "public-testnet",
    chainId: plan.network.chainId,
    verifyingContract: plan.deploymentTransactions[0].expectedContractAddress,
    reviewedBuildCommit: plan.source.reviewedBuildCommit,
    independentReviewDigest: plan.source.independentReviewDigest,
    inputDigest: plan.inputDigest,
    planDigest: plan.planDigest,
    deployer: plan.deployer.address,
    startingNonce: plan.deployer.startingNonce,
    anchorBlockNumber: String(BLOCK),
    anchorBlockHash: BLOCK_HASH,
    providerObservations: observations.map((observation) => ({
      providerIdentity: observation.providerIdentity,
      observationDigest: closedTestnetDeploymentPreflightValueDigest(observation),
    })),
    preparedAt: NOW,
    validUntil: NOW + 600,
  };
  return { plan, policy, record, observations, approvers };
}

async function attestations(candidate) {
  const values = [];
  for (const approver of candidate.approvers) {
    const approval = buildClosedTestnetDeploymentPreflightApprovalMessage({
      plan: candidate.plan,
      policy: candidate.policy,
      record: candidate.record,
      observations: candidate.observations,
      role: approver.role,
      approverId: approver.approverId,
    });
    values.push({
      role: approver.role,
      approverId: approver.approverId,
      signer: approver.wallet.address,
      signature: await approver.wallet.signTypedData(approval.domain, approval.types, approval.value),
    });
  }
  return values.sort((left, right) => `${left.role}:${left.approverId}`.localeCompare(`${right.role}:${right.approverId}`));
}

test("two providers and one operations reviewer attest one fresh exact unsigned plan", async () => {
  const candidate = await fixture();
  const rebuiltRecord = buildClosedTestnetDeploymentPreflightRecord({
    plan: candidate.plan,
    policy: candidate.policy,
    observations: candidate.observations,
    preflightId: candidate.record.preflightId,
    preparedAt: NOW,
  });
  assert.deepEqual(rebuiltRecord, candidate.record);
  const signed = await attestations(candidate);
  const result = verifyClosedTestnetDeploymentPreflight({ ...candidate, attestations: signed, now: NOW });
  assert.equal(result.status, "cryptographically-verified-closed-testnet-deployment-preflight");
  assert.equal(result.planDigest, candidate.plan.planDigest);
  assert.equal(result.providerCount, 2);
  assert.equal(result.signingAuthorization, false);
  assert.equal(result.broadcastAuthorization, false);
  assert.equal(result.gateOpeningAuthorization, false);
  assert.equal(result.fundingAuthorization, false);
  const summary = buildClosedTestnetDeploymentPreflightSummary(result);
  assert.equal(summary.scope, result.scope);
  assert.equal(summary.fundingAuthorization, false);
  assert.throws(() => buildClosedTestnetDeploymentPreflightSummary(structuredClone(result)), /provenance/);
  assertClosedTestnetDeploymentPreflightIsSecretFree({ ...candidate, attestations: signed });
});

test("nonce, plan, role, BIT, block, observation, and policy mutations fail closed", async () => {
  const cases = [
    [(value) => { value.observations[0].deployer.pendingNonceAfter = "8"; }, /nonce/],
    [(value) => { value.observations[0].deployer.codeEmpty = false; }, /nonce|deployer/],
    [(value) => { value.observations[0].deploymentTargets[2].codeEmpty = false; }, /occupied|target/],
    [(value) => { value.observations[0].roles.guardian.threshold = 1; }, /role|wallet|plan/],
    [(value) => { value.observations[0].bit.paused = true; }, /BIT state/],
    [(value) => { value.observations[0].stateAnchor.requireCanonical = false; }, /anchored/],
    [(value) => { value.observations[0].anchorBlock.timestamp = NOW - 301; }, /stale/],
    [(value) => { value.record.startingNonce = "8"; }, /startingNonce/],
    [(value) => { value.record.anchorBlockHash = id("different block").toLowerCase(); }, /anchored/],
    [(value) => { value.policy.maximumPreflightLifetimeSeconds = 901; }, /fifteen minutes/],
    [(value) => { value.policy.approvers[2].signer = value.policy.approvers[1].signer; }, /globally distinct/],
    [(value) => { value.plan.permissions.signingAuthorization = true; }, /authorization|digest/],
    [(value) => { value.observations[0].providerLabel = value.observations[1].providerLabel; }, /labels must be distinct/],
  ];
  for (const [mutate, pattern] of cases) {
    const candidate = await fixture();
    candidate.plan = structuredClone(candidate.plan);
    mutate(candidate);
    await assert.rejects(() => attestations(candidate), pattern);
  }
});

test("missing, replayed, forged, future, expired, and secret-bearing attestations fail closed", async () => {
  const candidate = await fixture();
  const signed = await attestations(candidate);
  assert.throws(
    () => verifyClosedTestnetDeploymentPreflight({ ...candidate, attestations: signed.slice(1), now: NOW }),
    /every preflight approver/,
  );
  assert.throws(
    () => verifyClosedTestnetDeploymentPreflight({ ...candidate, attestations: [signed[0], signed[0], signed[2]], now: NOW }),
    /ordered|duplicated|every preflight/,
  );
  const forged = structuredClone(signed);
  forged[0].signature = forged[1].signature;
  assert.throws(
    () => verifyClosedTestnetDeploymentPreflight({ ...candidate, attestations: forged, now: NOW }),
    /signature is invalid/,
  );
  assert.throws(
    () => verifyClosedTestnetDeploymentPreflight({ ...candidate, attestations: signed, now: NOW - 1 }),
    /future-dated/,
  );
  assert.throws(
    () => verifyClosedTestnetDeploymentPreflight({ ...candidate, attestations: signed, now: NOW + 601 }),
    /expired/,
  );
  const secret = await fixture();
  secret.observations[0].providerLabel = "https://private-rpc.invalid";
  secret.record.providerObservations[0].observationDigest = closedTestnetDeploymentPreflightValueDigest(secret.observations[0]);
  await assert.rejects(() => attestations(secret), /secret|endpoint/);
});

function livePlanInput() {
  const roleCodes = { controller: "0x6001", feeCollector: "0x6002", guardian: "0x6003" };
  const proxyCode = "0x6004";
  const implementationCode = "0x6005";
  const value = deploymentInput();
  value.roles.controller.runtimeCodeHash = keccak256(roleCodes.controller).toLowerCase();
  value.roles.feeCollector.runtimeCodeHash = keccak256(roleCodes.feeCollector).toLowerCase();
  value.roles.guardian.runtimeCodeHash = keccak256(roleCodes.guardian).toLowerCase();
  value.bit.proxyCodeHash = keccak256(proxyCode).toLowerCase();
  value.bit.implementationCodeHash = keccak256(implementationCode).toLowerCase();
  return { value, roleCodes, proxyCode, implementationCode };
}

function fakeRpc(plan, codes, {
  changedPendingNonce = false,
  changedBlock = false,
  occupiedTarget = false,
  paused = false,
} = {}) {
  let pendingReads = 0;
  return async (method, params) => {
    if (method === "eth_chainId") return "0xaa36a7";
    if (method === "eth_getBlockByNumber") {
      const recheck = params[0] !== "latest";
      return {
        number: `0x${BLOCK.toString(16)}`,
        hash: recheck && changedBlock ? id("reorged preflight block").toLowerCase() : BLOCK_HASH,
        timestamp: `0x${(NOW - 30).toString(16)}`,
      };
    }
    if (method === "eth_getTransactionCount") {
      if (params[1] === "pending") {
        pendingReads += 1;
        return changedPendingNonce && pendingReads > 1 ? "0x8" : "0x7";
      }
      assert.deepEqual(params[1], { blockHash: BLOCK_HASH, requireCanonical: true });
      return "0x7";
    }
    if (method === "eth_getCode") {
      const target = getAddress(params[0]);
      if (target === plan.roles.controller.address) return codes.roleCodes.controller;
      if (target === plan.roles.feeCollector.address) return codes.roleCodes.feeCollector;
      if (target === plan.roles.guardian.address) return codes.roleCodes.guardian;
      if (target === plan.bit.proxyAddress) return codes.proxyCode;
      if (target === plan.bit.implementationAddress) return codes.implementationCode;
      if (target === plan.deployer.address) return "0x";
      if (plan.deploymentTransactions.some((transaction) => target === transaction.expectedContractAddress)) {
        return occupiedTarget && target === plan.deploymentTransactions[2].expectedContractAddress ? "0x6006" : "0x";
      }
      throw new Error("unexpected code target");
    }
    if (method === "eth_getStorageAt") {
      assert.equal(params[0], plan.bit.proxyAddress);
      assert.equal(params[1], EIP1967_IMPLEMENTATION_SLOT);
      return zeroPadValue(plan.bit.implementationAddress, 32);
    }
    if (method === "eth_call") {
      const target = getAddress(params[0].to);
      const data = params[0].data;
      for (const roleName of ["controller", "feeCollector", "guardian"]) {
        const expected = plan.roles[roleName];
        if (target === expected.address) {
          if (data === ROLE_INTERFACE.encodeFunctionData("getOwners")) {
            return ROLE_INTERFACE.encodeFunctionResult("getOwners", [expected.ownerAddresses]);
          }
          if (data === ROLE_INTERFACE.encodeFunctionData("getThreshold")) {
            return ROLE_INTERFACE.encodeFunctionResult("getThreshold", [expected.threshold]);
          }
        }
      }
      if (target === plan.bit.proxyAddress) {
        if (data === BIT_INTERFACE.encodeFunctionData("decimals")) {
          return BIT_INTERFACE.encodeFunctionResult("decimals", [18]);
        }
        if (data === BIT_INTERFACE.encodeFunctionData("paused")) {
          return BIT_INTERFACE.encodeFunctionResult("paused", [paused]);
        }
        if (data === BIT_INTERFACE.encodeFunctionData("symbol")) {
          return BIT_INTERFACE.encodeFunctionResult("symbol", ["BIT"]);
        }
      }
    }
    throw new Error(`unexpected RPC method ${method}`);
  };
}

test("live observer anchors every read and rejects nonce movement, reorg, and BIT drift", async () => {
  const codes = livePlanInput();
  const plan = await buildClosedTestnetDeploymentPlan({ input: codes.value, artifacts: closedTestnetArtifactFixtures() });
  const observed = await observeClosedTestnetDeploymentPreflight({
    rpcCall: fakeRpc(plan, codes),
    plan,
    providerIdentity: id("live preflight provider").toLowerCase(),
    providerLabel: "live-provider-one",
    observedAt: new Date((NOW - 5) * 1_000),
  });
  assert.equal(observed.deployer.anchoredNonce, "7");
  assert.equal(observed.deployer.pendingNonceBefore, "7");
  assert.equal(observed.deployer.pendingNonceAfter, "7");
  assert.equal(observed.stateAnchor.requireCanonical, true);
  await assert.rejects(
    observeClosedTestnetDeploymentPreflight({
      rpcCall: fakeRpc(plan, codes, { changedPendingNonce: true }),
      plan,
      providerIdentity: id("live preflight provider").toLowerCase(),
      providerLabel: "live-provider-one",
    }),
    /nonce changed/,
  );
  await assert.rejects(
    observeClosedTestnetDeploymentPreflight({
      rpcCall: fakeRpc(plan, codes, { changedBlock: true }),
      plan,
      providerIdentity: id("live preflight provider").toLowerCase(),
      providerLabel: "live-provider-one",
    }),
    /block changed/,
  );
  await assert.rejects(
    observeClosedTestnetDeploymentPreflight({
      rpcCall: fakeRpc(plan, codes, { paused: true }),
      plan,
      providerIdentity: id("live preflight provider").toLowerCase(),
      providerLabel: "live-provider-one",
    }),
    /BIT state/,
  );
  await assert.rejects(
    observeClosedTestnetDeploymentPreflight({
      rpcCall: fakeRpc(plan, codes, { occupiedTarget: true }),
      plan,
      providerIdentity: id("live preflight provider").toLowerCase(),
      providerLabel: "live-provider-one",
    }),
    /target is already occupied/,
  );
});

test("prepare and verify CLIs emit typed data and a provenance-bound no-authority summary", async () => {
  const candidate = await fixture();
  const signed = await attestations(candidate);
  const directory = await mkdtemp(join(tmpdir(), "treeswap-deployment-preflight-"));
  try {
    const values = {
      plan: candidate.plan,
      record: candidate.record,
      policy: candidate.policy,
      observations: candidate.observations,
      attestations: signed,
    };
    const paths = Object.fromEntries(Object.keys(values).map((name) => [name, join(directory, `${name}.json`)]));
    await Promise.all(Object.entries(values).map(([name, value]) => writeFile(
      paths[name],
      `${JSON.stringify(value)}\n`,
      { mode: 0o600 },
    )));
    const preparedRecordPath = join(directory, "prepared-record.json");
    const preparedRecord = JSON.parse(execFileSync(process.execPath, [
      "scripts/prepare-closed-testnet-deployment-preflight-record.mjs",
      "--plan", paths.plan,
      "--policy", paths.policy,
      "--observations", paths.observations,
      "--preflight-id", candidate.record.preflightId,
      "--out", preparedRecordPath,
    ], { cwd: resolve(new URL("..", import.meta.url).pathname), encoding: "utf8" }));
    assert.equal(preparedRecord.status, "prepared-fresh-closed-testnet-deployment-preflight-record");
    assert.equal(preparedRecord.fundingAuthorization, false);
    assert.equal(JSON.parse(await readFile(preparedRecordPath, "utf8")).planDigest, candidate.plan.planDigest);
    const approver = candidate.approvers[0];
    const prepared = JSON.parse(execFileSync(process.execPath, [
      "scripts/prepare-closed-testnet-deployment-preflight-approval.mjs",
      "--plan", paths.plan,
      "--record", paths.record,
      "--policy", paths.policy,
      "--observations", paths.observations,
      "--role", approver.role,
      "--approver-id", approver.approverId,
    ], { cwd: resolve(new URL("..", import.meta.url).pathname), encoding: "utf8" }));
    assert.equal(prepared.primaryType, "ClosedTestnetDeploymentPreflightApproval");
    assert.match(prepared.scope, /no-signing-broadcast-gate-opening-or-funding-authorization/);
    const verified = JSON.parse(execFileSync(process.execPath, [
      "scripts/verify-closed-testnet-deployment-preflight.mjs",
      "--plan", paths.plan,
      "--record", paths.record,
      "--policy", paths.policy,
      "--observations", paths.observations,
      "--attestations", paths.attestations,
    ], {
      cwd: resolve(new URL("..", import.meta.url).pathname),
      encoding: "utf8",
      env: { ...process.env },
    }));
    assert.equal(verified.status, "cryptographically-verified-closed-testnet-deployment-preflight");
    assert.equal(verified.summary.fundingAuthorization, false);
    assert.equal(JSON.stringify(verified).includes("privateKey"), false);
    assert.equal((await readFile(paths.attestations, "utf8")).includes("rpc"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
