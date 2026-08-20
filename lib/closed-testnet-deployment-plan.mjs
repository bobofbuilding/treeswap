import {
  ContractFactory,
  Interface,
  getAddress,
  getCreateAddress,
  keccak256,
  toUtf8Bytes,
} from "ethers";

const BYTES32 = /^0x[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const HEX = /^0x[0-9a-f]*$/;
const ZERO_DIGEST = `0x${"00".repeat(32)}`;
const PLAN_SCHEMA = "treeswap.closed-testnet-deployment-plan.v1";

const INPUT_FIELDS = Object.freeze([
  "bit",
  "chainId",
  "deployer",
  "environment",
  "gate",
  "independentReviewDigest",
  "reviewedBuildCommit",
  "roles",
  "schema",
  "startingNonce",
  "userEscrowRisk",
  "vaultRisk",
]);

const ROLE_FIELDS = Object.freeze([
  "address",
  "ownerAddresses",
  "runtimeCodeHash",
  "threshold",
]);

const BIT_FIELDS = Object.freeze([
  "decimals",
  "implementationAddress",
  "implementationCodeHash",
  "paused",
  "proxyAddress",
  "proxyCodeHash",
  "symbol",
  "tokenBoundary",
]);

const GATE_FIELDS = Object.freeze([
  "maxOpenDurationSeconds",
  "resumeDelaySeconds",
]);

const RISK_FIELDS = Object.freeze([
  "epochDurationSeconds",
  "maxEpochVolumeWei",
  "maxFeeBps",
  "maxLockDurationSeconds",
  "maxPriceDeviationBps",
  "maxSwapAmountWei",
  "minClaimBufferSeconds",
  "minSettlementWindowSeconds",
  "referenceSatsPerBit",
]);

const ARTIFACT_DEFINITIONS = Object.freeze({
  gate: Object.freeze({ path: "contracts/src/TreeSwapOpenGate.sol", contract: "TreeSwapOpenGate" }),
  paymentHashRegistry: Object.freeze({
    path: "contracts/src/TreeSwapPaymentHashRegistry.sol",
    contract: "TreeSwapPaymentHashRegistry",
  }),
  userEscrow: Object.freeze({ path: "contracts/src/TreeSwapUserEscrow.sol", contract: "TreeSwapUserEscrow" }),
  vault: Object.freeze({ path: "contracts/src/TreeSwapBitVault.sol", contract: "TreeSwapBitVault" }),
});

function exactKeys(value, expected, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${name} fields are invalid`);
  }
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hash(value) {
  return keccak256(toUtf8Bytes(canonical(value))).toLowerCase();
}

function digest(value, name, { nonzero = false } = {}) {
  const normalized = String(value ?? "").toLowerCase();
  if (!BYTES32.test(normalized) || (nonzero && normalized === ZERO_DIGEST)) {
    throw new TypeError(`${name} must be a${nonzero ? " nonzero" : ""} bytes32 digest`);
  }
  return normalized;
}

function address(value, name) {
  try {
    return getAddress(String(value ?? ""));
  } catch {
    throw new TypeError(`${name} is not a canonical EVM address`);
  }
}

function decimal(value, name, bits, { positive = false } = {}) {
  const raw = String(value ?? "");
  if (!DECIMAL.test(raw)) throw new TypeError(`${name} must be a canonical decimal string`);
  const parsed = BigInt(raw);
  if ((positive && parsed === 0n) || parsed >= (1n << BigInt(bits))) throw new RangeError(`${name} is outside uint${bits}`);
  return raw;
}

function safeInteger(value, name, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new TypeError(`${name} is invalid`);
  return value;
}

function normalizeRole(value, name) {
  exactKeys(value, ROLE_FIELDS, name);
  if (!Array.isArray(value.ownerAddresses) || value.ownerAddresses.length < 3 || value.ownerAddresses.length > 20) {
    throw new Error(`${name} must list three to twenty owners`);
  }
  const ownerAddresses = value.ownerAddresses.map((owner, index) => address(owner, `${name}.ownerAddresses[${index}]`))
    .sort((left, right) => left.toLowerCase().localeCompare(right.toLowerCase()));
  if (new Set(ownerAddresses.map((owner) => owner.toLowerCase())).size !== ownerAddresses.length) {
    throw new Error(`${name} owners are duplicated`);
  }
  const threshold = safeInteger(value.threshold, `${name}.threshold`, { minimum: 2, maximum: ownerAddresses.length });
  return Object.freeze({
    address: address(value.address, `${name}.address`),
    ownerAddresses: Object.freeze(ownerAddresses),
    threshold,
    runtimeCodeHash: digest(value.runtimeCodeHash, `${name}.runtimeCodeHash`, { nonzero: true }),
  });
}

function normalizeRoles(value) {
  exactKeys(value, ["controller", "feeCollector", "guardian"], "roles");
  const roles = Object.freeze({
    controller: normalizeRole(value.controller, "roles.controller"),
    feeCollector: normalizeRole(value.feeCollector, "roles.feeCollector"),
    guardian: normalizeRole(value.guardian, "roles.guardian"),
  });
  const roleAddresses = Object.values(roles).map((role) => role.address.toLowerCase());
  if (new Set(roleAddresses).size !== roleAddresses.length) throw new Error("role wallet addresses must be distinct");
  const owners = Object.values(roles).flatMap((role) => role.ownerAddresses.map((owner) => owner.toLowerCase()));
  if (new Set(owners).size !== owners.length) {
    throw new Error("controller, guardian, and fee-collector owner sets must be completely disjoint");
  }
  return roles;
}

function normalizeRisk(value, name) {
  exactKeys(value, RISK_FIELDS, name);
  const risk = Object.freeze({
    maxFeeBps: decimal(value.maxFeeBps, `${name}.maxFeeBps`, 16),
    maxPriceDeviationBps: decimal(value.maxPriceDeviationBps, `${name}.maxPriceDeviationBps`, 16),
    referenceSatsPerBit: decimal(value.referenceSatsPerBit, `${name}.referenceSatsPerBit`, 32, { positive: true }),
    epochDurationSeconds: decimal(value.epochDurationSeconds, `${name}.epochDurationSeconds`, 32, { positive: true }),
    minSettlementWindowSeconds: decimal(
      value.minSettlementWindowSeconds,
      `${name}.minSettlementWindowSeconds`,
      32,
      { positive: true },
    ),
    minClaimBufferSeconds: decimal(value.minClaimBufferSeconds, `${name}.minClaimBufferSeconds`, 32, { positive: true }),
    maxLockDurationSeconds: decimal(value.maxLockDurationSeconds, `${name}.maxLockDurationSeconds`, 32, { positive: true }),
    maxSwapAmountWei: decimal(value.maxSwapAmountWei, `${name}.maxSwapAmountWei`, 96, { positive: true }),
    maxEpochVolumeWei: decimal(value.maxEpochVolumeWei, `${name}.maxEpochVolumeWei`, 96, { positive: true }),
  });
  if (BigInt(risk.maxFeeBps) > 500n) throw new Error(`${name} fee cap exceeds the contract maximum`);
  if (BigInt(risk.maxPriceDeviationBps) > 2_500n) {
    throw new Error(`${name} price-deviation cap exceeds the contract maximum`);
  }
  if (risk.referenceSatsPerBit !== "100") throw new Error(`${name} must pin the TreeSwap 100-sat reference`);
  if (BigInt(risk.maxLockDurationSeconds)
      < BigInt(risk.minSettlementWindowSeconds) + BigInt(risk.minClaimBufferSeconds)) {
    throw new Error(`${name} lock duration cannot contain the settlement and claim buffers`);
  }
  if (BigInt(risk.maxEpochVolumeWei) < BigInt(risk.maxSwapAmountWei)) {
    throw new Error(`${name} epoch volume is below its per-swap maximum`);
  }
  return risk;
}

function normalizeBit(value, environment) {
  exactKeys(value, BIT_FIELDS, "bit");
  const expectedBoundary = environment === "public-testnet"
    ? "reviewed-public-testnet-bit-proxy"
    : "test-only-eip1967-bit-probe";
  if (value.tokenBoundary !== expectedBoundary) throw new Error("BIT token boundary does not match the plan environment");
  if (value.symbol !== "BIT" || value.decimals !== 18 || value.paused !== false) {
    throw new Error("BIT plan requires an unpaused 18-decimal BIT proxy");
  }
  return Object.freeze({
    tokenBoundary: value.tokenBoundary,
    proxyAddress: address(value.proxyAddress, "bit.proxyAddress"),
    implementationAddress: address(value.implementationAddress, "bit.implementationAddress"),
    proxyCodeHash: digest(value.proxyCodeHash, "bit.proxyCodeHash", { nonzero: true }),
    implementationCodeHash: digest(value.implementationCodeHash, "bit.implementationCodeHash", { nonzero: true }),
    symbol: "BIT",
    decimals: 18,
    paused: false,
  });
}

function normalizeInput(raw) {
  exactKeys(raw, INPUT_FIELDS, "closed-testnet deployment input");
  if (raw.schema !== "treeswap.closed-testnet-deployment-input.v1") throw new TypeError("deployment input schema is invalid");
  if (!["public-testnet", "local-rehearsal"].includes(raw.environment)) {
    throw new TypeError("deployment environment is invalid");
  }
  const expectedChainId = raw.environment === "public-testnet" ? "11155111" : "31337";
  if (raw.chainId !== expectedChainId) throw new Error("deployment chain does not match the environment");
  if (!COMMIT.test(String(raw.reviewedBuildCommit ?? ""))) throw new TypeError("reviewed build commit is invalid");
  const gate = (() => {
    exactKeys(raw.gate, GATE_FIELDS, "gate");
    const resumeDelaySeconds = safeInteger(raw.gate.resumeDelaySeconds, "gate.resumeDelaySeconds", {
      minimum: 86_400,
      maximum: 2_678_400,
    });
    const maxOpenDurationSeconds = safeInteger(raw.gate.maxOpenDurationSeconds, "gate.maxOpenDurationSeconds", {
      minimum: 1,
      maximum: 604_800,
    });
    return Object.freeze({ resumeDelaySeconds, maxOpenDurationSeconds });
  })();
  const input = Object.freeze({
    schema: raw.schema,
    environment: raw.environment,
    chainId: raw.chainId,
    reviewedBuildCommit: raw.reviewedBuildCommit,
    independentReviewDigest: digest(raw.independentReviewDigest, "independentReviewDigest", { nonzero: true }),
    deployer: address(raw.deployer, "deployer"),
    startingNonce: decimal(raw.startingNonce, "startingNonce", 64),
    roles: normalizeRoles(raw.roles),
    bit: normalizeBit(raw.bit, raw.environment),
    gate,
    vaultRisk: normalizeRisk(raw.vaultRisk, "vaultRisk"),
    userEscrowRisk: normalizeRisk(raw.userEscrowRisk, "userEscrowRisk"),
  });
  assertClosedTestnetDeploymentPlanIsSecretFree(input);
  return input;
}

function normalizeArtifact(value, name) {
  const definition = ARTIFACT_DEFINITIONS[name];
  if (!value || typeof value !== "object" || !Array.isArray(value.abi)) throw new TypeError(`${name} artifact is invalid`);
  const creationCode = String(value.bytecode?.object ?? "").toLowerCase();
  const runtimeTemplate = String(value.deployedBytecode?.object ?? "").toLowerCase();
  if (!HEX.test(creationCode) || creationCode.length < 4 || !HEX.test(runtimeTemplate) || runtimeTemplate.length < 4) {
    throw new TypeError(`${name} artifact bytecode is invalid`);
  }
  if (Object.keys(value.bytecode?.linkReferences ?? {}).length !== 0
      || Object.keys(value.deployedBytecode?.linkReferences ?? {}).length !== 0) {
    throw new Error(`${name} artifact has unresolved library links`);
  }
  const settings = value.metadata?.settings;
  const target = settings?.compilationTarget;
  if (value.metadata?.compiler?.version !== "0.8.24+commit.e11b9ed9"
      || settings?.optimizer?.enabled !== true
      || settings?.optimizer?.runs !== 20_000
      || settings?.evmVersion !== "cancun"
      || settings?.metadata?.bytecodeHash !== "ipfs"
      || Object.keys(target ?? {}).length !== 1
      || target?.[definition.path] !== definition.contract) {
    throw new Error(`${name} artifact compiler settings are not pinned`);
  }
  const sources = value.metadata?.sources;
  if (!sources || typeof sources !== "object" || Object.keys(sources).length === 0) {
    throw new Error(`${name} artifact source commitments are missing`);
  }
  for (const [path, source] of Object.entries(sources)) {
    if (!/^contracts\/src\/[A-Za-z0-9._/-]+\.sol$/.test(path)
        || !BYTES32.test(String(source?.keccak256 ?? ""))) {
      throw new Error(`${name} artifact contains an invalid source commitment`);
    }
  }
  return Object.freeze({
    raw: value,
    abi: value.abi,
    creationCode,
    digest: Object.freeze({
      compiler: "0.8.24+commit.e11b9ed9",
      compilationTarget: `${definition.path}:${definition.contract}`,
      creationCodeHash: keccak256(creationCode).toLowerCase(),
      runtimeTemplateHash: keccak256(runtimeTemplate).toLowerCase(),
      immutableReferencesDigest: hash(value.deployedBytecode?.immutableReferences ?? {}),
      sourceCommitmentsDigest: hash(Object.fromEntries(
        Object.entries(sources).sort(([left], [right]) => left.localeCompare(right))
          .map(([path, source]) => [path, String(source.keccak256).toLowerCase()]),
      )),
    }),
  });
}

function normalizeArtifacts(raw) {
  exactKeys(raw, Object.keys(ARTIFACT_DEFINITIONS), "deployment artifacts");
  return Object.freeze(Object.fromEntries(
    Object.keys(ARTIFACT_DEFINITIONS).map((name) => [name, normalizeArtifact(raw[name], name)]),
  ));
}

function riskTuple(risk) {
  return [
    risk.maxFeeBps,
    risk.maxPriceDeviationBps,
    risk.referenceSatsPerBit,
    risk.epochDurationSeconds,
    risk.minSettlementWindowSeconds,
    risk.minClaimBufferSeconds,
    risk.maxLockDurationSeconds,
    risk.maxSwapAmountWei,
    risk.maxEpochVolumeWei,
  ];
}

async function deploymentTransaction({ artifact, args, chainId, deployer, name, nonce }) {
  const factory = new ContractFactory(artifact.abi, artifact.creationCode);
  const unsigned = await factory.getDeployTransaction(...args);
  const data = String(unsigned.data ?? "").toLowerCase();
  if (!HEX.test(data) || data.length < artifact.creationCode.length) throw new Error(`${name} init code is invalid`);
  return Object.freeze({
    kind: "unsigned-contract-creation",
    name,
    chainId,
    from: deployer,
    to: null,
    nonce: String(nonce),
    valueWei: "0",
    data,
    initCodeHash: keccak256(data).toLowerCase(),
    expectedContractAddress: getCreateAddress({ from: deployer, nonce }),
  });
}

function safeAction({ sequence, previousActionDigest, safeAddress, registryAddress, data, name }) {
  const base = {
    kind: "unsigned-controller-safe-call",
    name,
    sequence,
    safeAddress,
    to: registryAddress,
    valueWei: "0",
    operation: "CALL",
    data: data.toLowerCase(),
    dataHash: keccak256(data).toLowerCase(),
    previousActionDigest,
  };
  return Object.freeze({ ...base, actionDigest: hash(base) });
}

export function assertClosedTestnetDeploymentPlanIsSecretFree(value) {
  const forbiddenKey = /(email|invoice|macaroon|mnemonic|password|preimage|private.?key|rpc.?url|seed|signature)/i;
  const visit = (entry) => {
    if (Array.isArray(entry)) {
      for (const item of entry) visit(item);
      return;
    }
    if (!entry || typeof entry !== "object") {
      if (typeof entry === "string"
          && (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(entry)
            || /ln(?:bc|bcrt|tb)[0-9a-z]{20,}/i.test(entry)
            || /https?:\/\//i.test(entry))) {
        throw new Error("deployment plan contains secret or endpoint material");
      }
      return;
    }
    for (const [key, item] of Object.entries(entry)) {
      if (forbiddenKey.test(key)) throw new Error(`deployment plan contains forbidden field ${key}`);
      visit(item);
    }
  };
  visit(value);
  return true;
}

export async function buildClosedTestnetDeploymentPlan({ input: rawInput, artifacts: rawArtifacts }) {
  const input = normalizeInput(rawInput);
  const artifacts = normalizeArtifacts(rawArtifacts);
  const start = BigInt(input.startingNonce);
  const gate = await deploymentTransaction({
    artifact: artifacts.gate,
    args: [
      input.roles.controller.address,
      input.roles.guardian.address,
      input.gate.resumeDelaySeconds,
      input.gate.maxOpenDurationSeconds,
    ],
    chainId: input.chainId,
    deployer: input.deployer,
    name: "gate",
    nonce: start,
  });
  const registry = await deploymentTransaction({
    artifact: artifacts.paymentHashRegistry,
    args: [input.roles.controller.address],
    chainId: input.chainId,
    deployer: input.deployer,
    name: "paymentHashRegistry",
    nonce: start + 1n,
  });
  const vault = await deploymentTransaction({
    artifact: artifacts.vault,
    args: [
      input.bit.proxyAddress,
      input.roles.feeCollector.address,
      gate.expectedContractAddress,
      registry.expectedContractAddress,
      riskTuple(input.vaultRisk),
    ],
    chainId: input.chainId,
    deployer: input.deployer,
    name: "vault",
    nonce: start + 2n,
  });
  const userEscrow = await deploymentTransaction({
    artifact: artifacts.userEscrow,
    args: [
      input.bit.proxyAddress,
      input.roles.feeCollector.address,
      gate.expectedContractAddress,
      registry.expectedContractAddress,
      riskTuple(input.userEscrowRisk),
    ],
    chainId: input.chainId,
    deployer: input.deployer,
    name: "userEscrow",
    nonce: start + 3n,
  });
  const registryInterface = new Interface(artifacts.paymentHashRegistry.abi);
  const first = safeAction({
    sequence: 0,
    previousActionDigest: ZERO_DIGEST,
    safeAddress: input.roles.controller.address,
    registryAddress: registry.expectedContractAddress,
    data: registryInterface.encodeFunctionData("registerEscrow", [vault.expectedContractAddress]),
    name: "register-vault",
  });
  const second = safeAction({
    sequence: 1,
    previousActionDigest: first.actionDigest,
    safeAddress: input.roles.controller.address,
    registryAddress: registry.expectedContractAddress,
    data: registryInterface.encodeFunctionData("registerEscrow", [userEscrow.expectedContractAddress]),
    name: "register-user-escrow",
  });
  const third = safeAction({
    sequence: 2,
    previousActionDigest: second.actionDigest,
    safeAddress: input.roles.controller.address,
    registryAddress: registry.expectedContractAddress,
    data: registryInterface.encodeFunctionData("seal"),
    name: "seal-registry",
  });
  const body = Object.freeze({
    schema: PLAN_SCHEMA,
    scope: input.environment === "public-testnet"
      ? "unsigned-public-testnet-plan-no-signing-broadcast-or-funding-authorization"
      : "local-rehearsal-only-no-signing-broadcast-or-funding-authorization",
    environment: input.environment,
    network: Object.freeze({
      name: input.environment === "public-testnet" ? "sepolia" : "anvil",
      chainId: input.chainId,
      mainnetAssets: false,
    }),
    source: Object.freeze({
      reviewedBuildCommit: input.reviewedBuildCommit,
      independentReviewDigest: input.independentReviewDigest,
    }),
    permissions: Object.freeze({
      signingAuthorization: false,
      broadcastAuthorization: false,
      gateOpeningAuthorization: false,
      fundingAuthorization: false,
    }),
    inputDigest: hash(input),
    artifacts: Object.freeze(Object.fromEntries(
      Object.entries(artifacts).map(([name, artifact]) => [name, artifact.digest]),
    )),
    deployer: Object.freeze({ address: input.deployer, startingNonce: input.startingNonce }),
    roles: input.roles,
    bit: input.bit,
    gate: input.gate,
    vaultRisk: input.vaultRisk,
    userEscrowRisk: input.userEscrowRisk,
    deploymentTransactions: Object.freeze([gate, registry, vault, userEscrow]),
    controllerSafeActions: Object.freeze([first, second, third]),
    requiredPreflight: Object.freeze({
      exactChainIdObserved: true,
      exactDeployerNonceObserved: true,
      roleWalletCodeOwnersAndThresholdsObserved: true,
      bitProxyImplementationCodeAndSlotObserved: true,
      bitUnpausedSymbolAndDecimalsObserved: true,
      independentReviewDigestApproved: true,
    }),
    requiredPostconditions: Object.freeze({
      gateClosed: true,
      gatePendingOpenEmpty: true,
      registrySealed: true,
      registryEscrowCount: 2,
      registeredEscrows: Object.freeze([vault.expectedContractAddress, userEscrow.expectedContractAddress]),
      vaultTotalAvailableWei: "0",
      vaultTotalLockedWei: "0",
      userEscrowTotalLockedWei: "0",
      providerObservationsRequired: 2,
      fundingAuthorization: false,
    }),
  });
  assertClosedTestnetDeploymentPlanIsSecretFree(body);
  return Object.freeze({ ...body, planDigest: hash(body) });
}

export async function verifyClosedTestnetDeploymentPlan({ input, artifacts, plan }) {
  const rebuilt = await buildClosedTestnetDeploymentPlan({ input, artifacts });
  if (canonical(plan) !== canonical(rebuilt)) throw new Error("deployment plan does not exactly match reviewed inputs and artifacts");
  return Object.freeze({
    schema: "treeswap.verified-closed-testnet-deployment-plan.v1",
    status: "exact-unsigned-plan-verified",
    scope: rebuilt.scope,
    environment: rebuilt.environment,
    chainId: rebuilt.network.chainId,
    reviewedBuildCommit: rebuilt.source.reviewedBuildCommit,
    inputDigest: rebuilt.inputDigest,
    planDigest: rebuilt.planDigest,
    expectedContracts: Object.freeze(Object.fromEntries(
      rebuilt.deploymentTransactions.map((transaction) => [transaction.name, transaction.expectedContractAddress]),
    )),
    signingAuthorization: false,
    broadcastAuthorization: false,
    gateOpeningAuthorization: false,
    fundingAuthorization: false,
  });
}
