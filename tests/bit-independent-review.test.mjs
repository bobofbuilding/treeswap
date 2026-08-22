import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Interface, Wallet, getAddress, id } from "ethers";
import {
  buildBitIndependentReviewApprovalMessage,
  buildBitIndependentReviewSummary,
  normalizeBitIndependentReviewCandidate,
  prepareBitIndependentReviewCandidate,
  verifyBitIndependentReview,
} from "../lib/bit-independent-review.mjs";
import {
  buildBitProviderEvidenceApprovalMessage,
  prepareBitProviderEvidenceCandidate,
  verifyBitProviderEvidence,
} from "../lib/bit-provider-evidence.mjs";
import {
  BIT_MAINNET_CONTRACT,
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
const PROVIDER_WALLET_A = new Wallet(`0x${"01".repeat(32)}`);
const PROVIDER_WALLET_B = new Wallet(`0x${"02".repeat(32)}`);
const CONTRACT_REVIEWER = new Wallet(`0x${"03".repeat(32)}`);
const INDEPENDENCE_REVIEWER = new Wallet(`0x${"04".repeat(32)}`);

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

function providerPolicy() {
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
        signer: PROVIDER_WALLET_A.address,
        identityEvidenceDigest: id("provider identity evidence a").toLowerCase(),
        serviceEvidenceDigest: id("provider service evidence a").toLowerCase(),
      },
      {
        providerIdentity: PROVIDER_B,
        organizationId: id("provider organization b").toLowerCase(),
        signer: PROVIDER_WALLET_B.address,
        identityEvidenceDigest: id("provider identity evidence b").toLowerCase(),
        serviceEvidenceDigest: id("provider service evidence b").toLowerCase(),
      },
    ],
  };
}

function reviewPolicy() {
  return {
    schema: "treeswap.bit-independent-review-policy.v1",
    chainId: 1,
    verifyingContract: BIT_MAINNET_CONTRACT,
    sourceCommit: SOURCE_COMMIT,
    maximumReviewLifetimeSeconds: 3_600,
    reviewApprovers: [
      {
        role: "contract-security-reviewer",
        reviewerIdentity: id("contract reviewer identity").toLowerCase(),
        organizationId: id("contract reviewer organization").toLowerCase(),
        signer: CONTRACT_REVIEWER.address,
        identityEvidenceDigest: id("contract reviewer identity evidence").toLowerCase(),
      },
      {
        role: "provider-independence-reviewer",
        reviewerIdentity: id("provider independence reviewer identity").toLowerCase(),
        organizationId: id("provider independence reviewer organization").toLowerCase(),
        signer: INDEPENDENCE_REVIEWER.address,
        identityEvidenceDigest: id("provider independence reviewer identity evidence").toLowerCase(),
      },
    ],
  };
}

function artifacts() {
  return {
    compilerInputDigest: id("compiler input").toLowerCase(),
    findingsDispositionDigest: id("finding disposition").toLowerCase(),
    implementationSourceBundleDigest: id("implementation source bundle").toLowerCase(),
    providerIndependenceReportDigest: id("provider independence report").toLowerCase(),
    proxySourceBundleDigest: id("proxy source bundle").toLowerCase(),
    rolesAndStorageReportDigest: id("roles and storage report").toLowerCase(),
    upgradeBehaviorReportDigest: id("upgrade behavior report").toLowerCase(),
  };
}

function findingCounts() {
  return { critical: 0, high: 0, informational: 3, low: 2, medium: 1, open: 0 };
}

async function providerBundle(preparedAt = PREPARED_AT) {
  const observations = await Promise.all([
    observeBitDeployment({
      rpcCall: fixtureRpc(),
      providerLabel: "provider-a",
      providerIdentity: PROVIDER_A,
      sourceCommit: SOURCE_COMMIT,
      observedAt: preparedAt,
    }),
    observeBitDeployment({
      rpcCall: fixtureRpc(),
      providerLabel: "provider-b",
      providerIdentity: PROVIDER_B,
      sourceCommit: SOURCE_COMMIT,
      observedAt: preparedAt,
    }),
  ]);
  const candidate = prepareBitProviderEvidenceCandidate({
    observations,
    policy: providerPolicy(),
    preparedAt,
  });
  const attestations = [];
  for (const [index, provider] of candidate.policy.providerApprovers.entries()) {
    const typed = buildBitProviderEvidenceApprovalMessage({
      candidate,
      providerIdentity: provider.providerIdentity,
    });
    const wallet = [PROVIDER_WALLET_A, PROVIDER_WALLET_B][index];
    attestations.push({
      providerIdentity: provider.providerIdentity,
      signer: provider.signer,
      signature: await wallet.signTypedData(typed.domain, typed.types, typed.value),
    });
  }
  const observedAt = new Date(preparedAt.getTime() + 1_000);
  return {
    candidate,
    attestations,
    verification: verifyBitProviderEvidence({ candidate, attestations, observedAt }),
  };
}

async function reviewBundle({ preparedAt = new Date(PREPARED_AT.getTime() + 2_000), policy } = {}) {
  const provider = await providerBundle();
  const candidate = prepareBitIndependentReviewCandidate({
    providerVerification: provider.verification,
    policy: policy ?? reviewPolicy(),
    artifacts: artifacts(),
    findingCounts: findingCounts(),
    preparedAt,
  });
  const attestations = [];
  for (const [index, reviewer] of candidate.policy.reviewApprovers.entries()) {
    const typed = buildBitIndependentReviewApprovalMessage({
      candidate,
      providerVerification: provider.verification,
      role: reviewer.role,
    });
    const wallet = [CONTRACT_REVIEWER, INDEPENDENCE_REVIEWER][index];
    attestations.push({
      role: reviewer.role,
      reviewerIdentity: reviewer.reviewerIdentity,
      signer: reviewer.signer,
      signature: await wallet.signTypedData(typed.domain, typed.types, typed.value),
    });
  }
  return { provider, candidate, attestations };
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

test("binds two independent reviewer signatures to exact live provider evidence and review artifacts", async () => {
  const value = await reviewBundle();
  const verification = verifyBitIndependentReview({
    candidate: value.candidate,
    providerVerification: value.provider.verification,
    attestations: value.attestations,
    observedAt: new Date(PREPARED_AT.getTime() + 30_000),
  });
  const summary = buildBitIndependentReviewSummary(verification);
  assert.equal(summary.status, "cryptographically-verified-independent-review");
  assert.equal(summary.reviewerCount, 2);
  assert.equal(summary.sourceCommit, SOURCE_COMMIT);
  assert.equal(summary.finalizedBlockHash, BLOCK.hash);
  assert.deepEqual(summary.findingCounts, findingCounts());
  assert.equal(summary.providerIndependenceStatus, "reviewer-attested-requires-retained-evidence-audit");
  assert.equal(summary.fundingAuthorization, false);
  assert.equal(JSON.stringify(summary).includes("signature"), false);
  assert.throws(
    () => buildBitIndependentReviewSummary(structuredClone(verification)),
    /provenance is invalid/,
  );
});

test("rejects substituted provider evidence, review artifacts, findings, source, and funding status", async () => {
  const value = await reviewBundle();
  const mutations = [
    [(candidate) => { candidate.extra = true; }, /fields are not exact/],
    [(candidate) => { candidate.artifacts.compilerInputDigest = id("replacement").toLowerCase(); }, /artifacts do not match/],
    [(candidate) => { candidate.artifacts.compilerInputDigest = candidate.artifacts.proxySourceBundleDigest; }, /artifact digests must be distinct/],
    [(candidate) => { candidate.findingCounts.open = 1; }, /may not retain critical, high, or open/],
    [(candidate) => { candidate.record.providerEvidenceRecordDigest = id("replacement").toLowerCase(); }, /verified provider evidence/],
    [(candidate) => { candidate.record.finalizedBlockHash = id("replacement block").toLowerCase(); }, /verified provider evidence/],
    [(candidate) => { candidate.record.fundingAuthorization = true; }, /may not authorize funding/],
    [(candidate) => { candidate.policy.sourceCommit = "b".repeat(40); }, /record does not match policy/],
    [(candidate) => { candidate.policy.reviewApprovers[0].signer = candidate.policy.reviewApprovers[0].signer.toLowerCase(); }, /not canonical/],
  ];
  for (const [mutate, expected] of mutations) {
    const candidate = structuredClone(value.candidate);
    mutate(candidate);
    if (String(expected).includes("verified provider evidence")) {
      assert.throws(
        () => buildBitIndependentReviewApprovalMessage({
          candidate,
          providerVerification: value.provider.verification,
          role: "contract-security-reviewer",
        }),
        expected,
      );
    } else {
      assert.throws(() => normalizeBitIndependentReviewCandidate(candidate), expected);
    }
  }
});

test("rejects reviewer multiplicity that reuses provider or reviewer control", async () => {
  const mutations = [
    [(policy) => { policy.reviewApprovers[1].signer = policy.reviewApprovers[0].signer; }, /reviewer signers must be distinct/],
    [(policy) => { policy.reviewApprovers[1].organizationId = policy.reviewApprovers[0].organizationId; }, /organization commitments must be distinct/],
    [(policy) => { policy.reviewApprovers.reverse(); }, /canonically ordered/],
    [(policy) => { policy.maximumReviewLifetimeSeconds = 3_601; }, /may not exceed one hour/],
    [(policy) => { policy.maximumReviewLifetimeSeconds = 299; }, /at least five minutes/],
    [(policy) => { policy.reviewApprovers[0].signer = PROVIDER_WALLET_A.address; }, /may not reuse a provider signer/],
    [(policy) => { policy.reviewApprovers[0].organizationId = providerPolicy().providerApprovers[0].organizationId; }, /may not reuse a provider organization/],
    [(policy) => { policy.reviewApprovers[0].reviewerIdentity = PROVIDER_A; }, /globally distinct/],
    [(policy) => { policy.reviewApprovers[0].identityEvidenceDigest = artifacts().compilerInputDigest; }, /provider, reviewer, and artifact commitments/],
  ];
  for (const [mutate, expected] of mutations) {
    const policy = reviewPolicy();
    mutate(policy);
    await assert.rejects(() => reviewBundle({ policy }), expected);
  }
});

test("requires live module-private provider verification and causal remaining lifetime", async () => {
  const provider = await providerBundle();
  assert.throws(
    () => prepareBitIndependentReviewCandidate({
      providerVerification: structuredClone(provider.verification),
      policy: reviewPolicy(),
      artifacts: artifacts(),
      findingCounts: findingCounts(),
      preparedAt: new Date(PREPARED_AT.getTime() + 2_000),
    }),
    /provenance is invalid/,
  );
  assert.throws(
    () => prepareBitIndependentReviewCandidate({
      providerVerification: provider.verification,
      policy: reviewPolicy(),
      artifacts: artifacts(),
      findingCounts: findingCounts(),
      preparedAt: PREPARED_AT,
    }),
    /insufficient remaining lifetime/,
  );
  assert.throws(
    () => prepareBitIndependentReviewCandidate({
      providerVerification: provider.verification,
      policy: reviewPolicy(),
      artifacts: artifacts(),
      findingCounts: findingCounts(),
      preparedAt: new Date(provider.candidate.record.validUntil * 1_000),
    }),
    /insufficient remaining lifetime/,
  );
  assert.throws(
    () => prepareBitIndependentReviewCandidate({
      providerVerification: provider.verification,
      policy: reviewPolicy(),
      artifacts: artifacts(),
      findingCounts: findingCounts(),
      preparedAt: new Date((provider.candidate.record.validUntil - 299) * 1_000),
    }),
    /insufficient remaining lifetime/,
  );
});

test("rejects missing, substituted, replayed, expired, and future reviewer attestations", async () => {
  const value = await reviewBundle();
  assert.throws(
    () => verifyBitIndependentReview({
      candidate: value.candidate,
      providerVerification: value.provider.verification,
      attestations: value.attestations.slice(0, 1),
      observedAt: PREPARED_AT,
    }),
    /every BIT independent reviewer/,
  );
  const duplicated = [value.attestations[0], { ...value.attestations[0] }];
  assert.throws(
    () => verifyBitIndependentReview({
      candidate: value.candidate,
      providerVerification: value.provider.verification,
      attestations: duplicated,
      observedAt: PREPARED_AT,
    }),
    /canonically ordered|distinct/,
  );
  const substituted = structuredClone(value.attestations);
  substituted[0].signature = substituted[1].signature;
  assert.throws(
    () => verifyBitIndependentReview({
      candidate: value.candidate,
      providerVerification: value.provider.verification,
      attestations: substituted,
      observedAt: PREPARED_AT,
    }),
    /signature is invalid/,
  );
  assert.throws(
    () => verifyBitIndependentReview({
      candidate: value.candidate,
      providerVerification: value.provider.verification,
      attestations: value.attestations,
      observedAt: new Date(value.candidate.record.validUntil * 1_000),
    }),
    /expired/,
  );
  assert.throws(
    () => verifyBitIndependentReview({
      candidate: value.candidate,
      providerVerification: value.provider.verification,
      attestations: value.attestations,
      observedAt: new Date((value.candidate.record.preparedAt - 61) * 1_000),
    }),
    /future-dated/,
  );
});

test("guarded CLIs reverify provider provenance and write private non-overwriting evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "treeswap-bit-independent-review-"));
  try {
    const now = new Date();
    const provider = await providerBundle(now);
    const paths = Object.fromEntries([
      "provider-candidate",
      "provider-attestations",
      "policy",
      "artifacts",
      "findings",
      "review-candidate",
      "review-attestations",
      "summary",
    ].map((name) => [name, join(directory, `${name}.json`)]));
    await Promise.all([
      writeFile(paths["provider-candidate"], `${JSON.stringify(provider.candidate)}\n`, { mode: 0o600 }),
      writeFile(paths["provider-attestations"], `${JSON.stringify(provider.attestations)}\n`, { mode: 0o600 }),
      writeFile(paths.policy, `${JSON.stringify(reviewPolicy())}\n`, { mode: 0o600 }),
      writeFile(paths.artifacts, `${JSON.stringify(artifacts())}\n`, { mode: 0o600 }),
      writeFile(paths.findings, `${JSON.stringify(findingCounts())}\n`, { mode: 0o600 }),
    ]);
    const env = await fakePublishedGit(directory);
    execFileSync(process.execPath, [
      "scripts/prepare-bit-independent-review.mjs",
      "--provider-candidate", paths["provider-candidate"],
      "--provider-attestations", paths["provider-attestations"],
      "--policy", paths.policy,
      "--artifacts", paths.artifacts,
      "--findings", paths.findings,
      "--out", paths["review-candidate"],
    ], { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
    const candidate = JSON.parse(await readFile(paths["review-candidate"], "utf8"));
    assert.equal(candidate.record.fundingAuthorization, false);
    assert.equal((await stat(paths["review-candidate"])).mode & 0o777, 0o600);

    const payload = execFileSync(process.execPath, [
      "scripts/prepare-bit-independent-review-attestation.mjs",
      "--candidate", paths["review-candidate"],
      "--provider-candidate", paths["provider-candidate"],
      "--provider-attestations", paths["provider-attestations"],
      "--role", "contract-security-reviewer",
    ], { cwd: process.cwd(), env, encoding: "utf8" });
    assert.equal(
      JSON.parse(payload).scope,
      "bit-independent-review-attestation-only-no-signing-or-funding-authorization",
    );

    const providerVerification = verifyBitProviderEvidence({
      candidate: provider.candidate,
      attestations: provider.attestations,
      observedAt: new Date(),
    });
    const reviewAttestations = [];
    for (const [index, reviewer] of candidate.policy.reviewApprovers.entries()) {
      const typed = buildBitIndependentReviewApprovalMessage({
        candidate,
        providerVerification,
        role: reviewer.role,
      });
      const wallet = [CONTRACT_REVIEWER, INDEPENDENCE_REVIEWER][index];
      reviewAttestations.push({
        role: reviewer.role,
        reviewerIdentity: reviewer.reviewerIdentity,
        signer: reviewer.signer,
        signature: await wallet.signTypedData(typed.domain, typed.types, typed.value),
      });
    }
    await writeFile(paths["review-attestations"], `${JSON.stringify(reviewAttestations)}\n`, { mode: 0o600 });
    execFileSync(process.execPath, [
      "scripts/verify-bit-independent-review.mjs",
      "--candidate", paths["review-candidate"],
      "--provider-candidate", paths["provider-candidate"],
      "--provider-attestations", paths["provider-attestations"],
      "--attestations", paths["review-attestations"],
      "--out", paths.summary,
    ], { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
    const summary = JSON.parse(await readFile(paths.summary, "utf8"));
    assert.equal(summary.status, "cryptographically-verified-independent-review");
    assert.equal(summary.fundingAuthorization, false);
    assert.equal((await stat(paths.summary)).mode & 0o777, 0o600);

    const overwrite = spawnSync(process.execPath, [
      "scripts/verify-bit-independent-review.mjs",
      "--candidate", paths["review-candidate"],
      "--provider-candidate", paths["provider-candidate"],
      "--provider-attestations", paths["provider-attestations"],
      "--attestations", paths["review-attestations"],
      "--out", paths.summary,
    ], { cwd: process.cwd(), env, encoding: "utf8" });
    assert.notEqual(overwrite.status, 0);

    const duplicateControl = spawnSync(process.execPath, [
      "scripts/prepare-bit-independent-review-attestation.mjs",
      "--candidate", paths["review-candidate"],
      "--candidate", paths["review-candidate"],
      "--provider-attestations", paths["provider-attestations"],
      "--role", "contract-security-reviewer",
    ], { cwd: process.cwd(), env, encoding: "utf8" });
    assert.notEqual(duplicateControl.status, 0);
    assert.match(duplicateControl.stderr, /Usage:/);

    const staleSource = spawnSync(process.execPath, [
      "scripts/prepare-bit-independent-review-attestation.mjs",
      "--candidate", paths["review-candidate"],
      "--provider-candidate", paths["provider-candidate"],
      "--provider-attestations", paths["provider-attestations"],
      "--role", "contract-security-reviewer",
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
