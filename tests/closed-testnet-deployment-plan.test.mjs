import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  Interface,
  getAddress,
  getCreateAddress,
  id,
} from "ethers";
import {
  assertClosedTestnetDeploymentPlanIsSecretFree,
  buildClosedTestnetDeploymentPlan,
  verifyClosedTestnetDeploymentPlan,
} from "../lib/closed-testnet-deployment-plan.mjs";
import { closedTestnetArtifactFixtures } from "./fixtures/closed-testnet-artifacts.mjs";

function address(index) {
  return getAddress(`0x${index.toString(16).padStart(40, "0")}`);
}

async function artifacts() {
  return closedTestnetArtifactFixtures();
}

function role(roleAddress, ownerStart, label) {
  return {
    address: roleAddress,
    ownerAddresses: [address(ownerStart + 2), address(ownerStart), address(ownerStart + 1)],
    threshold: 2,
    runtimeCodeHash: id(`${label} runtime`).toLowerCase(),
  };
}

function risk(overrides = {}) {
  return {
    maxFeeBps: "100",
    maxPriceDeviationBps: "1000",
    referenceSatsPerBit: "100",
    epochDurationSeconds: "86400",
    minSettlementWindowSeconds: "1800",
    minClaimBufferSeconds: "900",
    maxLockDurationSeconds: "172800",
    maxSwapAmountWei: "10000000000000000000",
    maxEpochVolumeWei: "100000000000000000000",
    ...overrides,
  };
}

function input(overrides = {}) {
  return {
    schema: "treeswap.closed-testnet-deployment-input.v1",
    environment: "public-testnet",
    chainId: "11155111",
    reviewedBuildCommit: "1".repeat(40),
    independentReviewDigest: id("independent review").toLowerCase(),
    deployer: address(50),
    startingNonce: "7",
    roles: {
      controller: role(address(60), 100, "controller"),
      guardian: role(address(61), 110, "guardian"),
      feeCollector: role(address(62), 120, "fee collector"),
    },
    bit: {
      tokenBoundary: "reviewed-public-testnet-bit-proxy",
      proxyAddress: address(70),
      implementationAddress: address(71),
      proxyCodeHash: id("BIT proxy runtime").toLowerCase(),
      implementationCodeHash: id("BIT implementation runtime").toLowerCase(),
      symbol: "BIT",
      decimals: 18,
      paused: false,
    },
    gate: {
      resumeDelaySeconds: 86_400,
      maxOpenDurationSeconds: 172_800,
    },
    vaultRisk: risk(),
    userEscrowRisk: risk({ maxSwapAmountWei: "5000000000000000000" }),
    ...overrides,
  };
}

test("builds one deterministic Sepolia plan with exact CREATE addresses and hash-linked Safe calls", async () => {
  const artifactSet = await artifacts();
  const deploymentInput = input();
  const plan = await buildClosedTestnetDeploymentPlan({ input: deploymentInput, artifacts: artifactSet });
  assert.equal(plan.schema, "treeswap.closed-testnet-deployment-plan.v1");
  assert.equal(plan.environment, "public-testnet");
  assert.equal(plan.network.name, "sepolia");
  assert.equal(plan.network.chainId, "11155111");
  assert.equal(plan.network.mainnetAssets, false);
  assert.equal(plan.scope, "unsigned-public-testnet-plan-no-signing-broadcast-or-funding-authorization");
  assert.equal(plan.deploymentTransactions.length, 4);
  for (let index = 0; index < plan.deploymentTransactions.length; index += 1) {
    const transaction = plan.deploymentTransactions[index];
    assert.equal(transaction.kind, "unsigned-contract-creation");
    assert.equal(transaction.from, deploymentInput.deployer);
    assert.equal(transaction.to, null);
    assert.equal(transaction.valueWei, "0");
    assert.equal(transaction.nonce, String(7 + index));
    assert.equal(transaction.expectedContractAddress, getCreateAddress({
      from: deploymentInput.deployer,
      nonce: 7 + index,
    }));
    assert.match(transaction.data, /^0x[0-9a-f]+$/);
    assert.match(transaction.initCodeHash, /^0x[0-9a-f]{64}$/);
  }

  const registryInterface = new Interface(artifactSet.paymentHashRegistry.abi);
  const [vaultAddress, userEscrowAddress] = [
    plan.deploymentTransactions[2].expectedContractAddress,
    plan.deploymentTransactions[3].expectedContractAddress,
  ];
  assert.deepEqual(
    registryInterface.decodeFunctionData("registerEscrow", plan.controllerSafeActions[0].data).toArray(),
    [vaultAddress],
  );
  assert.deepEqual(
    registryInterface.decodeFunctionData("registerEscrow", plan.controllerSafeActions[1].data).toArray(),
    [userEscrowAddress],
  );
  assert.equal(registryInterface.parseTransaction({ data: plan.controllerSafeActions[2].data }).name, "seal");
  assert.equal(plan.controllerSafeActions[0].previousActionDigest, `0x${"00".repeat(32)}`);
  assert.equal(plan.controllerSafeActions[1].previousActionDigest, plan.controllerSafeActions[0].actionDigest);
  assert.equal(plan.controllerSafeActions[2].previousActionDigest, plan.controllerSafeActions[1].actionDigest);
  assert.deepEqual(plan.requiredPostconditions.registeredEscrows, [vaultAddress, userEscrowAddress]);
  assert.equal(plan.requiredPostconditions.gateClosed, true);
  assert.equal(plan.requiredPostconditions.registrySealed, true);
  assert.equal(plan.requiredPostconditions.vaultAccountedBalanceWei, "0");
  assert.equal(plan.requiredPostconditions.vaultBitBalanceWei, "0");
  assert.equal(plan.requiredPostconditions.userEscrowBitBalanceWei, "0");
  assert.equal(plan.requiredPostconditions.fundingAuthorization, false);
  assert.equal(plan.requiredPreflight.deployerHasNoRuntimeCode, true);
  assert.equal(plan.requiredPreflight.deploymentTargetsEmpty, true);
  assert.equal(plan.requiredPreflight.pendingNonceStableBeforeAndAfterObservation, true);
  assert.deepEqual(plan.permissions, {
    signingAuthorization: false,
    broadcastAuthorization: false,
    gateOpeningAuthorization: false,
    fundingAuthorization: false,
  });
  assert.equal(JSON.stringify(plan).length < 1_000_000, true);
  assertClosedTestnetDeploymentPlanIsSecretFree(plan);

  const rebuilt = await buildClosedTestnetDeploymentPlan({ input: structuredClone(deploymentInput), artifacts: artifactSet });
  assert.deepEqual(rebuilt, plan);
  const verified = await verifyClosedTestnetDeploymentPlan({ input: deploymentInput, artifacts: artifactSet, plan });
  assert.equal(verified.status, "exact-unsigned-plan-verified");
  assert.equal(verified.planDigest, plan.planDigest);
  assert.equal(verified.fundingAuthorization, false);
});

test("every plan mutation fails exact independent reconstruction", async () => {
  const artifactSet = await artifacts();
  const deploymentInput = input();
  const original = await buildClosedTestnetDeploymentPlan({ input: deploymentInput, artifacts: artifactSet });
  const mutations = [
    (plan) => { plan.network.chainId = "1"; },
    (plan) => { plan.deploymentTransactions[0].nonce = "8"; },
    (plan) => { plan.deploymentTransactions[1].expectedContractAddress = address(999); },
    (plan) => {
      const lastByte = plan.deploymentTransactions[2].data.slice(-2);
      plan.deploymentTransactions[2].data = `${plan.deploymentTransactions[2].data.slice(0, -2)}${lastByte === "00" ? "01" : "00"}`;
    },
    (plan) => { plan.controllerSafeActions.reverse(); },
    (plan) => { plan.controllerSafeActions[0].previousActionDigest = id("rewritten history").toLowerCase(); },
    (plan) => { plan.requiredPostconditions.gateClosed = false; },
    (plan) => { plan.requiredPostconditions.fundingAuthorization = true; },
    (plan) => { plan.planDigest = id("forged plan").toLowerCase(); },
    (plan) => { plan.rpcUrl = "https://example.invalid"; },
  ];
  for (const mutate of mutations) {
    const candidate = structuredClone(original);
    mutate(candidate);
    await assert.rejects(
      verifyClosedTestnetDeploymentPlan({ input: deploymentInput, artifacts: artifactSet, plan: candidate }),
      /does not exactly match/,
    );
  }
});

test("network, role, token, timing, risk, and artifact weakening fail before plan construction", async () => {
  const artifactSet = await artifacts();
  const cases = [
    [() => input({ chainId: "1" }), /chain does not match/],
    [() => input({ environment: "public-testnet", chainId: "31337" }), /chain does not match/],
    [() => {
      const value = input();
      value.roles.guardian.address = value.roles.controller.address;
      return value;
    }, /wallet addresses must be distinct/],
    [() => {
      const value = input();
      value.roles.guardian.ownerAddresses[0] = value.roles.controller.ownerAddresses[0];
      return value;
    }, /owner sets must be completely disjoint/],
    [() => {
      const value = input();
      value.roles.controller.threshold = 1;
      return value;
    }, /threshold/],
    [() => {
      const value = input();
      value.bit.tokenBoundary = "mainnet-bit";
      return value;
    }, /token boundary/],
    [() => {
      const value = input();
      value.bit.paused = true;
      return value;
    }, /unpaused/],
    [() => {
      const value = input();
      value.gate.resumeDelaySeconds = 86_399;
      return value;
    }, /resumeDelaySeconds/],
    [() => input({ vaultRisk: risk({ referenceSatsPerBit: "101" }) }), /100-sat reference/],
    [() => input({ vaultRisk: risk({ maxFeeBps: "501" }) }), /fee cap/],
    [() => input({ vaultRisk: risk({ maxEpochVolumeWei: "1" }) }), /epoch volume/],
  ];
  for (const [makeInput, pattern] of cases) {
    await assert.rejects(buildClosedTestnetDeploymentPlan({ input: makeInput(), artifacts: artifactSet }), pattern);
  }

  const compilerDrift = structuredClone(artifactSet);
  compilerDrift.gate.metadata.compiler.version = "0.8.25";
  await assert.rejects(
    buildClosedTestnetDeploymentPlan({ input: input(), artifacts: compilerDrift }),
    /compiler settings are not pinned/,
  );
  const bytecodeDrift = structuredClone(artifactSet);
  bytecodeDrift.vault.bytecode.object = "0x";
  await assert.rejects(
    buildClosedTestnetDeploymentPlan({ input: input(), artifacts: bytecodeDrift }),
    /bytecode is invalid/,
  );
  const linkedArtifact = structuredClone(artifactSet);
  linkedArtifact.userEscrow.bytecode.linkReferences = { "library.sol": { Library: [] } };
  await assert.rejects(
    buildClosedTestnetDeploymentPlan({ input: input(), artifacts: linkedArtifact }),
    /unresolved library links/,
  );
});

test("local rehearsal is explicitly distinct and the module has no network, key, signing, or broadcast path", async () => {
  const artifactSet = await artifacts();
  const localInput = input({
    environment: "local-rehearsal",
    chainId: "31337",
    bit: {
      ...input().bit,
      tokenBoundary: "test-only-eip1967-bit-probe",
    },
  });
  const plan = await buildClosedTestnetDeploymentPlan({ input: localInput, artifacts: artifactSet });
  assert.equal(plan.network.name, "anvil");
  assert.equal(plan.scope, "local-rehearsal-only-no-signing-broadcast-or-funding-authorization");
  const source = await readFile(new URL("../lib/closed-testnet-deployment-plan.mjs", import.meta.url), "utf8");
  for (const forbidden of [
    "JsonRpcProvider",
    "sendTransaction",
    "signTransaction",
    "signTypedData",
    "privateKey",
    "process.env",
    "fetch(",
  ]) {
    assert.equal(source.includes(forbidden), false, `module unexpectedly contains ${forbidden}`);
  }
});
