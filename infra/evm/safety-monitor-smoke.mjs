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

function observations(now, overrides = {}) {
  return REQUIRED_SAFETY_CHECKS.map((kind) => ({
    kind,
    status: "healthy",
    observedAt: now - 1,
    evidenceDigest: id(`treeswap-monitor-smoke:${kind}`).toLowerCase(),
    ...(overrides[kind] ?? {}),
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
  const unhealthy = await runSafetyMonitorCycle({
    observations: observations(now, { "bit-contract": { status: "unsafe" } }),
    maximumObservationAgeSeconds: MAXIMUM_AGE,
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
  assert.equal(await gate.isOpen(), false);
  assert.equal(await gate.emergencyHalted(), true);
  assert.equal(await gate.activeRiskDigest(), `0x${"00".repeat(32)}`);

  let healthyMutationCalls = 0;
  const healthy = await runSafetyMonitorCycle({
    observations: observations(now),
    maximumObservationAgeSeconds: MAXIMUM_AGE,
    nowSeconds: () => now,
    closeQuoteIssuance: async () => { healthyMutationCalls += 1; },
    haltOnchainGate: async () => { healthyMutationCalls += 1; },
    deliverAlert: async () => { healthyMutationCalls += 1; },
  });
  assert.equal(healthy.outcome, "HEALTHY");
  assert.equal(healthyMutationCalls, 0);
  assert.equal(await gate.isOpen(), false);

  const malicious = observations(now);
  malicious[0] = { ...malicious[0], invoice: "lnbc-must-not-enter-alert" };
  let outageAlert;
  const outage = await runSafetyMonitorCycle({
    observations: malicious,
    maximumObservationAgeSeconds: MAXIMUM_AGE,
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
    schema: "treeswap.safety-monitor-smoke.v1",
    chainId: String(CHAIN_ID),
    executionClient: ANVIL_VERSION,
    actualOpenGate: true,
    distinctControllerAndGuardianContracts: true,
    unsafeObservationClosedQuotes: quoteIssuanceClosed,
    unsafeObservationHaltedOnchainGate: gateHalted,
    alertDeliveredAfterClosure,
    healthyCycleHasNoOpenAuthority: healthyMutationCalls === 0,
    malformedObservationFailedClosed: outage.newExposureClosed,
    secretMaterialInAlert: false,
    publicAlertProviderIncluded: false,
    productionMonitorIncluded: false,
    fundingAuthorization: false,
  });
  process.stdout.write(`${JSON.stringify({ ...evidence, evidenceDigest: coordinatorCommitmentDigest(evidence) })}\n`);
} finally {
  await provider.destroy();
}
