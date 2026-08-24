import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  Contract,
  ContractFactory,
  HDNodeWallet,
  JsonRpcProvider,
  NonceManager,
  id,
} from "ethers";
import { coordinatorCommitmentDigest } from "../../lib/coordinator-store.mjs";
import {
  REQUIRED_SAFETY_CHECKS,
  runSafetyMonitorCycle,
} from "../../lib/safety-monitor.mjs";
import {
  prepareSafetyObservation,
  SAFETY_MONITOR_POLICY_SCHEMA,
  safetyMonitorPolicyDigest,
  verifySafetyObservationAttestation,
} from "../../lib/safety-observation-attestation.mjs";

const RPC_URL = process.env.SAFETY_MONITOR_RPC_URL;
const MNEMONIC = process.env.SAFETY_MONITOR_MNEMONIC;
const ANVIL_VERSION = String(process.env.SAFETY_MONITOR_ANVIL_VERSION ?? "");
const CHAIN_ID = 31_337n;
const MAXIMUM_AGE = 15;

if (!RPC_URL || !MNEMONIC) throw new Error("safety monitor smoke requires an ephemeral RPC URL and mnemonic");
if (!/^anvil Version: [0-9.]+/.test(ANVIL_VERSION)) throw new Error("Anvil version is not pinned in evidence");

function artifact(path) {
  return readFile(new URL(path, import.meta.url), "utf8").then(JSON.parse);
}

async function observations(now, safety, overrides = {}) {
  return Promise.all(safety.collectors.map(async ({ kind, collectorId, operatorIndex, wallet }) => {
    const override = overrides[collectorId] ?? overrides[`${kind}:${operatorIndex}`] ?? overrides[kind] ?? {};
    const observedAt = override.observedAt ?? now - 1;
    const prepared = prepareSafetyObservation({
      policy: safety.policy,
      expectedPolicyDigest: safety.policyDigest,
      collectorId,
      kind,
      status: override.status ?? "healthy",
      observedAt,
      validUntil: override.validUntil ?? observedAt + MAXIMUM_AGE,
      evidenceDigest: override.evidenceDigest ?? id(`treeswap-monitor-smoke:${kind}:${collectorId}`).toLowerCase(),
    });
    const signature = await wallet.signTypedData(prepared.domain, prepared.types, prepared.message);
    return verifySafetyObservationAttestation({
      policy: safety.policy,
      expectedPolicyDigest: safety.policyDigest,
      attestation: Object.freeze({ ...prepared.message, signature }),
      now,
      maximumClockSkewSeconds: 1,
    });
  }));
}

const [controlArtifact, gateArtifact] = await Promise.all([
  artifact("../../contracts/out/MonitorControlProbe.sol/MonitorControlProbe.json"),
  artifact("../../contracts/out/TreeSwapOpenGate.sol/TreeSwapOpenGate.json"),
]);
const provider = new JsonRpcProvider(RPC_URL, CHAIN_ID, { staticNetwork: true });
const controllerWallet = HDNodeWallet.fromPhrase(MNEMONIC, undefined, "m/44'/60'/0'/0/0").connect(provider);
const guardianWallet = HDNodeWallet.fromPhrase(MNEMONIC, undefined, "m/44'/60'/0'/0/1").connect(provider);
const controllerOwner = new NonceManager(controllerWallet);
const guardianOwner = new NonceManager(guardianWallet);

try {
  assert.equal((await provider.getNetwork()).chainId, CHAIN_ID);
  const controlFactoryA = new ContractFactory(controlArtifact.abi, controlArtifact.bytecode.object, controllerOwner);
  const controlFactoryB = new ContractFactory(controlArtifact.abi, controlArtifact.bytecode.object, guardianOwner);
  const controller = await controlFactoryA.deploy(controllerWallet.address);
  const guardian = await controlFactoryB.deploy(guardianWallet.address);
  await Promise.all([controller.waitForDeployment(), guardian.waitForDeployment()]);
  const controllerAddress = (await controller.getAddress()).toLowerCase();
  const guardianAddress = (await guardian.getAddress()).toLowerCase();
  assert.notEqual(controllerAddress, guardianAddress);

  const gateFactory = new ContractFactory(gateArtifact.abi, gateArtifact.bytecode.object, controllerOwner);
  const gate = await gateFactory.deploy(controllerAddress, guardianAddress, 86_400, 7_200);
  await gate.waitForDeployment();
  const gateAddress = (await gate.getAddress()).toLowerCase();
  const controllerControl = new Contract(controllerAddress, controlArtifact.abi, controllerOwner);
  const guardianControl = new Contract(guardianAddress, controlArtifact.abi, guardianOwner);
  assert.equal(await gate.isOpen(), false);

  const riskDigest = id("treeswap-monitor-smoke:reviewed-risk").toLowerCase();
  const initialBlock = await provider.getBlock("latest");
  const validUntil = Number(initialBlock.timestamp) + 86_400 + 3_600;
  await (await controllerControl.execute(
    gateAddress,
    gate.interface.encodeFunctionData("scheduleOpen", [riskDigest, validUntil]),
  )).wait();
  await provider.send("evm_increaseTime", [86_400]);
  await provider.send("evm_mine", []);
  await (await gate.executeOpen(riskDigest)).wait();
  assert.equal(await gate.isOpen(), true);

  let quoteIssuanceClosed = false;
  let gateHalted = false;
  let alertDeliveredAfterClosure = false;
  const now = Number((await provider.getBlock("latest")).timestamp);
  const safetyCollectors = REQUIRED_SAFETY_CHECKS.flatMap((kind, kindIndex) => [0, 1].map((operatorIndex) => {
    const wallet = HDNodeWallet.fromPhrase(
      MNEMONIC,
      undefined,
      `m/44'/60'/0'/0/${kindIndex * 2 + operatorIndex + 10}`,
    );
    return Object.freeze({
      kind,
      operatorIndex,
      operatorId: id(`treeswap-monitor-smoke-operator:${operatorIndex}`).toLowerCase(),
      collectorId: id(`treeswap-monitor-smoke-collector:${kind}:${operatorIndex}`).toLowerCase(),
      wallet,
    });
  }).sort((left, right) => left.collectorId < right.collectorId ? -1 : 1));
  const safetyPolicy = Object.freeze({
    schema: SAFETY_MONITOR_POLICY_SCHEMA,
    chainId: CHAIN_ID.toString(),
    verifyingContract: gateAddress,
    releaseRecordDigest: id("treeswap-monitor-smoke-release-record").toLowerCase(),
    validFrom: now - 60,
    validUntil: now + 3_600,
    maximumObservationAgeSeconds: MAXIMUM_AGE,
    collectors: Object.freeze(safetyCollectors.map(({ kind, collectorId, operatorId, wallet }) => Object.freeze({
      kind,
      collectorId,
      operatorId,
      signer: wallet.address,
    }))),
  });
  const safety = Object.freeze({
    collectors: safetyCollectors,
    policy: safetyPolicy,
    policyDigest: safetyMonitorPolicyDigest(safetyPolicy),
  });
  const missingCollector = safety.collectors.filter(({ kind }) => kind === "bit-contract")[1];
  const outageObservations = (await observations(now, safety))
    .filter((observation) => observation.collectorId !== missingCollector.collectorId);
  const unhealthy = await runSafetyMonitorCycle({
    observations: outageObservations,
    maximumObservationAgeSeconds: MAXIMUM_AGE,
    expectedSafetyPolicyDigest: safety.policyDigest,
    nowSeconds: () => now,
    closeQuoteIssuance: async () => {
      quoteIssuanceClosed = true;
      return { closed: true };
    },
    haltOnchainGate: async (alert) => {
      assert.equal(quoteIssuanceClosed, true);
      const transaction = await guardianControl.execute(
        gateAddress,
        gate.interface.encodeFunctionData("halt", [alert.alertDigest]),
      );
      await transaction.wait();
      gateHalted = !(await gate.isOpen());
      return {
        halted: gateHalted,
        reasonDigest: alert.alertDigest,
        transactionHash: transaction.hash.toLowerCase(),
      };
    },
    deliverAlert: async (alert) => {
      assert.equal(quoteIssuanceClosed && gateHalted, true);
      assert.equal(JSON.stringify(alert).includes("lnbc"), false);
      alertDeliveredAfterClosure = true;
      return { delivered: true };
    },
  });
  assert.equal(unhealthy.outcome, "HALTED_AND_ALERTED");
  assert.equal(unhealthy.newExposureClosed, true);
  assert.ok(unhealthy.reasonCodes.includes("BIT_CONTRACT_COLLECTOR_OUTAGE"));
  assert.equal(await gate.isOpen(), false);
  assert.equal(await gate.emergencyHalted(), true);
  assert.equal(await gate.activeRiskDigest(), `0x${"00".repeat(32)}`);

  let healthyMutationCalls = 0;
  const healthy = await runSafetyMonitorCycle({
    observations: await observations(now, safety),
    maximumObservationAgeSeconds: MAXIMUM_AGE,
    expectedSafetyPolicyDigest: safety.policyDigest,
    nowSeconds: () => now,
    closeQuoteIssuance: async () => { healthyMutationCalls += 1; },
    haltOnchainGate: async () => { healthyMutationCalls += 1; },
    deliverAlert: async () => { healthyMutationCalls += 1; },
  });
  assert.equal(healthy.outcome, "HEALTHY");
  assert.equal(healthyMutationCalls, 0);
  assert.equal(await gate.isOpen(), false);

  const malicious = await observations(now, safety);
  malicious[0] = { ...malicious[0], invoice: "lnbc-must-not-enter-alert" };
  let outageAlert;
  const outage = await runSafetyMonitorCycle({
    observations: malicious,
    maximumObservationAgeSeconds: MAXIMUM_AGE,
    expectedSafetyPolicyDigest: safety.policyDigest,
    nowSeconds: () => now,
    closeQuoteIssuance: async () => ({ closed: true }),
    haltOnchainGate: async (alert) => {
      const transaction = await guardianControl.execute(
        gateAddress,
        gate.interface.encodeFunctionData("halt", [alert.alertDigest]),
      );
      await transaction.wait();
      return { halted: true, reasonDigest: alert.alertDigest, transactionHash: transaction.hash.toLowerCase() };
    },
    deliverAlert: async (alert) => {
      outageAlert = alert;
      return { delivered: true };
    },
  });
  assert.equal(outage.outcome, "HALTED_AND_ALERTED");
  assert.ok(outage.reasonCodes.includes("MONITOR_INPUT_INVALID"));
  assert.equal(JSON.stringify(outageAlert).includes("lnbc-must-not-enter-alert"), false);
  assert.equal(await gate.isOpen(), false);

  const evidence = Object.freeze({
    schema: "treeswap.safety-monitor-smoke.v3",
    chainId: String(CHAIN_ID),
    executionClient: ANVIL_VERSION,
    actualOpenGate: true,
    distinctControllerAndGuardianContracts: true,
    redundantCollectorsPerDomain: 2,
    distinctOperatorCommitmentsPerDomain: true,
    collectorOutageClosedQuotes: quoteIssuanceClosed,
    collectorOutageHaltedOnchainGate: gateHalted,
    alertDeliveredAfterClosure,
    healthyCycleHasNoOpenAuthority: healthyMutationCalls === 0,
    malformedObservationFailedClosed: outage.newExposureClosed,
    signedReleaseBoundObservations: true,
    safetyMonitorPolicyDigest: safety.policyDigest,
    secretMaterialInAlert: false,
    publicAlertProviderIncluded: false,
    productionMonitorIncluded: false,
    fundingAuthorization: false,
  });
  process.stdout.write(`${JSON.stringify({ ...evidence, evidenceDigest: coordinatorCommitmentDigest(evidence) })}\n`);
} finally {
  await provider.destroy();
}
