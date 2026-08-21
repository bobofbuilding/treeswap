import {
  Interface,
  getAddress,
  isHexString,
  keccak256,
} from "ethers";
import { observeDeploymentManifest } from "./deployment-observer.mjs";
import {
  assertClosedTestnetDeploymentPostflightIsSecretFree,
  closedTestnetDeploymentPostflightValueDigest,
  normalizeClosedTestnetDeploymentPostflightContext,
} from "./closed-testnet-deployment-postflight.mjs";

const BYTES32 = /^0x[0-9a-f]{64}$/;
const HEX_QUANTITY = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const SAFE_INTERFACE = new Interface([
  "function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) returns (bool success)",
  "event ExecutionSuccess(bytes32 txHash,uint256 payment)",
  "event ExecutionFailure(bytes32 txHash,uint256 payment)",
]);
const REGISTRY_INTERFACE = new Interface([
  "event EscrowRegistered(address indexed escrow)",
  "event RegistrySealedEvent()",
]);

function exactKeys(value, expected, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${name} fields are not exact`);
  }
}

function address(value, name) {
  try {
    return getAddress(String(value ?? ""));
  } catch {
    throw new TypeError(`${name} must be an Ethereum address`);
  }
}

function bytes32(value, name) {
  const normalized = String(value ?? "").toLowerCase();
  if (!BYTES32.test(normalized) || normalized === `0x${"00".repeat(32)}`) {
    throw new TypeError(`${name} must be a nonzero bytes32 value`);
  }
  return normalized;
}

function quantity(value, name) {
  if (!HEX_QUANTITY.test(String(value ?? ""))) throw new TypeError(`${name} is not a canonical hex quantity`);
  const parsed = BigInt(value);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError(`${name} exceeds the safe integer range`);
  return Number(parsed);
}

function blockTag(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("block number is invalid");
  return `0x${value.toString(16)}`;
}

function block(value, name) {
  if (!value || !BYTES32.test(String(value.hash ?? "").toLowerCase())) {
    throw new TypeError(`${name} block is malformed`);
  }
  return Object.freeze({
    number: quantity(value.number, `${name} block number`),
    hash: String(value.hash).toLowerCase(),
    timestamp: quantity(value.timestamp, `${name} block timestamp`),
  });
}

function transactionHash(value, name) {
  return bytes32(value, name);
}

function normalizeTransactions(raw, context) {
  exactKeys(raw, ["controllerActions", "deployments", "schema"], "deployment execution transactions");
  if (raw.schema !== "treeswap.closed-testnet-deployment-execution-transactions.v1") {
    throw new TypeError("deployment execution transaction schema is invalid");
  }
  const normalize = (values, expected, name) => {
    if (!Array.isArray(values) || values.length !== expected.length) {
      throw new Error(`${name} must contain the exact plan sequence`);
    }
    return Object.freeze(values.map((value, index) => {
      exactKeys(value, ["name", "transactionHash"], `${name}[${index}]`);
      if (value.name !== expected[index].name) throw new Error(`${name} is not in plan order`);
      return Object.freeze({
        name: value.name,
        transactionHash: transactionHash(value.transactionHash, `${name}[${index}].transactionHash`),
      });
    }));
  };
  const deployments = normalize(raw.deployments, context.preflight.plan.deployments, "deployments");
  const controllerActions = normalize(raw.controllerActions, context.preflight.plan.actions, "controllerActions");
  const all = [...deployments, ...controllerActions].map((value) => value.transactionHash);
  if (new Set(all).size !== all.length) throw new Error("deployment execution transaction hashes are duplicated");
  assertClosedTestnetDeploymentPostflightIsSecretFree(raw);
  return Object.freeze({ deployments, controllerActions });
}

function parseTransaction(raw, expectedHash, name) {
  if (!raw || transactionHash(raw.hash, `${name}.hash`) !== expectedHash) {
    throw new Error(`${name} was not returned by the provider`);
  }
  if (!isHexString(raw.input)) throw new TypeError(`${name}.input is malformed`);
  return Object.freeze({
    hash: expectedHash,
    from: address(raw.from, `${name}.from`),
    to: raw.to === null ? null : address(raw.to, `${name}.to`),
    nonce: quantity(raw.nonce, `${name}.nonce`),
    value: BigInt(raw.value).toString(),
    input: raw.input.toLowerCase(),
    blockNumber: quantity(raw.blockNumber, `${name}.blockNumber`),
    blockHash: bytes32(raw.blockHash, `${name}.blockHash`),
    transactionIndex: quantity(raw.transactionIndex, `${name}.transactionIndex`),
  });
}

function parseReceipt(raw, expectedHash, name) {
  if (!raw || transactionHash(raw.transactionHash, `${name}.transactionHash`) !== expectedHash) {
    throw new Error(`${name} was not returned by the provider`);
  }
  if (!Array.isArray(raw.logs)) throw new TypeError(`${name}.logs are malformed`);
  return Object.freeze({
    transactionHash: expectedHash,
    blockNumber: quantity(raw.blockNumber, `${name}.blockNumber`),
    blockHash: bytes32(raw.blockHash, `${name}.blockHash`),
    transactionIndex: quantity(raw.transactionIndex, `${name}.transactionIndex`),
    status: quantity(raw.status, `${name}.status`),
    contractAddress: raw.contractAddress === null ? null : address(raw.contractAddress, `${name}.contractAddress`),
    logs: raw.logs,
  });
}

function assertTransactionReceiptBinding(transaction, receipt, blockValue, name) {
  if (transaction.blockNumber !== receipt.blockNumber
      || transaction.blockHash !== receipt.blockHash
      || transaction.transactionIndex !== receipt.transactionIndex
      || receipt.blockNumber !== blockValue.number
      || receipt.blockHash !== blockValue.hash) {
    throw new Error(`${name} transaction, receipt, and canonical block disagree`);
  }
  if (receipt.status !== 1) throw new Error(`${name} transaction failed`);
}

function normalizedReceipt(receipt, blockValue) {
  return Object.freeze({
    blockNumber: String(receipt.blockNumber),
    blockHash: receipt.blockHash,
    blockTimestamp: blockValue.timestamp,
    transactionIndex: String(receipt.transactionIndex),
    status: String(receipt.status),
  });
}

async function loadExecution(rpcCall, transactionHashValue, name) {
  const [transactionValue, receiptValue] = await Promise.all([
    rpcCall("eth_getTransactionByHash", [transactionHashValue]),
    rpcCall("eth_getTransactionReceipt", [transactionHashValue]),
  ]);
  const transaction = parseTransaction(transactionValue, transactionHashValue, `${name} transaction`);
  const receipt = parseReceipt(receiptValue, transactionHashValue, `${name} receipt`);
  const blockValue = block(
    await rpcCall("eth_getBlockByNumber", [blockTag(receipt.blockNumber), false]),
    `${name} receipt`,
  );
  assertTransactionReceiptBinding(transaction, receipt, blockValue, name);
  return Object.freeze({ transaction, receipt, block: blockValue });
}

function parseSafeExecution(data, name) {
  let parsed;
  try {
    parsed = SAFE_INTERFACE.parseTransaction({ data });
  } catch {
    throw new Error(`${name} is not a standard Safe execTransaction call`);
  }
  if (!parsed || parsed.name !== "execTransaction") {
    throw new Error(`${name} is not a standard Safe execTransaction call`);
  }
  return Object.freeze({
    to: address(parsed.args[0], `${name} inner target`),
    valueWei: BigInt(parsed.args[1]).toString(),
    data: String(parsed.args[2]).toLowerCase(),
    operation: Number(parsed.args[3]),
    gasPriceWei: BigInt(parsed.args[6]).toString(),
    gasToken: address(parsed.args[7], `${name} gas token`),
    refundReceiver: address(parsed.args[8], `${name} refund receiver`),
  });
}

function parseRelevantLog(iface, log, name) {
  if (!Array.isArray(log.topics) || !isHexString(log.data)) throw new TypeError(`${name} log is malformed`);
  try {
    const parsed = iface.parseLog({ topics: log.topics, data: log.data });
    if (!parsed) throw new Error("unrecognized event");
    return parsed;
  } catch {
    throw new Error(`${name} emitted an unexpected event`);
  }
}

function assertLogBinding(log, execution, expectedAddress, name) {
  if (address(log.address, `${name}.address`) !== expectedAddress
      || transactionHash(log.transactionHash, `${name}.transactionHash`) !== execution.transaction.hash
      || bytes32(log.blockHash, `${name}.blockHash`) !== execution.receipt.blockHash
      || quantity(log.blockNumber, `${name}.blockNumber`) !== execution.receipt.blockNumber
      || quantity(log.transactionIndex, `${name}.transactionIndex`) !== execution.receipt.transactionIndex) {
    throw new Error(`${name} is not bound to the exact execution receipt`);
  }
}

function validateSafeAndRegistryLogs(execution, safeAddress, registryAddress, actionIndex, expectedEscrow) {
  const safeLogs = execution.receipt.logs.filter((log) => (
    address(log.address, "Safe log address") === safeAddress
  ));
  const safeEvents = safeLogs.map((log, index) => {
    assertLogBinding(log, execution, safeAddress, `Safe log ${index}`);
    return parseRelevantLog(SAFE_INTERFACE, log, `Safe log ${index}`);
  });
  if (safeEvents.filter((event) => event.name === "ExecutionFailure").length !== 0
      || safeEvents.filter((event) => event.name === "ExecutionSuccess").length !== 1
      || safeEvents.length !== 1) {
    throw new Error("controller action lacks one unambiguous Safe ExecutionSuccess event");
  }

  const registryLogs = execution.receipt.logs.filter((log) => (
    address(log.address, "registry log address") === registryAddress
  ));
  const registryEvents = registryLogs.map((log, index) => {
    assertLogBinding(log, execution, registryAddress, `registry log ${index}`);
    return parseRelevantLog(REGISTRY_INTERFACE, log, `registry log ${index}`);
  });
  if (registryEvents.length !== 1) throw new Error("controller action must emit exactly one expected registry event");
  if (actionIndex < 2) {
    if (registryEvents[0].name !== "EscrowRegistered"
        || address(registryEvents[0].args.escrow, "registered escrow") !== expectedEscrow) {
      throw new Error("controller action registered the wrong escrow");
    }
  } else if (registryEvents[0].name !== "RegistrySealedEvent") {
    throw new Error("controller action did not seal the registry");
  }
}

export async function observeClosedTestnetDeploymentPostflight({
  rpcCall,
  preflight,
  deploymentPolicy,
  transactions: rawTransactions,
  providerIdentity,
  providerLabel,
  targetBlockNumber = null,
  observedAt = new Date(),
  observeManifest = observeDeploymentManifest,
}) {
  if (typeof rpcCall !== "function") throw new TypeError("rpcCall is required");
  if (typeof observeManifest !== "function") throw new TypeError("observeManifest is required");
  const context = normalizeClosedTestnetDeploymentPostflightContext({ preflight, deploymentPolicy });
  const transactions = normalizeTransactions(rawTransactions, context);
  const identity = bytes32(providerIdentity, "provider identity");
  const label = String(providerLabel ?? "");
  if (label.length === 0 || label.length > 80) throw new TypeError("provider label is invalid");
  const timestamp = observedAt instanceof Date ? observedAt : new Date(observedAt);
  if (!Number.isFinite(timestamp.getTime())) throw new TypeError("observedAt is invalid");

  const chainId = quantity(await rpcCall("eth_chainId", []), "chain ID");
  if (String(chainId) !== context.preflight.plan.chainId) {
    throw new Error("provider is not connected to the signed deployment chain");
  }
  const preflightAnchor = block(
    await rpcCall("eth_getBlockByNumber", [
      blockTag(Number(context.preflight.raw.record.anchorBlockNumber)),
      false,
    ]),
    "signed preflight anchor",
  );
  if (preflightAnchor.hash !== String(context.preflight.raw.record.anchorBlockHash).toLowerCase()
      || preflightAnchor.timestamp !== context.preflight.anchorTimestamp) {
    throw new Error("signed deployment preflight anchor is no longer canonical");
  }
  const expectedFinalNonce = Number(BigInt(context.preflight.plan.startingNonce) + 4n);
  const pendingNonceBefore = quantity(
    await rpcCall("eth_getTransactionCount", [context.preflight.plan.deployer, "pending"]),
    "pending deployer nonce before observation",
  );

  const deployments = [];
  for (const [index, reference] of transactions.deployments.entries()) {
    const expected = context.preflight.plan.deployments[index];
    const execution = await loadExecution(rpcCall, reference.transactionHash, `deployment ${expected.name}`);
    if (execution.transaction.from !== expected.from || execution.transaction.to !== null
        || String(execution.transaction.nonce) !== expected.nonce || execution.transaction.value !== "0"
        || keccak256(execution.transaction.input).toLowerCase() !== expected.dataHash
        || execution.receipt.contractAddress !== expected.expectedContractAddress) {
      throw new Error(`deployment ${expected.name} does not match the signed plan`);
    }
    deployments.push(Object.freeze({
      kind: expected.kind,
      name: expected.name,
      transactionHash: reference.transactionHash,
      from: expected.from,
      to: null,
      nonce: expected.nonce,
      valueWei: "0",
      dataHash: expected.dataHash,
      expectedContractAddress: expected.expectedContractAddress,
      receipt: normalizedReceipt(execution.receipt, execution.block),
    }));
  }

  const controllerActions = [];
  for (const [index, reference] of transactions.controllerActions.entries()) {
    const expected = context.preflight.plan.actions[index];
    const execution = await loadExecution(rpcCall, reference.transactionHash, `controller action ${expected.name}`);
    if (execution.transaction.to !== expected.safeAddress || execution.transaction.value !== "0") {
      throw new Error(`controller action ${expected.name} was not executed through the reviewed Safe`);
    }
    const inner = parseSafeExecution(execution.transaction.input, `controller action ${expected.name}`);
    const expectedData = context.preflight.plan.raw.controllerSafeActions[index].data.toLowerCase();
    if (inner.to !== expected.to || inner.valueWei !== "0" || inner.operation !== 0
        || inner.data !== expectedData || keccak256(inner.data).toLowerCase() !== expected.dataHash
        || inner.gasPriceWei !== "0" || inner.gasToken !== ZERO_ADDRESS || inner.refundReceiver !== ZERO_ADDRESS) {
      throw new Error(`controller action ${expected.name} inner Safe call does not match the signed plan`);
    }
    validateSafeAndRegistryLogs(
      execution,
      expected.safeAddress,
      expected.to,
      index,
      index === 0
        ? context.preflight.plan.addresses.vault
        : context.preflight.plan.addresses.userEscrow,
    );
    controllerActions.push(Object.freeze({
      name: expected.name,
      transactionHash: reference.transactionHash,
      safeAddress: expected.safeAddress,
      to: expected.to,
      valueWei: "0",
      operation: "CALL",
      dataHash: expected.dataHash,
      actionDigest: expected.actionDigest,
      safeExecutionSuccess: true,
      receipt: normalizedReceipt(execution.receipt, execution.block),
    }));
  }

  const sequence = [...deployments, ...controllerActions];
  for (const [index, value] of sequence.entries()) {
    if (index > 0) {
      const previous = sequence[index - 1].receipt;
      const previousPosition = (BigInt(previous.blockNumber) << 64n) + BigInt(previous.transactionIndex);
      const currentPosition = (BigInt(value.receipt.blockNumber) << 64n) + BigInt(value.receipt.transactionIndex);
      if (currentPosition <= previousPosition) throw new Error("deployment execution sequence is not strictly ordered");
    }
    if (value.receipt.blockTimestamp < context.preflight.anchorTimestamp
        || value.receipt.blockTimestamp > context.preflight.validUntil) {
      throw new Error("deployment execution occurred outside the signed preflight window");
    }
  }

  const manifestObservation = await observeManifest({
    rpcCall,
    providerLabel: label,
    providerIdentity: identity,
    addresses: context.preflight.plan.addresses,
    reviewedBuildCommit: context.preflight.plan.reviewedBuildCommit,
    independentReviewDigest: context.preflight.plan.independentReviewDigest,
    targetBlockNumber,
    observedAt: timestamp,
  });
  const finalizedNumber = manifestObservation.finalizedBlock.number;
  if (sequence.some((value) => BigInt(value.receipt.blockNumber) > BigInt(finalizedNumber))) {
    throw new Error("deployment execution receipt is not finalized at the state anchor");
  }
  const target = block(
    await rpcCall("eth_getBlockByNumber", [blockTag(finalizedNumber), false]),
    "postflight target",
  );
  if (target.hash !== manifestObservation.finalizedBlock.hash) {
    throw new Error("postflight finalized state anchor changed while it was observed");
  }
  const anchor = Object.freeze({ blockHash: target.hash, requireCanonical: true });
  const [anchoredNonce, deployerCode, pendingNonceAfter] = await Promise.all([
    rpcCall("eth_getTransactionCount", [context.preflight.plan.deployer, anchor])
      .then((value) => quantity(value, "anchored deployer nonce")),
    rpcCall("eth_getCode", [context.preflight.plan.deployer, anchor]),
    rpcCall("eth_getTransactionCount", [context.preflight.plan.deployer, "pending"])
      .then((value) => quantity(value, "pending deployer nonce after observation")),
  ]);
  if (anchoredNonce !== expectedFinalNonce || pendingNonceBefore !== expectedFinalNonce
      || pendingNonceAfter !== expectedFinalNonce || deployerCode !== "0x") {
    throw new Error("deployer state does not prove the exact isolated four-transaction deployment sequence");
  }

  for (const [index, value] of sequence.entries()) {
    const rechecked = block(
      await rpcCall("eth_getBlockByNumber", [blockTag(Number(value.receipt.blockNumber)), false]),
      `rechecked execution block ${index}`,
    );
    if (rechecked.hash !== value.receipt.blockHash || rechecked.timestamp !== value.receipt.blockTimestamp) {
      throw new Error("deployment execution block changed while it was observed");
    }
  }

  const observation = Object.freeze({
    schema: "treeswap.closed-testnet-deployment-postflight-observation.v1",
    evidenceStatus: "unreviewed-finalized-deployment-execution",
    observedAt: timestamp.toISOString(),
    providerLabel: label,
    providerIdentity: identity,
    reviewedBuildCommit: context.preflight.plan.reviewedBuildCommit,
    independentReviewDigest: context.preflight.plan.independentReviewDigest,
    chainId: context.preflight.plan.chainId,
    inputDigest: context.preflight.plan.inputDigest,
    planDigest: context.preflight.plan.planDigest,
    preflightPolicyDigest: context.preflight.summary.policyDigest,
    preflightRecordDigest: context.preflight.summary.recordDigest,
    deploymentPolicyDigest: context.deploymentPolicyDigest,
    preflightAnchor: Object.freeze({
      number: String(preflightAnchor.number),
      hash: preflightAnchor.hash,
      timestamp: preflightAnchor.timestamp,
    }),
    providerFinalizedHead: Object.freeze({
      number: String(manifestObservation.providerFinalizedHead.number),
      hash: manifestObservation.providerFinalizedHead.hash,
    }),
    finalizedBlock: Object.freeze({
      number: String(target.number),
      hash: target.hash,
      timestamp: target.timestamp,
    }),
    stateAnchor: anchor,
    deployer: Object.freeze({
      address: context.preflight.plan.deployer,
      codeEmpty: true,
      anchoredNonce: String(anchoredNonce),
      pendingNonceBefore: String(pendingNonceBefore),
      pendingNonceAfter: String(pendingNonceAfter),
    }),
    deployments: Object.freeze(deployments),
    controllerActions: Object.freeze(controllerActions),
    manifest: manifestObservation.manifest,
    manifestDigest: closedTestnetDeploymentPostflightValueDigest(manifestObservation.manifest),
  });
  assertClosedTestnetDeploymentPostflightIsSecretFree(observation);
  return observation;
}
