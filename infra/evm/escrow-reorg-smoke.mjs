import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
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
import { coordinatorCommitmentDigest } from "../../lib/coordinator-store.mjs";
import {
  authorizeLightningAction,
  issueLightningAuthorization,
  validateLightningDispatch,
} from "../../lib/settlement-policy.mjs";

const RPC_URL = process.env.ESCROW_REORG_RPC_URL;
const MNEMONIC = process.env.ESCROW_REORG_MNEMONIC;
const ANVIL_VERSION = process.env.ESCROW_REORG_ANVIL_VERSION;
if (!RPC_URL || !MNEMONIC || !ANVIL_VERSION) {
  throw new Error("escrow reorg smoke requires an ephemeral RPC URL, mnemonic, and execution-client version");
}
if (ANVIL_VERSION.length > 200 || /[\r\n]/.test(ANVIL_VERSION)) throw new Error("execution-client version is invalid");

const TOKEN_MODE = process.env.ESCROW_REORG_TOKEN_MODE ?? "mock";
if (!new Set(["mock", "live-bit"]).has(TOKEN_MODE)) throw new Error("escrow reorg token mode is invalid");

const CHAIN_ID = 31_337;
const LIVE_BIT_PROXY = "0x57A447E4d5e18A9423408C365963A73F08B9d18C";
const LIVE_BIT_IMPLEMENTATION = "0xa27b118c0770939295f052aE1b003366E5eF806F";
const LIVE_BIT_HOLDER = "0xFE0056580828C46B6A43243E386ea2234ad8f1Ca";
const LIVE_BIT_FORK_BLOCK = 25_788_856;
const LIVE_BIT_FORK_BLOCK_HASH = "0xf327faf6fee57fdf66e5973d19364e662da009ba266ab32899e242a2b22aef89";
const LIVE_BIT_PROXY_CODE_HASH = "0xf5648c6316e00873ef8427290251866b3675668407ecf526bf3f467578ff9adc";
const LIVE_BIT_IMPLEMENTATION_CODE_HASH = "0x506816a3d5cf9e4f486659231f21540e9985d7fbc8438dbb385accd2e532b120";
const EIP1967_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const UNSET = 0n;
const LOCKED = 1n;
const CLAIMED = 2n;
const AMOUNT = parseEther("100");
const FEE = parseEther("1");
const LIGHTNING_SATS = 9_900n;

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
const policy = Object.freeze({
  ethereumConfirmations: 1,
  maxFinalityLagBlocks: 80,
  maxAuthorizationAgeSeconds: 15,
});
const healthyService = Object.freeze({
  riskGateEnabled: true,
  balancesReconciled: true,
  lightningNodeSynced: true,
  adapterHealthy: true,
});

function wallet(index, provider) {
  return HDNodeWallet.fromPhrase(MNEMONIC, undefined, `m/44'/60'/0'/0/${index}`).connect(provider);
}

function publishedSource() {
  const capture = (args) => execFileSync("git", args, { encoding: "utf8" }).trim();
  if (capture(["status", "--porcelain", "--untracked-files=all"])) {
    throw new Error("live-BIT reorg evidence requires a clean source tree");
  }
  const branch = capture(["branch", "--show-current"]);
  const commit = capture(["rev-parse", "HEAD"]);
  const publishedCommit = capture(["rev-parse", "origin/main"]);
  if (branch !== "main" || commit !== publishedCommit || !/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error("live-BIT reorg evidence requires exact published main");
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

async function rpcBlockNumber(provider) {
  return Number.parseInt(await provider.send("eth_blockNumber", []), 16);
}

async function rpcBlock(provider, blockNumber) {
  return provider.send("eth_getBlockByNumber", [`0x${blockNumber.toString(16)}`, false]);
}

async function mineReplacementAt(provider, blockNumber, oldHash) {
  while (await rpcBlockNumber(provider) < blockNumber) await provider.send("evm_mine", []);
  const replacement = await rpcBlock(provider, blockNumber);
  assert.ok(replacement?.hash);
  assert.notEqual(replacement.hash.toLowerCase(), oldHash.toLowerCase());
  return replacement.hash.toLowerCase();
}

function chainView({ receipt, canonicalBlockHash, intentDigest, latestBlock }) {
  return Object.freeze({
    latestBlock,
    finalizedBlock: latestBlock,
    escrowBlock: receipt.blockNumber,
    escrowBlockHash: receipt.blockHash.toLowerCase(),
    canonicalBlockHash,
    escrowDigest: intentDigest,
    expectedEscrowDigest: intentDigest,
  });
}

async function send(transaction) {
  const receipt = await (await transaction).wait();
  assert.equal(receipt.status, 1);
  return receipt;
}

const provider = new JsonRpcProvider(RPC_URL, CHAIN_ID, { staticNetwork: true, cacheTimeout: -1 });
try {
  const [mockBitArtifact, liveBitArtifact, mockGateArtifact, registryArtifact, vaultArtifact, userEscrowArtifact] = await Promise.all([
    artifact("../../contracts/out/TestBase.sol/MockBit.json"),
    artifact("../../contracts/out/TreeSwapMainnetFork.t.sol/ILiveBit.json"),
    artifact("../../contracts/out/TestBase.sol/MockOpenGate.json"),
    artifact("../../contracts/out/TreeSwapPaymentHashRegistry.sol/TreeSwapPaymentHashRegistry.json"),
    artifact("../../contracts/out/TreeSwapBitVault.sol/TreeSwapBitVault.json"),
    artifact("../../contracts/out/TreeSwapUserEscrow.sol/TreeSwapUserEscrow.json"),
  ]);
  const source = TOKEN_MODE === "live-bit" ? publishedSource() : null;
  // The familiar first mnemonic accounts may already be contracts or delegated
  // accounts in mainnet state. Use high deterministic indices on the live fork
  // and prove every signature-bearing actor is still a plain EOA there.
  const walletOffset = TOKEN_MODE === "live-bit" ? 1_000 : 0;
  const deployer = wallet(walletOffset, provider);
  const user = wallet(walletOffset + 1, provider);
  const solver = wallet(walletOffset + 2, provider);
  const beneficiary = wallet(walletOffset + 3, provider);
  const collector = wallet(walletOffset + 4, provider);
  if (TOKEN_MODE === "live-bit") {
    for (const actor of [deployer, user, solver, beneficiary, collector]) {
      assert.equal(await provider.getCode(actor.address), "0x", "live-fork actor unexpectedly has code");
      await provider.send("anvil_setBalance", [actor.address, "0x56bc75e2d63100000"]);
    }
  }
  let bit;
  let liveBitEvidence = null;
  if (TOKEN_MODE === "live-bit") {
    const forkBlock = await rpcBlock(provider, LIVE_BIT_FORK_BLOCK);
    assert.equal(forkBlock?.hash?.toLowerCase(), LIVE_BIT_FORK_BLOCK_HASH);
    const proxyCodeHash = keccak256(await provider.getCode(LIVE_BIT_PROXY)).toLowerCase();
    const implementationCodeHash = keccak256(await provider.getCode(LIVE_BIT_IMPLEMENTATION)).toLowerCase();
    assert.equal(proxyCodeHash, LIVE_BIT_PROXY_CODE_HASH);
    assert.equal(implementationCodeHash, LIVE_BIT_IMPLEMENTATION_CODE_HASH);
    const implementationWord = await provider.getStorage(LIVE_BIT_PROXY, EIP1967_IMPLEMENTATION_SLOT);
    assert.equal(`0x${implementationWord.slice(-40)}`.toLowerCase(), LIVE_BIT_IMPLEMENTATION.toLowerCase());
    bit = new Contract(LIVE_BIT_PROXY, liveBitArtifact.abi, provider);
    assert.equal(await bit.symbol(), "BIT");
    assert.equal(await bit.decimals(), 18n);
    assert.equal(await bit.paused(), false);
    liveBitEvidence = Object.freeze({
      sourceChainId: "1",
      forkBlockNumber: String(LIVE_BIT_FORK_BLOCK),
      forkBlockHash: LIVE_BIT_FORK_BLOCK_HASH,
      proxyAddress: LIVE_BIT_PROXY,
      proxyCodeHash,
      implementationAddress: LIVE_BIT_IMPLEMENTATION,
      implementationCodeHash,
      symbol: "BIT",
      decimals: "18",
      paused: false,
    });
  } else {
    bit = await deploy(mockBitArtifact, deployer);
  }
  const gate = await deploy(mockGateArtifact, deployer);
  const registry = await deploy(registryArtifact, deployer, [deployer.address]);
  const risk = Object.freeze({
    maxFeeBps: 500,
    maxPriceDeviationBps: 2_500,
    referenceSatsPerBit: 100,
    epochDuration: 86_400,
    minSettlementWindow: 600,
    minClaimBuffer: 600,
    maxLockDuration: 172_800,
    maxSwapAmount: parseEther("1000"),
    maxEpochVolume: parseEther("10000"),
  });
  const vault = await deploy(vaultArtifact, deployer, [
    await bit.getAddress(), collector.address, await gate.getAddress(), await registry.getAddress(), risk,
  ]);
  const userEscrow = await deploy(userEscrowArtifact, deployer, [
    await bit.getAddress(), collector.address, await gate.getAddress(), await registry.getAddress(), risk,
  ]);
  await send(registry.connect(deployer).registerEscrow(await vault.getAddress()));
  await send(registry.connect(deployer).registerEscrow(await userEscrow.getAddress()));
  await send(registry.connect(deployer).seal());
  if (TOKEN_MODE === "live-bit") {
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
  await send(vault.connect(solver).deposit(parseEther("500")));

  let nonce = 0n;
  async function deadlines() {
    const latest = await rpcBlock(provider, await rpcBlockNumber(provider));
    const now = Number.parseInt(latest.timestamp, 16);
    return {
      quoteExpiresAt: BigInt(now + 600),
      lastSafeClaimAt: BigInt(now + 3_600),
      refundAfter: BigInt(now + 4_200),
    };
  }

  const directions = [
    {
      name: "bit-to-lightning",
      contract: userEscrow,
      async prepare(label) {
        const preimage = id(`treeswap-user-reorg:${label}`);
        const quote = Object.freeze({
          quoteId: id(`treeswap-user-quote:${label}`),
          user: user.address,
          solver: solver.address,
          solverBeneficiary: beneficiary.address,
          amount: AMOUNT,
          fee: FEE,
          lightningAmountSats: LIGHTNING_SATS,
          paymentHash: sha256(preimage),
          invoiceDigest: id(`treeswap-user-invoice:${label}`),
          solverNonce: ++nonce,
          ...await deadlines(),
        });
        const domain = {
          name: "TreeSwap User BIT Escrow",
          version: "1",
          chainId: CHAIN_ID,
          verifyingContract: await userEscrow.getAddress(),
        };
        const signature = await solver.signTypedData(domain, userQuoteTypes, quote);
        return Object.freeze({
          quote,
          preimage,
          intentDigest: (await userEscrow.hashSolverQuote(quote)).toLowerCase(),
          open: () => send(userEscrow.connect(wallet(walletOffset + 1, provider)).open(quote, signature)),
        });
      },
    },
    {
      name: "lightning-to-bit",
      contract: vault,
      async prepare(label) {
        const preimage = id(`treeswap-vault-reorg:${label}`);
        const quote = Object.freeze({
          quoteId: id(`treeswap-vault-quote:${label}`),
          user: user.address,
          solver: solver.address,
          beneficiary: beneficiary.address,
          amount: AMOUNT,
          fee: FEE,
          lightningAmountSats: LIGHTNING_SATS,
          paymentHash: sha256(preimage),
          invoiceDigest: id(`treeswap-vault-invoice:${label}`),
          nonce: ++nonce,
          ...await deadlines(),
        });
        const domain = {
          name: "TreeSwap BIT Vault",
          version: "1",
          chainId: CHAIN_ID,
          verifyingContract: await vault.getAddress(),
        };
        const [userSignature, solverSignature] = await Promise.all([
          user.signTypedData(domain, vaultQuoteTypes, quote),
          solver.signTypedData(domain, vaultQuoteTypes, quote),
        ]);
        return Object.freeze({
          quote,
          preimage,
          intentDigest: (await vault.hashSelectedQuote(quote)).toLowerCase(),
          open: () => send(vault.connect(wallet(walletOffset + 1, provider)).reserve(quote, userSignature, solverSignature)),
        });
      },
    },
  ];

  const cases = [];
  let lightningDispatchesAfterReorg = 0;
  for (const direction of directions) {
    const before = await direction.prepare("before-authorization");
    const beforeSnapshot = await provider.send("evm_snapshot", []);
    const beforeReceipt = await before.open();
    assert.equal(await direction.contract.swapState(before.quote.quoteId), LOCKED);
    assert.equal(await registry.paymentHashUsed(before.quote.paymentHash), true);
    assert.equal(await provider.send("evm_revert", [beforeSnapshot]), true);
    const beforeReplacementHash = await mineReplacementAt(provider, beforeReceipt.blockNumber, beforeReceipt.blockHash);
    assert.equal(await provider.send("eth_getTransactionReceipt", [beforeReceipt.hash]), null);
    assert.equal(await direction.contract.swapState(before.quote.quoteId), UNSET);
    assert.equal(await registry.paymentHashUsed(before.quote.paymentHash), false);
    const beforeDecision = authorizeLightningAction({
      schedule: { lastSafeClaimAt: Number(before.quote.lastSafeClaimAt) },
      chain: chainView({
        receipt: beforeReceipt,
        canonicalBlockHash: beforeReplacementHash,
        intentDigest: before.intentDigest,
        latestBlock: await rpcBlockNumber(provider),
      }),
      service: healthyService,
      nowSeconds: Number(before.quote.quoteExpiresAt) - 300,
      policy,
    });
    assert.equal(beforeDecision.authorized, false);
    assert.match(beforeDecision.reasons.join("; "), /no longer canonical/);

    const afterAuthorization = await direction.prepare("after-authorization");
    const authorizationSnapshot = await provider.send("evm_snapshot", []);
    const authorizationReceipt = await afterAuthorization.open();
    const authorization = issueLightningAuthorization({
      actionId: id(`treeswap-${direction.name}-reorg-authorization`),
      schedule: { lastSafeClaimAt: Number(afterAuthorization.quote.lastSafeClaimAt) },
      chain: chainView({
        receipt: authorizationReceipt,
        canonicalBlockHash: authorizationReceipt.blockHash.toLowerCase(),
        intentDigest: afterAuthorization.intentDigest,
        latestBlock: authorizationReceipt.blockNumber,
      }),
      service: healthyService,
      nowSeconds: Number(afterAuthorization.quote.quoteExpiresAt) - 300,
      policy,
    });
    assert.equal(await provider.send("evm_revert", [authorizationSnapshot]), true);
    const authorizationReplacementHash = await mineReplacementAt(
      provider,
      authorizationReceipt.blockNumber,
      authorizationReceipt.blockHash,
    );
    const dispatchDecision = validateLightningDispatch({
      authorization,
      chain: chainView({
        receipt: authorizationReceipt,
        canonicalBlockHash: authorizationReplacementHash,
        intentDigest: afterAuthorization.intentDigest,
        latestBlock: await rpcBlockNumber(provider),
      }),
      service: healthyService,
      nowSeconds: authorization.authorizedAt + 1,
      policy,
    });
    assert.equal(dispatchDecision.authorized, false);
    assert.match(dispatchDecision.reasons.join("; "), /reorged after authorization/);
    if (dispatchDecision.authorized) lightningDispatchesAfterReorg += 1;
    assert.equal(await direction.contract.swapState(afterAuthorization.quote.quoteId), UNSET);

    const afterClaim = await direction.prepare("after-claim");
    await afterClaim.open();
    const claimSnapshot = await provider.send("evm_snapshot", []);
    const beneficiaryBefore = await bit.balanceOf(beneficiary.address);
    const collectorBefore = await bit.balanceOf(collector.address);
    const claimReceipt = await send(
      direction.contract.connect(wallet(walletOffset, provider)).claim(afterClaim.quote.quoteId, afterClaim.preimage),
    );
    assert.equal(await direction.contract.swapState(afterClaim.quote.quoteId), CLAIMED);
    assert.equal(await bit.balanceOf(beneficiary.address), beneficiaryBefore + AMOUNT - FEE);
    assert.equal(await bit.balanceOf(collector.address), collectorBefore + FEE);
    assert.equal(await provider.send("evm_revert", [claimSnapshot]), true);
    await mineReplacementAt(provider, claimReceipt.blockNumber, claimReceipt.blockHash);
    assert.equal(await provider.send("eth_getTransactionReceipt", [claimReceipt.hash]), null);
    assert.equal(await direction.contract.swapState(afterClaim.quote.quoteId), LOCKED);
    assert.equal(await bit.balanceOf(beneficiary.address), beneficiaryBefore);
    assert.equal(await bit.balanceOf(collector.address), collectorBefore);
    assert.equal(await direction.contract.totalLocked(), AMOUNT);
    await send(direction.contract.connect(wallet(walletOffset, provider)).claim(afterClaim.quote.quoteId, afterClaim.preimage));
    assert.equal(await direction.contract.swapState(afterClaim.quote.quoteId), CLAIMED);
    assert.equal(await bit.balanceOf(beneficiary.address), beneficiaryBefore + AMOUNT - FEE);
    assert.equal(await bit.balanceOf(collector.address), collectorBefore + FEE);
    assert.equal(await direction.contract.totalLocked(), 0n);

    cases.push(Object.freeze({
      direction: direction.name,
      beforeAuthorizationReorg: "AUTHORIZATION_DENIED",
      afterAuthorizationReorg: "DISPATCH_DENIED",
      afterClaimReorg: "LOCKED_THEN_CANONICALLY_CLAIMED_ONCE",
    }));
  }

  const evidence = Object.freeze({
    schema: TOKEN_MODE === "live-bit"
      ? "treeswap.live-bit-escrow-reorg-smoke.v1"
      : "treeswap.escrow-reorg-smoke.v1",
    chainId: String(CHAIN_ID),
    executionClient: ANVIL_VERSION,
    tokenBoundary: TOKEN_MODE === "live-bit" ? "pinned-live-bit-mainnet-fork" : "test-only-mock-bit",
    ...(source ? { source } : {}),
    ...(liveBitEvidence ? { liveBit: liveBitEvidence } : {}),
    actualTreeSwapEscrows: true,
    vaultCodeHash: keccak256(await provider.getCode(await vault.getAddress())).toLowerCase(),
    userEscrowCodeHash: keccak256(await provider.getCode(await userEscrow.getAddress())).toLowerCase(),
    cases: Object.freeze(cases),
    lightningDispatchesAfterReorg,
    orphanedClaimReceiptsAccepted: false,
    canonicalRecoveryPaysBeneficiaryOnce: true,
    publicTestnetIncluded: false,
    fundingAuthorization: false,
  });
  assert.equal(evidence.lightningDispatchesAfterReorg, 0);
  process.stdout.write(`${JSON.stringify({ ...evidence, evidenceDigest: coordinatorCommitmentDigest(evidence) })}\n`);
} finally {
  await provider.destroy();
}
