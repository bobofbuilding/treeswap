import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Interface, Wallet, getAddress, id } from "ethers";
import {
  buildBitProviderEvidenceApprovalMessage,
  buildBitProviderEvidenceSummary,
  normalizeBitProviderEvidenceCandidate,
  prepareBitProviderEvidenceCandidate,
  verifyBitProviderEvidence,
} from "../lib/bit-provider-evidence.mjs";
import {
  BIT_MAINNET_CONTRACT,
  EIP1967_IMPLEMENTATION_SLOT,
  observeBitDeployment,
} from "../lib/bit-deployment-observer.mjs";

const TOKEN_INTERFACE = new Interface([
  "function decimals() view returns (uint8)",
  "function paused() view returns (bool)",
  "function symbol() view returns (string)",
]);
const IMPLEMENTATION = getAddress("0x1111111111111111111111111111111111111111");
const BLOCK = {
  number: "0x1234",
  hash: `0x${"ab".repeat(32)}`,
  timestamp: "0x68a81c00",
};
const SOURCE_COMMIT = "a".repeat(40);
const PREPARED_AT = new Date("2026-08-22T12:00:00.000Z");
const PROVIDER_A = `0x${"11".repeat(32)}`;
const PROVIDER_B = `0x${"22".repeat(32)}`;
const WALLET_A = new Wallet(`0x${"01".repeat(32)}`);
const WALLET_B = new Wallet(`0x${"02".repeat(32)}`);

function fixtureRpc() {
  return async (method, params) => {
    if (method === "eth_chainId") return "0x1";
    if (method === "eth_getBlockByNumber") return BLOCK;
    if (method === "eth_getStorageAt") return `0x${"0".repeat(24)}${IMPLEMENTATION.slice(2).toLowerCase()}`;
    if (method === "eth_getCode") {
      return getAddress(params[0]) === BIT_MAINNET_CONTRACT ? "0x6001600055" : "0x6002600055";
    }
    if (method === "eth_call") {
      const selector = params[0].data;
      if (selector === TOKEN_INTERFACE.encodeFunctionData("decimals")) {
        return TOKEN_INTERFACE.encodeFunctionResult("decimals", [18]);
      }
      if (selector === TOKEN_INTERFACE.encodeFunctionData("paused")) {
        return TOKEN_INTERFACE.encodeFunctionResult("paused", [false]);
      }
      if (selector === TOKEN_INTERFACE.encodeFunctionData("symbol")) {
        return TOKEN_INTERFACE.encodeFunctionResult("symbol", ["BIT"]);
      }
    }
    throw new Error(`unexpected RPC method: ${method}`);
  };
}

async function observations(observedAt = PREPARED_AT) {
  return Promise.all([
    observeBitDeployment({
      rpcCall: fixtureRpc(),
      providerLabel: "provider-a",
      providerIdentity: PROVIDER_A,
      sourceCommit: SOURCE_COMMIT,
      observedAt,
    }),
    observeBitDeployment({
      rpcCall: fixtureRpc(),
      providerLabel: "provider-b",
      providerIdentity: PROVIDER_B,
      sourceCommit: SOURCE_COMMIT,
      observedAt,
    }),
  ]);
}

function policy() {
  return {
    schema: "treeswap.bit-provider-evidence-policy.v1",
    chainId: 1,
    verifyingContract: BIT_MAINNET_CONTRACT,
    sourceCommit: SOURCE_COMMIT,
    maximumEvidenceLifetimeSeconds: 3_600,
    providerApprovers: [
      {
        providerIdentity: PROVIDER_A,
        organizationId: id("provider organization a").toLowerCase(),
        signer: WALLET_A.address,
        identityEvidenceDigest: id("provider identity evidence a").toLowerCase(),
        serviceEvidenceDigest: id("provider service evidence a").toLowerCase(),
      },
      {
        providerIdentity: PROVIDER_B,
        organizationId: id("provider organization b").toLowerCase(),
        signer: WALLET_B.address,
        identityEvidenceDigest: id("provider identity evidence b").toLowerCase(),
        serviceEvidenceDigest: id("provider service evidence b").toLowerCase(),
      },
    ],
  };
}

async function candidate(overrides = {}) {
  return prepareBitProviderEvidenceCandidate({
    observations: overrides.observations ?? await observations(),
    policy: overrides.policy ?? policy(),
    preparedAt: overrides.preparedAt ?? PREPARED_AT,
  });
}

async function attestations(value, wallets = [WALLET_A, WALLET_B]) {
  const results = [];
  for (const [index, provider] of value.policy.providerApprovers.entries()) {
    const typed = buildBitProviderEvidenceApprovalMessage({
      candidate: value,
      providerIdentity: provider.providerIdentity,
    });
    results.push({
      providerIdentity: provider.providerIdentity,
      signer: provider.signer,
      signature: await wallets[index].signTypedData(typed.domain, typed.types, typed.value),
    });
  }
  return results;
}

async function fakePublishedGit(directory, {
  branch = "main",
  head = SOURCE_COMMIT,
  origin = "https://github.com/bobofbuilding/treeswap.git",
  published = head,
  status = "",
} = {}) {
  const bin = join(directory, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "git"), `#!/bin/sh
case "$1:$2:$3" in
  remote:get-url:origin) printf '%s\\n' "$TREESWAP_TEST_ORIGIN" ;;
  branch:--show-current:) printf '%s\\n' "$TREESWAP_TEST_BRANCH" ;;
  rev-parse:HEAD:) printf '%s\\n' "$TREESWAP_TEST_HEAD" ;;
  ls-remote:--exit-code:origin) printf '%s\\trefs/heads/main\\n' "$TREESWAP_TEST_PUBLISHED" ;;
  status:--porcelain:--untracked-files=all) printf '%s' "$TREESWAP_TEST_STATUS" ;;
  *) exit 64 ;;
esac
`, { mode: 0o700 });
  return {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    TREESWAP_TEST_BRANCH: branch,
    TREESWAP_TEST_HEAD: head,
    TREESWAP_TEST_ORIGIN: origin,
    TREESWAP_TEST_PUBLISHED: published,
    TREESWAP_TEST_STATUS: status,
  };
}

test("requires two accountable provider signatures over one exact non-authorizing comparison", async () => {
  const value = await candidate();
  const verification = verifyBitProviderEvidence({
    candidate: value,
    attestations: await attestations(value),
    observedAt: new Date(PREPARED_AT.getTime() + 30_000),
  });
  const summary = buildBitProviderEvidenceSummary(verification);

  assert.equal(summary.status, "cryptographically-verified-provider-comparison");
  assert.equal(summary.providerCount, 2);
  assert.equal(summary.sourceCommit, SOURCE_COMMIT);
  assert.equal(summary.finalizedBlockNumber, 0x1234);
  assert.equal(summary.finalizedBlockHash, BLOCK.hash);
  assert.equal(summary.independenceStatus, "requires-external-organizational-verification");
  assert.equal(summary.fundingAuthorization, false);
  assert.equal(JSON.stringify(summary).includes("signature"), false);
  assert.equal(JSON.stringify(summary).includes(WALLET_A.privateKey), false);
  assert.throws(() => buildBitProviderEvidenceSummary(structuredClone(verification)), /provenance is invalid/);
});

test("binds the raw observations, exact comparison, block, source, policy, and closed funding status", async () => {
  const base = await candidate();
  const mutations = [
    [(value) => { value.extra = true; }, /fields are not exact/],
    [(value) => { value.comparison.observations[0].observationDigest = id("substituted").toLowerCase(); }, /comparison does not match/],
    [(value) => { value.observations[0].proxy.codeHash = id("substituted proxy").toLowerCase(); }, /comparison does not match|signed record/],
    [(value) => { value.record.comparisonDigest = id("substituted comparison").toLowerCase(); }, /comparison does not match the signed record/],
    [(value) => { value.record.finalizedBlockHash = id("substituted block").toLowerCase(); }, /comparison does not match the signed record/],
    [(value) => { value.record.fundingAuthorization = true; }, /may not authorize funding/],
    [(value) => { value.policy.sourceCommit = "b".repeat(40); }, /record does not match policy|policy source commit/],
    [(value) => { value.policy.verifyingContract = getAddress("0x3333333333333333333333333333333333333333"); }, /wrong verifying contract/],
    [(value) => { value.policy.providerApprovers[0].signer = value.policy.providerApprovers[0].signer.toLowerCase(); }, /not canonical/],
  ];
  for (const [mutate, expected] of mutations) {
    const value = structuredClone(base);
    mutate(value);
    assert.throws(() => normalizeBitProviderEvidenceCandidate(value), expected);
  }
});

test("rejects cosmetic provider multiplicity and weak evidence lifetimes", async () => {
  const base = policy();
  const mutations = [
    [(value) => { value.providerApprovers[1].signer = value.providerApprovers[0].signer; }, /signers must be distinct/],
    [(value) => { value.providerApprovers[1].organizationId = value.providerApprovers[0].organizationId; }, /organization commitments must be distinct/],
    [(value) => { value.providerApprovers[1].identityEvidenceDigest = value.providerApprovers[0].identityEvidenceDigest; }, /identity evidence must be distinct/],
    [(value) => { value.providerApprovers[1].serviceEvidenceDigest = value.providerApprovers[0].serviceEvidenceDigest; }, /service evidence must be distinct/],
    [(value) => { value.providerApprovers[1].serviceEvidenceDigest = value.providerApprovers[0].organizationId; }, /globally distinct/],
    [(value) => { value.providerApprovers[0].signer = `0x${"00".repeat(20)}`; }, /signer must be nonzero/],
    [(value) => { value.maximumEvidenceLifetimeSeconds = 3_601; }, /may not exceed one hour/],
    [(value) => { value.providerApprovers.reverse(); }, /canonically ordered/],
  ];
  for (const [mutate, expected] of mutations) {
    const value = structuredClone(base);
    mutate(value);
    await assert.rejects(() => candidate({ policy: value }), expected);
  }
});

test("rejects missing, duplicated, substituted, replayed, stale, and future attestations", async () => {
  const value = await candidate();
  const signed = await attestations(value);
  assert.throws(
    () => verifyBitProviderEvidence({ candidate: value, attestations: signed.slice(0, 1), observedAt: PREPARED_AT }),
    /every BIT provider approver/,
  );
  const duplicated = [signed[0], { ...signed[0] }];
  assert.throws(
    () => verifyBitProviderEvidence({ candidate: value, attestations: duplicated, observedAt: PREPARED_AT }),
    /canonically ordered|distinct/,
  );
  const wrongSignatures = await attestations(value, [WALLET_B, WALLET_A]);
  assert.throws(
    () => verifyBitProviderEvidence({ candidate: value, attestations: wrongSignatures, observedAt: PREPARED_AT }),
    /signature is invalid/,
  );
  const changed = await candidate({ preparedAt: new Date(PREPARED_AT.getTime() + 1_000) });
  assert.throws(
    () => verifyBitProviderEvidence({ candidate: changed, attestations: signed, observedAt: changed.comparison.comparedAt }),
    /signature is invalid/,
  );
  assert.throws(
    () => verifyBitProviderEvidence({
      candidate: value,
      attestations: signed,
      observedAt: new Date(value.record.validUntil * 1_000),
    }),
    /expired/,
  );
  assert.throws(
    () => verifyBitProviderEvidence({
      candidate: value,
      attestations: signed,
      observedAt: new Date((value.record.preparedAt - 61) * 1_000),
    }),
    /future-dated/,
  );
});

test("guarded CLIs produce private non-overwriting candidate and verified summary files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "treeswap-bit-provider-evidence-"));
  try {
    const [left, right] = await observations(new Date());
    const currentPolicy = policy();
    const policyPath = join(directory, "policy.json");
    const leftPath = join(directory, "left.json");
    const rightPath = join(directory, "right.json");
    const candidatePath = join(directory, "candidate.json");
    const attestationsPath = join(directory, "attestations.json");
    const summaryPath = join(directory, "summary.json");
    await Promise.all([
      writeFile(policyPath, `${JSON.stringify(currentPolicy)}\n`, { mode: 0o600 }),
      writeFile(leftPath, `${JSON.stringify(left)}\n`, { mode: 0o600 }),
      writeFile(rightPath, `${JSON.stringify(right)}\n`, { mode: 0o600 }),
    ]);
    const env = await fakePublishedGit(directory);
    execFileSync(process.execPath, [
      "scripts/prepare-bit-provider-evidence.mjs",
      "--policy",
      policyPath,
      leftPath,
      rightPath,
      "--out",
      candidatePath,
    ], { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
    const prepared = JSON.parse(await readFile(candidatePath, "utf8"));
    assert.equal(prepared.record.fundingAuthorization, false);
    assert.equal((await stat(candidatePath)).mode & 0o777, 0o600);

    const payload = execFileSync(process.execPath, [
      "scripts/prepare-bit-provider-attestation.mjs",
      "--candidate",
      candidatePath,
      "--provider-identity",
      PROVIDER_A,
    ], { cwd: process.cwd(), env, encoding: "utf8" });
    assert.equal(JSON.parse(payload).scope, "bit-provider-comparison-attestation-only-no-signing-or-funding-authorization");

    await writeFile(attestationsPath, `${JSON.stringify(await attestations(prepared))}\n`, { mode: 0o600 });
    execFileSync(process.execPath, [
      "scripts/verify-bit-provider-evidence.mjs",
      "--candidate",
      candidatePath,
      "--attestations",
      attestationsPath,
      "--out",
      summaryPath,
    ], { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
    const summary = JSON.parse(await readFile(summaryPath, "utf8"));
    assert.equal(summary.status, "cryptographically-verified-provider-comparison");
    assert.equal(summary.fundingAuthorization, false);
    assert.equal((await stat(summaryPath)).mode & 0o777, 0o600);

    const overwrite = spawnSync(process.execPath, [
      "scripts/verify-bit-provider-evidence.mjs",
      "--candidate",
      candidatePath,
      "--attestations",
      attestationsPath,
      "--out",
      summaryPath,
    ], { cwd: process.cwd(), env, encoding: "utf8" });
    assert.notEqual(overwrite.status, 0);

    const ambiguousPolicy = spawnSync(process.execPath, [
      "scripts/prepare-bit-provider-evidence.mjs",
      "--policy",
      policyPath,
      "--policy",
      policyPath,
      leftPath,
      rightPath,
    ], { cwd: process.cwd(), env, encoding: "utf8" });
    assert.notEqual(ambiguousPolicy.status, 0);
    assert.match(ambiguousPolicy.stderr, /Usage:/);

    const staleSource = spawnSync(process.execPath, [
      "scripts/prepare-bit-provider-attestation.mjs",
      "--candidate",
      candidatePath,
      "--provider-identity",
      PROVIDER_A,
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...env, TREESWAP_TEST_HEAD: "b".repeat(40), TREESWAP_TEST_PUBLISHED: "b".repeat(40) },
    });
    assert.notEqual(staleSource.status, 0);
    assert.match(staleSource.stderr, /does not match the exact clean commit published/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("candidate retains the exact BIT proxy implementation-slot boundary", async () => {
  const value = await candidate();
  assert.equal(value.observations[0].proxy.address, BIT_MAINNET_CONTRACT);
  assert.equal(value.observations[0].proxy.implementationSlot, EIP1967_IMPLEMENTATION_SLOT);
});
