import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstat, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import {
  Contract,
  ContractFactory,
  HDNodeWallet,
  JsonRpcProvider,
  id,
  keccak256,
  parseEther,
  sha256,
} from "ethers";
import {
  buildCrossChainDeadlineEvidence,
  crossChainDeadlinePolicy,
  crossChainDeadlineSchemas,
} from "../../lib/cross-chain-deadline-evidence.mjs";
import { buildLiveBitCrossChainDeadlineEvidence } from "../../lib/live-bit-cross-chain-deadline-evidence.mjs";
import { deriveSettlementSchedule, validateHeldHtlc } from "../../lib/settlement-policy.mjs";

const STATE_SCHEMA = "treeswap.cross-chain-deadline-state.v2";
const CHAIN_ID = 31_337;
const TEST_MNEMONIC = "test test test test test test test test test test test junk";
const LIVE_BIT_PROXY = "0x57A447E4d5e18A9423408C365963A73F08B9d18C";
const LIVE_BIT_IMPLEMENTATION = "0xa27b118c0770939295f052aE1b003366E5eF806F";
const LIVE_BIT_HOLDER = "0xFE0056580828C46B6A43243E386ea2234ad8f1Ca";
const LIVE_BIT_FORK_BLOCK = 25_788_856;
const LIVE_BIT_FORK_BLOCK_HASH = "0xf327faf6fee57fdf66e5973d19364e662da009ba266ab32899e242a2b22aef89";
const LIVE_BIT_PROXY_CODE_HASH = "0xf5648c6316e00873ef8427290251866b3675668407ecf526bf3f467578ff9adc";
const LIVE_BIT_IMPLEMENTATION_CODE_HASH = "0x506816a3d5cf9e4f486659231f21540e9985d7fbc8438dbb385accd2e532b120";
const EIP1967_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const BYTES32 = /^0x[0-9a-f]{64}$/;
const MAX_STATE_BYTES = 1_000_000;
const AMOUNT = parseEther("100");
const FEE = parseEther("1");
const INITIAL_VAULT_BALANCE = parseEther("500");

const policy = crossChainDeadlinePolicy;
const claimBufferSeconds = policy.claimRelaySeconds
  + policy.ethereumConfirmations * policy.maximumEthereumBlockSeconds
  + policy.ethereumCongestionSeconds;
const risk = Object.freeze({
  maxFeeBps: 500,
  maxPriceDeviationBps: 2_500,
  referenceSatsPerBit: 100,
  epochDuration: 86_400,
  minSettlementWindow: policy.minimumPaymentWindowSeconds,
  minClaimBuffer: claimBufferSeconds,
  maxLockDuration: policy.maximumLockSeconds,
  maxSwapAmount: parseEther("1000"),
  maxEpochVolume: parseEther("10000"),
});

const userQuoteTypes = Object.freeze({
  BitToLightningQuote: Object.freeze([
    { name: "quoteId", type: "bytes32" },
    { name: "user", type: "address" },
    { name: "solver", type: "address" },
    { name: "solverBeneficiary", type: "address" },
    { name: "amount", type: "uint96" },
    { name: "fee", type: "uint96" },
    { name: "lightningAmountSats", type: "uint64" },
    { name: "paymentHash", type: "bytes32" },
    { name: "invoiceDigest", type: "bytes32" },
    { name: "solverNonce", type: "uint256" },
    { name: "quoteExpiresAt", type: "uint64" },
    { name: "lastSafeClaimAt", type: "uint64" },
    { name: "refundAfter", type: "uint64" },
  ]),
});
const vaultQuoteTypes = Object.freeze({
  SelectedQuote: Object.freeze([
    { name: "quoteId", type: "bytes32" },
    { name: "user", type: "address" },
    { name: "solver", type: "address" },
    { name: "beneficiary", type: "address" },
    { name: "amount", type: "uint96" },
    { name: "fee", type: "uint96" },
    { name: "lightningAmountSats", type: "uint64" },
    { name: "paymentHash", type: "bytes32" },
    { name: "invoiceDigest", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "quoteExpiresAt", type: "uint64" },
    { name: "lastSafeClaimAt", type: "uint64" },
    { name: "refundAfter", type: "uint64" },
  ]),
});

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function exactObject(value, keys, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${name} fields are not exact`);
  }
  return value;
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive safe integer`);
  return value;
}

function bytes32(value, name) {
  const result = String(value ?? "").toLowerCase();
  if (!BYTES32.test(result) || result === `0x${"00".repeat(32)}`) throw new TypeError(`${name} must be a nonzero bytes32`);
  return result;
}

function wallet(index, provider) {
  return HDNodeWallet.fromPhrase(TEST_MNEMONIC, undefined, `m/44'/60'/0'/0/${index}`).connect(provider);
}

function publishedSource() {
  const capture = (args) => execFileSync("git", args, { encoding: "utf8" }).trim();
  if (capture(["status", "--porcelain", "--untracked-files=all"])) {
    throw new Error("live-BIT deadline evidence requires a clean source tree");
  }
  const branch = capture(["branch", "--show-current"]);
  const commit = capture(["rev-parse", "HEAD"]);
  const publishedCommit = capture(["rev-parse", "origin/main"]);
  if (branch !== "main" || commit !== publishedCommit || !/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error("live-BIT deadline evidence requires exact published main");
  }
  return Object.freeze({ branch, commit, clean: true, published: true });
}

async function artifact(path) {
  return JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
}

async function deploy(factoryArtifact, signer, args = []) {
  const factory = new ContractFactory(factoryArtifact.abi, factoryArtifact.bytecode.object, signer);
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();
  return contract;
}

async function send(transaction) {
  const receipt = await (await transaction).wait();
  assert.equal(receipt.status, 1);
  return receipt;
}

async function readInput() {
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (Buffer.byteLength(raw) > 65_536) throw new Error("cross-chain smoke input exceeded its limit");
  }
  return raw.trim() ? JSON.parse(raw) : {};
}

function exactInvoiceInput(input, expectedAmount, name) {
  exactObject(input, ["bitcoinHeight", "invoice", "invoiceDigest", "paymentHash", "amountSats"], name);
  exactObject(input.invoice, ["expirySeconds", "minFinalCltvExpiryDelta", "timestamp"], `${name}.invoice`);
  if (String(input.amountSats) !== expectedAmount) throw new RangeError(`${name}.amountSats is not the campaign amount`);
  return Object.freeze({
    bitcoinHeight: positiveInteger(input.bitcoinHeight, `${name}.bitcoinHeight`),
    invoice: Object.freeze({
      timestamp: positiveInteger(input.invoice.timestamp, `${name}.invoice.timestamp`),
      expirySeconds: positiveInteger(input.invoice.expirySeconds, `${name}.invoice.expirySeconds`),
      minFinalCltvExpiryDelta: positiveInteger(
        input.invoice.minFinalCltvExpiryDelta,
        `${name}.invoice.minFinalCltvExpiryDelta`,
      ),
    }),
    invoiceDigest: bytes32(input.invoiceDigest, `${name}.invoiceDigest`),
    paymentHash: bytes32(input.paymentHash, `${name}.paymentHash`),
    amountSats: expectedAmount,
  });
}

async function stateParentIsPrivate(statePath) {
  const parent = await lstat(dirname(statePath));
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) !== 0) {
    throw new Error("cross-chain state parent must be a private real directory");
  }
}

async function readState(statePath) {
  const stat = await lstat(statePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STATE_BYTES || (stat.mode & 0o077) !== 0) {
    throw new Error("cross-chain state must be a private bounded regular file");
  }
  const state = JSON.parse(await readFile(statePath, "utf8"));
  exactObject(state, [
    "anvilVersion",
    "bitToLightning",
    "chainId",
    "contracts",
    "lightningToBit",
    "policy",
    "schema",
    "source",
    "token",
    "tokenMode",
  ], "state");
  if (state.schema !== STATE_SCHEMA || state.chainId !== String(CHAIN_ID)) throw new Error("cross-chain state identity changed");
  if (JSON.stringify(state.policy) !== JSON.stringify(policy)) throw new Error("cross-chain state policy changed");
  if (state.tokenMode !== tokenMode) throw new Error("cross-chain token boundary changed");
  if (state.tokenMode === "live-bit" && JSON.stringify(state.source) !== JSON.stringify(publishedSource())) {
    throw new Error("live-BIT deadline source identity changed");
  }
  return state;
}

async function writeState(statePath, state, create = false) {
  await stateParentIsPrivate(statePath);
  const serialized = `${JSON.stringify(state, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > MAX_STATE_BYTES) throw new Error("cross-chain state exceeded its limit");
  if (create) {
    await writeFile(statePath, serialized, { flag: "wx", mode: 0o600 });
    return;
  }
  const temporary = `${statePath}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, serialized, { flag: "wx", mode: 0o600 });
    await rename(temporary, statePath);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function blockTimestamp(provider, blockNumber = "latest") {
  const block = await provider.getBlock(blockNumber);
  if (!block) throw new Error("EVM block is unavailable");
  return Number(block.timestamp);
}

async function rpcBlock(provider, blockNumber) {
  return provider.send("eth_getBlockByNumber", [`0x${blockNumber.toString(16)}`, false]);
}

async function observeLiveBitToken(provider, liveBitArtifact) {
  const forkBlock = await rpcBlock(provider, LIVE_BIT_FORK_BLOCK);
  assert.equal(forkBlock?.hash?.toLowerCase(), LIVE_BIT_FORK_BLOCK_HASH);
  const proxyCodeHash = keccak256(await provider.getCode(LIVE_BIT_PROXY)).toLowerCase();
  const implementationCodeHash = keccak256(await provider.getCode(LIVE_BIT_IMPLEMENTATION)).toLowerCase();
  assert.equal(proxyCodeHash, LIVE_BIT_PROXY_CODE_HASH);
  assert.equal(implementationCodeHash, LIVE_BIT_IMPLEMENTATION_CODE_HASH);
  const implementationWord = await provider.getStorage(LIVE_BIT_PROXY, EIP1967_IMPLEMENTATION_SLOT);
  assert.equal(`0x${implementationWord.slice(-40)}`.toLowerCase(), LIVE_BIT_IMPLEMENTATION.toLowerCase());
  const bit = new Contract(LIVE_BIT_PROXY, liveBitArtifact.abi, provider);
  assert.equal(await bit.symbol(), "BIT");
  assert.equal(await bit.decimals(), 18n);
  assert.equal(await bit.paused(), false);
  return Object.freeze({
    boundary: "pinned-live-bit-proxy-fork",
    sourceChainId: "1",
    forkBlockNumber: String(LIVE_BIT_FORK_BLOCK),
    forkBlockHash: LIVE_BIT_FORK_BLOCK_HASH,
    proxyAddress: LIVE_BIT_PROXY,
    proxyCodeHash,
    implementationAddress: LIVE_BIT_IMPLEMENTATION,
    implementationCodeHash,
    implementationSlot: EIP1967_IMPLEMENTATION_SLOT,
    symbol: "BIT",
    decimals: "18",
    paused: false,
  });
}

async function setNextTimestamp(provider, timestamp) {
  const latest = await blockTimestamp(provider);
  if (timestamp <= latest) return;
  await provider.send("evm_setNextBlockTimestamp", [timestamp]);
}

async function mineConfirmations(provider, blockNumber, requiredConfirmations) {
  let latest = await provider.getBlockNumber();
  while (latest - blockNumber + 1 < requiredConfirmations) {
    const timestamp = await blockTimestamp(provider);
    await provider.send("evm_setNextBlockTimestamp", [timestamp + policy.maximumEthereumBlockSeconds]);
    await provider.send("evm_mine", []);
    latest = await provider.getBlockNumber();
  }
  return Object.freeze({
    confirmations: latest - blockNumber + 1,
    finalizedAt: await blockTimestamp(provider),
  });
}

function scheduleFor(input, direction, derivedAt) {
  return deriveSettlementSchedule({
    direction,
    nowSeconds: derivedAt,
    bitcoinHeight: input.bitcoinHeight,
    invoice: input.invoice,
    policy,
  });
}

function output(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

const action = process.argv[2];
const allowedActions = new Set([
  "initialize",
  "open-bit-to-lightning",
  "finalize-bit-to-lightning",
  "claim-bit-to-lightning",
  "open-lightning-to-bit",
  "finalize-lightning-to-bit",
  "observe-lightning-to-bit-accepted",
  "verify-lightning-to-bit-boundary",
  "finalize-evidence",
]);
if (process.argv.length !== 3 || !allowedActions.has(action)) throw new Error("cross-chain smoke action is invalid");

const rpcUrl = new URL(required("CROSS_CHAIN_DEADLINE_RPC_URL"));
if (rpcUrl.protocol !== "http:" || rpcUrl.hostname !== "127.0.0.1" || !rpcUrl.port) {
  throw new Error("cross-chain smoke RPC must be an isolated loopback endpoint");
}
const statePath = required("CROSS_CHAIN_DEADLINE_STATE_PATH");
if (!isAbsolute(statePath) || statePath.length > 1_000) throw new Error("cross-chain state path must be bounded and absolute");
if (required("CROSS_CHAIN_DEADLINE_MNEMONIC") !== TEST_MNEMONIC) {
  throw new Error("cross-chain smoke accepts only the public Anvil test mnemonic");
}
const anvilVersion = required("CROSS_CHAIN_DEADLINE_ANVIL_VERSION");
if (anvilVersion.length > 200 || /[\r\n]/.test(anvilVersion)) throw new Error("execution-client version is invalid");
const tokenMode = required("CROSS_CHAIN_DEADLINE_TOKEN_MODE");
if (!new Set(["mock", "live-bit"]).has(tokenMode)) throw new Error("cross-chain deadline token mode is invalid");
const input = await readInput();
const provider = new JsonRpcProvider(rpcUrl.toString(), CHAIN_ID, { staticNetwork: true, cacheTimeout: -1 });

try {
  if (action === "initialize") {
    exactObject(input, [], "initialize input");
    const [mockBitArtifact, liveBitArtifact, mockGateArtifact, registryArtifact, vaultArtifact, userEscrowArtifact] = await Promise.all([
      artifact("../../contracts/out/TestBase.sol/MockBit.json"),
      artifact("../../contracts/out/TreeSwapMainnetFork.t.sol/ILiveBit.json"),
      artifact("../../contracts/out/TestBase.sol/MockOpenGate.json"),
      artifact("../../contracts/out/TreeSwapPaymentHashRegistry.sol/TreeSwapPaymentHashRegistry.json"),
      artifact("../../contracts/out/TreeSwapBitVault.sol/TreeSwapBitVault.json"),
      artifact("../../contracts/out/TreeSwapUserEscrow.sol/TreeSwapUserEscrow.json"),
    ]);
    const source = tokenMode === "live-bit" ? publishedSource() : null;
    const walletOffset = tokenMode === "live-bit" ? 1_000 : 0;
    const deployer = wallet(walletOffset, provider);
    const user = wallet(walletOffset + 1, provider);
    const solver = wallet(walletOffset + 2, provider);
    const beneficiary = wallet(walletOffset + 3, provider);
    const collector = wallet(walletOffset + 4, provider);
    if (tokenMode === "live-bit") {
      for (const actor of [deployer, user, solver, beneficiary, collector]) {
        assert.equal(await provider.getCode(actor.address), "0x", "live-fork actor unexpectedly has code");
        await provider.send("anvil_setBalance", [actor.address, "0x56bc75e2d63100000"]);
      }
    }
    const token = tokenMode === "live-bit" ? await observeLiveBitToken(provider, liveBitArtifact) : null;
    const bit = tokenMode === "live-bit"
      ? new Contract(LIVE_BIT_PROXY, liveBitArtifact.abi, provider)
      : await deploy(mockBitArtifact, deployer);
    const gate = await deploy(mockGateArtifact, deployer);
    const registry = await deploy(registryArtifact, deployer, [deployer.address]);
    const vault = await deploy(vaultArtifact, deployer, [
      await bit.getAddress(), collector.address, await gate.getAddress(), await registry.getAddress(), risk,
    ]);
    const userEscrow = await deploy(userEscrowArtifact, deployer, [
      await bit.getAddress(), collector.address, await gate.getAddress(), await registry.getAddress(), risk,
    ]);
    await send(registry.connect(deployer).registerEscrow(await vault.getAddress()));
    await send(registry.connect(deployer).registerEscrow(await userEscrow.getAddress()));
    await send(registry.connect(deployer).seal());
    if (tokenMode === "live-bit") {
      await provider.send("anvil_setBalance", [LIVE_BIT_HOLDER, "0x56bc75e2d63100000"]);
      await provider.send("anvil_impersonateAccount", [LIVE_BIT_HOLDER]);
      try {
        const holder = await provider.getSigner(LIVE_BIT_HOLDER);
        await send(bit.connect(holder).transfer(user.address, parseEther("1000")));
        await send(bit.connect(holder).transfer(solver.address, parseEther("1000")));
      } finally {
        await provider.send("anvil_stopImpersonatingAccount", [LIVE_BIT_HOLDER]);
      }
    } else {
      await send(bit.connect(deployer).mint(user.address, parseEther("1000")));
      await send(bit.connect(deployer).mint(solver.address, parseEther("1000")));
    }
    await send(bit.connect(user).approve(await userEscrow.getAddress(), parseEther("1000")));
    await send(bit.connect(solver).approve(await vault.getAddress(), parseEther("1000")));
    await send(vault.connect(solver).deposit(INITIAL_VAULT_BALANCE));
    const state = {
      schema: STATE_SCHEMA,
      chainId: String(CHAIN_ID),
      anvilVersion,
      tokenMode,
      source,
      token,
      policy,
      contracts: {
        bit: await bit.getAddress(),
        registry: await registry.getAddress(),
        vault: await vault.getAddress(),
        userEscrow: await userEscrow.getAddress(),
        vaultRuntimeCodeHash: keccak256(await provider.getCode(await vault.getAddress())).toLowerCase(),
        userEscrowRuntimeCodeHash: keccak256(await provider.getCode(await userEscrow.getAddress())).toLowerCase(),
      },
      bitToLightning: null,
      lightningToBit: null,
    };
    await writeState(statePath, state, true);
    output({ status: "initialized", chainId: String(CHAIN_ID) });
  } else {
    const state = await readState(statePath);
    const walletOffset = state.tokenMode === "live-bit" ? 1_000 : 0;
    const user = wallet(walletOffset + 1, provider);
    const solver = wallet(walletOffset + 2, provider);
    const beneficiary = wallet(walletOffset + 3, provider);
    const deployer = wallet(walletOffset, provider);
    const bitArtifact = await artifact("../../contracts/out/TestBase.sol/MockBit.json");
    const liveBitArtifact = await artifact("../../contracts/out/TreeSwapMainnetFork.t.sol/ILiveBit.json");
    const vaultArtifact = await artifact("../../contracts/out/TreeSwapBitVault.sol/TreeSwapBitVault.json");
    const userEscrowArtifact = await artifact("../../contracts/out/TreeSwapUserEscrow.sol/TreeSwapUserEscrow.json");
    const bit = new Contract(state.contracts.bit, state.tokenMode === "live-bit" ? liveBitArtifact.abi : bitArtifact.abi, provider);
    const vault = new Contract(state.contracts.vault, vaultArtifact.abi, provider);
    const userEscrow = new Contract(state.contracts.userEscrow, userEscrowArtifact.abi, provider);

    if (action === "open-bit-to-lightning") {
      if (state.bitToLightning !== null) throw new Error("BIT-to-Lightning campaign was already opened");
      const normalized = exactInvoiceInput(input, "9900", "BIT-to-Lightning input");
      const latest = await blockTimestamp(provider);
      const derivedAt = Math.max(Math.floor(Date.now() / 1_000), latest + 1);
      const schedule = scheduleFor(normalized, "bit-to-lightning", derivedAt);
      await setNextTimestamp(provider, derivedAt);
      const quote = Object.freeze({
        quoteId: id("treeswap-cross-chain-bit-to-lightning"),
        user: user.address,
        solver: solver.address,
        solverBeneficiary: beneficiary.address,
        amount: AMOUNT,
        fee: FEE,
        lightningAmountSats: 9_900n,
        paymentHash: normalized.paymentHash,
        invoiceDigest: normalized.invoiceDigest,
        solverNonce: 1n,
        quoteExpiresAt: BigInt(schedule.quoteExpiresAt),
        lastSafeClaimAt: BigInt(schedule.lastSafeClaimAt),
        refundAfter: BigInt(schedule.refundAfter),
      });
      const domain = {
        name: "TreeSwap User BIT Escrow",
        version: "1",
        chainId: CHAIN_ID,
        verifyingContract: state.contracts.userEscrow,
      };
      const signature = await solver.signTypedData(domain, userQuoteTypes, quote);
      const receipt = await send(userEscrow.connect(user).open(quote, signature));
      const openedAt = await blockTimestamp(provider, receipt.blockNumber);
      const intentDigest = (await userEscrow.hashSolverQuote(quote)).toLowerCase();
      state.bitToLightning = {
        bitcoinHeight: normalized.bitcoinHeight,
        invoice: normalized.invoice,
        schedule,
        paymentHash: normalized.paymentHash,
        invoiceDigest: normalized.invoiceDigest,
        quoteId: quote.quoteId,
        intentDigest,
        evm: {
          openedBlock: receipt.blockNumber,
          openedAt,
          finalizedAt: null,
          confirmations: null,
          refundRejectedBeforeClaim: false,
          claimedAt: null,
          claimSucceeded: false,
        },
        lightning: { paymentSucceeded: false, paymentPreimageMatched: false },
      };
      await writeState(statePath, state);
      output({ status: "opened", direction: "bit-to-lightning", intentDigest, schedule });
    } else if (action === "finalize-bit-to-lightning") {
      exactObject(input, [], "finalize BIT-to-Lightning input");
      if (!state.bitToLightning || state.bitToLightning.evm.finalizedAt !== null) {
        throw new Error("BIT-to-Lightning escrow is not awaiting finality");
      }
      const finalized = await mineConfirmations(
        provider,
        state.bitToLightning.evm.openedBlock,
        policy.ethereumConfirmations,
      );
      if (finalized.finalizedAt > state.bitToLightning.schedule.ethereumFinalAt) {
        throw new Error("BIT-to-Lightning simulated finality exceeded policy");
      }
      Object.assign(state.bitToLightning.evm, finalized);
      await writeState(statePath, state);
      output({ status: "finalized", direction: "bit-to-lightning", ...finalized });
    } else if (action === "claim-bit-to-lightning") {
      exactObject(input, ["preimage"], "claim BIT-to-Lightning input");
      const preimage = bytes32(input.preimage, "claim BIT-to-Lightning preimage");
      if (!state.bitToLightning || state.bitToLightning.evm.finalizedAt === null || state.bitToLightning.evm.claimSucceeded) {
        throw new Error("BIT-to-Lightning escrow is not claimable");
      }
      if (sha256(preimage).toLowerCase() !== state.bitToLightning.paymentHash) {
        throw new Error("BIT-to-Lightning payment proof does not match the escrow");
      }
      await assert.rejects(userEscrow.connect(user).refund.staticCall(state.bitToLightning.quoteId));
      const before = await bit.balanceOf(beneficiary.address);
      const receipt = await send(userEscrow.connect(deployer).claim(state.bitToLightning.quoteId, preimage));
      const after = await bit.balanceOf(beneficiary.address);
      assert.equal(after - before, AMOUNT - FEE);
      const claimedAt = await blockTimestamp(provider, receipt.blockNumber);
      Object.assign(state.bitToLightning.evm, {
        refundRejectedBeforeClaim: true,
        claimedAt,
        claimSucceeded: true,
      });
      Object.assign(state.bitToLightning.lightning, {
        paymentSucceeded: true,
        paymentPreimageMatched: true,
      });
      await writeState(statePath, state);
      output({ status: "claimed", direction: "bit-to-lightning", claimedAt });
    } else if (action === "open-lightning-to-bit") {
      if (state.lightningToBit !== null) throw new Error("Lightning-to-BIT campaign was already reserved");
      const normalized = exactInvoiceInput(input, "10000", "Lightning-to-BIT input");
      const latest = await blockTimestamp(provider);
      const derivedAt = Math.max(Math.floor(Date.now() / 1_000), latest + 1);
      const schedule = scheduleFor(normalized, "lightning-to-bit", derivedAt);
      await setNextTimestamp(provider, derivedAt);
      const quote = Object.freeze({
        quoteId: id("treeswap-cross-chain-lightning-to-bit"),
        user: user.address,
        solver: solver.address,
        beneficiary: beneficiary.address,
        amount: AMOUNT,
        fee: FEE,
        lightningAmountSats: 10_000n,
        paymentHash: normalized.paymentHash,
        invoiceDigest: normalized.invoiceDigest,
        nonce: 2n,
        quoteExpiresAt: BigInt(schedule.quoteExpiresAt),
        lastSafeClaimAt: BigInt(schedule.lastSafeClaimAt),
        refundAfter: BigInt(schedule.refundAfter),
      });
      const domain = {
        name: "TreeSwap BIT Vault",
        version: "1",
        chainId: CHAIN_ID,
        verifyingContract: state.contracts.vault,
      };
      const [userSignature, solverSignature] = await Promise.all([
        user.signTypedData(domain, vaultQuoteTypes, quote),
        solver.signTypedData(domain, vaultQuoteTypes, quote),
      ]);
      const receipt = await send(vault.connect(user).reserve(quote, userSignature, solverSignature));
      const reservedAt = await blockTimestamp(provider, receipt.blockNumber);
      const intentDigest = (await vault.hashSelectedQuote(quote)).toLowerCase();
      state.lightningToBit = {
        bitcoinHeight: normalized.bitcoinHeight,
        invoice: normalized.invoice,
        schedule,
        paymentHash: normalized.paymentHash,
        invoiceDigest: normalized.invoiceDigest,
        quoteId: quote.quoteId,
        intentDigest,
        evm: {
          reservedBlock: receipt.blockNumber,
          reservedAt,
          finalizedAt: null,
          confirmations: null,
          refundRejectedBeforeBoundary: false,
          claimSimulationSucceededBeforeRefund: false,
          claimRejectedAtRefundBoundary: false,
          refundedAt: null,
          refundSucceeded: false,
        },
        lightning: {
          acceptedHeight: null,
          expiryHeight: null,
          safeHeight: null,
          boundaryHeight: null,
          initialHtlcValid: false,
          settlementRejectedAtBoundary: false,
          payerReleased: false,
        },
      };
      await writeState(statePath, state);
      output({ status: "reserved", direction: "lightning-to-bit", intentDigest, schedule });
    } else if (action === "finalize-lightning-to-bit") {
      exactObject(input, [], "finalize Lightning-to-BIT input");
      if (!state.lightningToBit || state.lightningToBit.evm.finalizedAt !== null) {
        throw new Error("Lightning-to-BIT reservation is not awaiting finality");
      }
      const finalized = await mineConfirmations(
        provider,
        state.lightningToBit.evm.reservedBlock,
        policy.ethereumConfirmations,
      );
      if (finalized.finalizedAt > state.lightningToBit.schedule.ethereumFinalAt) {
        throw new Error("Lightning-to-BIT simulated finality exceeded policy");
      }
      Object.assign(state.lightningToBit.evm, finalized);
      await writeState(statePath, state);
      output({ status: "finalized", direction: "lightning-to-bit", ...finalized });
    } else if (action === "observe-lightning-to-bit-accepted") {
      exactObject(input, ["acceptedHeight", "expiryHeight"], "accepted HTLC input");
      if (!state.lightningToBit || state.lightningToBit.evm.finalizedAt === null) {
        throw new Error("Lightning-to-BIT reservation was not finalized before HTLC acceptance");
      }
      const acceptedHeight = positiveInteger(input.acceptedHeight, "accepted HTLC height");
      const expiryHeight = positiveInteger(input.expiryHeight, "accepted HTLC expiry height");
      const held = validateHeldHtlc({
        schedule: state.lightningToBit.schedule,
        observedAt: state.lightningToBit.schedule.derivedAt,
        currentBitcoinHeight: acceptedHeight,
        htlcExpiryHeight: expiryHeight,
        policy,
      });
      if (!held.valid) {
        throw new Error("accepted live HTLC does not satisfy the signed safety policy");
      }
      Object.assign(state.lightningToBit.lightning, {
        acceptedHeight,
        expiryHeight,
        safeHeight: held.safeHeight,
        initialHtlcValid: true,
      });
      await writeState(statePath, state);
      output({ status: "accepted", direction: "lightning-to-bit", safeHeight: held.safeHeight });
    } else if (action === "verify-lightning-to-bit-boundary") {
      exactObject(
        input,
        ["boundaryHeight", "payerReleased", "preimage", "settlementRejectedAtBoundary"],
        "Lightning-to-BIT boundary input",
      );
      const preimage = bytes32(input.preimage, "Lightning-to-BIT boundary preimage");
      if (input.payerReleased !== true || input.settlementRejectedAtBoundary !== true) {
        throw new Error("live Lightning boundary did not fail closed and release the payer");
      }
      if (!state.lightningToBit?.lightning.initialHtlcValid || state.lightningToBit.evm.finalizedAt === null) {
        throw new Error("Lightning-to-BIT boundary lacks a finalized reservation and accepted HTLC");
      }
      if (sha256(preimage).toLowerCase() !== state.lightningToBit.paymentHash) {
        throw new Error("Lightning-to-BIT hold proof does not match the escrow");
      }
      const boundaryHeight = positiveInteger(input.boundaryHeight, "Lightning-to-BIT boundary height");
      if (boundaryHeight !== state.lightningToBit.lightning.safeHeight) {
        throw new Error("live Lightning boundary is not the exact safe height");
      }
      const boundary = validateHeldHtlc({
        schedule: state.lightningToBit.schedule,
        observedAt: state.lightningToBit.schedule.derivedAt,
        currentBitcoinHeight: boundaryHeight,
        htlcExpiryHeight: state.lightningToBit.lightning.expiryHeight,
        policy,
      });
      if (boundary.valid) throw new Error("held HTLC remained actionable at its safety boundary");
      await assert.rejects(vault.connect(solver).refund.staticCall(state.lightningToBit.quoteId));
      await vault.connect(deployer).claim.staticCall(state.lightningToBit.quoteId, preimage);
      const refundAfter = state.lightningToBit.schedule.refundAfter;
      await setNextTimestamp(provider, refundAfter);
      await provider.send("evm_mine", []);
      await assert.rejects(vault.connect(deployer).claim.staticCall(state.lightningToBit.quoteId, preimage));
      const receipt = await send(vault.connect(solver).refund(state.lightningToBit.quoteId));
      assert.equal(await vault.availableBalance(solver.address), INITIAL_VAULT_BALANCE);
      assert.equal(await vault.totalLocked(), 0n);
      const refundedAt = await blockTimestamp(provider, receipt.blockNumber);
      Object.assign(state.lightningToBit.lightning, {
        boundaryHeight,
        settlementRejectedAtBoundary: true,
        payerReleased: true,
      });
      Object.assign(state.lightningToBit.evm, {
        refundRejectedBeforeBoundary: true,
        claimSimulationSucceededBeforeRefund: true,
        claimRejectedAtRefundBoundary: true,
        refundedAt,
        refundSucceeded: true,
      });
      await writeState(statePath, state);
      output({ status: "refunded", direction: "lightning-to-bit", refundedAt });
    } else if (action === "finalize-evidence") {
      exactObject(input, [], "finalize evidence input");
      if (!state.bitToLightning?.evm.claimSucceeded || !state.lightningToBit?.evm.refundSucceeded) {
        throw new Error("cross-chain campaign is incomplete");
      }
      const observation = {
        schema: crossChainDeadlineSchemas.observation,
        policy: state.policy,
        evm: {
          chainId: state.chainId,
          executionClient: state.anvilVersion,
          userEscrowRuntimeCodeHash: state.contracts.userEscrowRuntimeCodeHash,
          vaultRuntimeCodeHash: state.contracts.vaultRuntimeCodeHash,
        },
        bitToLightning: {
          bitcoinHeight: state.bitToLightning.bitcoinHeight,
          invoice: state.bitToLightning.invoice,
          schedule: state.bitToLightning.schedule,
          lightning: state.bitToLightning.lightning,
          evm: {
            openedAt: state.bitToLightning.evm.openedAt,
            finalizedAt: state.bitToLightning.evm.finalizedAt,
            confirmations: state.bitToLightning.evm.confirmations,
            refundRejectedBeforeClaim: state.bitToLightning.evm.refundRejectedBeforeClaim,
            claimedAt: state.bitToLightning.evm.claimedAt,
            claimSucceeded: state.bitToLightning.evm.claimSucceeded,
          },
        },
        lightningToBit: {
          bitcoinHeight: state.lightningToBit.bitcoinHeight,
          invoice: state.lightningToBit.invoice,
          schedule: state.lightningToBit.schedule,
          lightning: state.lightningToBit.lightning,
          evm: {
            reservedAt: state.lightningToBit.evm.reservedAt,
            finalizedAt: state.lightningToBit.evm.finalizedAt,
            confirmations: state.lightningToBit.evm.confirmations,
            refundRejectedBeforeBoundary: state.lightningToBit.evm.refundRejectedBeforeBoundary,
            claimSimulationSucceededBeforeRefund: state.lightningToBit.evm.claimSimulationSucceededBeforeRefund,
            claimRejectedAtRefundBoundary: state.lightningToBit.evm.claimRejectedAtRefundBoundary,
            refundedAt: state.lightningToBit.evm.refundedAt,
            refundSucceeded: state.lightningToBit.evm.refundSucceeded,
          },
        },
      };
      const evidence = state.tokenMode === "live-bit"
        ? buildLiveBitCrossChainDeadlineEvidence({
          observation,
          source: state.source,
          token: await observeLiveBitToken(provider, liveBitArtifact),
        })
        : buildCrossChainDeadlineEvidence(observation);
      output(evidence);
    }
  }
} finally {
  provider.destroy();
}
