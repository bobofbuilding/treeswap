import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Interface, Wallet, getAddress, id, keccak256, toUtf8Bytes } from "ethers";
import {
  buildBitIndependentReviewApprovalMessage,
  buildBitIndependentReviewManifestEvidence,
  prepareBitIndependentReviewCandidate,
  verifyBitIndependentReview,
} from "../lib/bit-independent-review.mjs";
import {
  buildBitProviderDeploymentEvidence,
  buildBitProviderEvidenceApprovalMessage,
  prepareBitProviderEvidenceCandidate,
  verifyBitProviderEvidence,
} from "../lib/bit-provider-evidence.mjs";
import {
  BIT_MAINNET_CONTRACT,
  observeBitDeployment,
} from "../lib/bit-deployment-observer.mjs";
import {
  buildReviewedBitDeploymentManifestSummary,
  promoteReviewedBitDeploymentManifest,
} from "../lib/bit-reviewed-manifest.mjs";

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
const PROVIDER_IDENTITIES = [`0x${"11".repeat(32)}`, `0x${"22".repeat(32)}`];
const PROVIDER_WALLETS = [
  new Wallet(`0x${"01".repeat(32)}`),
  new Wallet(`0x${"02".repeat(32)}`),
];
const REVIEWER_WALLETS = [
  new Wallet(`0x${"03".repeat(32)}`),
  new Wallet(`0x${"04".repeat(32)}`),
];

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function reconstructManifest(summary) {
  return {
    schema: "treeswap.reviewed-bit-deployment-manifest.v1",
    status: summary.status,
    scope: summary.scope,
    sourceCommit: summary.sourceCommit,
    chainId: summary.chainId,
    verifyingContract: summary.verifyingContract,
    finalizedBlock: summary.finalizedBlock,
    stateAnchor: summary.stateAnchor,
    proxy: summary.proxy,
    implementation: summary.implementation,
    token: summary.token,
    providerHeads: summary.providerHeads,
    providerEvidence: summary.providerEvidence,
    reviewEvidence: summary.reviewEvidence,
    reviewArtifacts: summary.reviewArtifacts,
    findingCounts: summary.findingCounts,
    reviewers: summary.reviewers,
    promotedAt: summary.promotedAt,
    validUntil: summary.validUntil,
    providerIndependenceStatus: summary.providerIndependenceStatus,
    fundingAuthorization: false,
  };
}

function fixtureRpc() {
  return async (method, params) => {
    if (method === "eth_chainId") return "0x1";
    if (method === "eth_getBlockByNumber") return BLOCK;
    if (method === "eth_getStorageAt") return `0x${"0".repeat(24)}${IMPLEMENTATION.slice(2).toLowerCase()}`;
    if (method === "eth_getCode") {
      return getAddress(params[0]) === BIT_MAINNET_CONTRACT ? "0x6001600055" : "0x6002600055";
    }
    if (method === "eth_call") {
      if (params[0].data === TOKEN_INTERFACE.encodeFunctionData("decimals")) {
        return TOKEN_INTERFACE.encodeFunctionResult("decimals", [18]);
      }
      if (params[0].data === TOKEN_INTERFACE.encodeFunctionData("paused")) {
        return TOKEN_INTERFACE.encodeFunctionResult("paused", [false]);
      }
      if (params[0].data === TOKEN_INTERFACE.encodeFunctionData("symbol")) {
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
    providerApprovers: PROVIDER_IDENTITIES.map((providerIdentity, index) => ({
      providerIdentity,
      organizationId: id(`provider organization ${index}`).toLowerCase(),
      signer: PROVIDER_WALLETS[index].address,
      identityEvidenceDigest: id(`provider identity evidence ${index}`).toLowerCase(),
      serviceEvidenceDigest: id(`provider service evidence ${index}`).toLowerCase(),
    })),
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
        signer: REVIEWER_WALLETS[0].address,
        identityEvidenceDigest: id("contract reviewer identity evidence").toLowerCase(),
      },
      {
        role: "provider-independence-reviewer",
        reviewerIdentity: id("provider independence reviewer identity").toLowerCase(),
        organizationId: id("provider independence reviewer organization").toLowerCase(),
        signer: REVIEWER_WALLETS[1].address,
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

const FINDING_COUNTS = Object.freeze({
  critical: 0,
  high: 0,
  informational: 3,
  low: 2,
  medium: 1,
  open: 0,
});

async function completeBundle(providerPreparedAt = PREPARED_AT) {
  const observations = await Promise.all(PROVIDER_IDENTITIES.map((providerIdentity, index) => (
    observeBitDeployment({
      rpcCall: fixtureRpc(),
      providerLabel: `provider-${index}`,
      providerIdentity,
      sourceCommit: SOURCE_COMMIT,
      observedAt: providerPreparedAt,
    })
  )));
  const providerCandidate = prepareBitProviderEvidenceCandidate({
    observations,
    policy: providerPolicy(),
    preparedAt: providerPreparedAt,
  });
  const providerAttestations = [];
  for (const [index, provider] of providerCandidate.policy.providerApprovers.entries()) {
    const typed = buildBitProviderEvidenceApprovalMessage({
      candidate: providerCandidate,
      providerIdentity: provider.providerIdentity,
    });
    providerAttestations.push({
      providerIdentity: provider.providerIdentity,
      signer: provider.signer,
      signature: await PROVIDER_WALLETS[index].signTypedData(typed.domain, typed.types, typed.value),
    });
  }
  const providerVerifiedAt = new Date(providerPreparedAt.getTime() + 1_000);
  const providerVerification = verifyBitProviderEvidence({
    candidate: providerCandidate,
    attestations: providerAttestations,
    observedAt: providerVerifiedAt,
  });
  const reviewPreparedAt = new Date(providerPreparedAt.getTime() + 2_000);
  const reviewCandidate = prepareBitIndependentReviewCandidate({
    providerVerification,
    policy: reviewPolicy(),
    artifacts: artifacts(),
    findingCounts: FINDING_COUNTS,
    preparedAt: reviewPreparedAt,
  });
  const reviewAttestations = [];
  for (const [index, reviewer] of reviewCandidate.policy.reviewApprovers.entries()) {
    const typed = buildBitIndependentReviewApprovalMessage({
      candidate: reviewCandidate,
      providerVerification,
      role: reviewer.role,
    });
    reviewAttestations.push({
      role: reviewer.role,
      reviewerIdentity: reviewer.reviewerIdentity,
      signer: reviewer.signer,
      signature: await REVIEWER_WALLETS[index].signTypedData(typed.domain, typed.types, typed.value),
    });
  }
  const reviewVerifiedAt = new Date(providerPreparedAt.getTime() + 3_000);
  const reviewVerification = verifyBitIndependentReview({
    candidate: reviewCandidate,
    providerVerification,
    attestations: reviewAttestations,
    observedAt: reviewVerifiedAt,
  });
  return {
    providerCandidate,
    providerAttestations,
    providerVerification,
    reviewCandidate,
    reviewAttestations,
    reviewVerification,
    reviewVerifiedAt,
  };
}

async function fakePublishedGit(directory, {
  head = SOURCE_COMMIT,
  published = head,
  status = "",
} = {}) {
  const bin = join(directory, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "git"), `#!/bin/sh
case "$1:$2:$3" in
  remote:get-url:origin) printf '%s\\n' 'https://github.com/bobofbuilding/treeswap.git' ;;
  branch:--show-current:) printf '%s\\n' 'main' ;;
  rev-parse:HEAD:) printf '%s\\n' "$TREESWAP_TEST_HEAD" ;;
  ls-remote:--exit-code:origin) printf '%s\\trefs/heads/main\\n' "$TREESWAP_TEST_PUBLISHED" ;;
  status:--porcelain:--untracked-files=all) printf '%s' "$TREESWAP_TEST_STATUS" ;;
  *) exit 64 ;;
esac
`, { mode: 0o700 });
  return {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    TREESWAP_TEST_HEAD: head,
    TREESWAP_TEST_PUBLISHED: published,
    TREESWAP_TEST_STATUS: status,
  };
}

test("promotes only live module-private provider and reviewer provenance into an exact manifest", async () => {
  const value = await completeBundle();
  const promotedAt = new Date(value.reviewVerifiedAt.getTime() + 1_000);
  const verification = promoteReviewedBitDeploymentManifest({
    providerVerification: value.providerVerification,
    reviewVerification: value.reviewVerification,
    promotedAt,
    observedAt: promotedAt,
  });
  const summary = buildReviewedBitDeploymentManifestSummary(verification);
  assert.equal(summary.status, "cryptographically-reviewed-bit-deployment");
  assert.equal(summary.scope, "reviewed-mainnet-bit-deployment-no-funding-authorization");
  assert.equal(summary.sourceCommit, SOURCE_COMMIT);
  assert.equal(summary.chainId, 1);
  assert.equal(summary.verifyingContract, BIT_MAINNET_CONTRACT);
  assert.equal(summary.finalizedBlock.number, Number.parseInt(BLOCK.number, 16));
  assert.equal(summary.finalizedBlock.hash, BLOCK.hash);
  assert.equal(summary.implementation.address, IMPLEMENTATION);
  assert.deepEqual(summary.token, { decimals: 18, paused: false, symbol: "BIT" });
  assert.equal(summary.providerHeads.length, 2);
  assert.equal(summary.reviewers.length, 2);
  assert.equal(Object.keys(summary.reviewArtifacts).length, 7);
  assert.deepEqual(summary.findingCounts, FINDING_COUNTS);
  assert.match(summary.manifestDigest, /^0x[0-9a-f]{64}$/);
  assert.equal(
    keccak256(toUtf8Bytes(JSON.stringify(canonical(reconstructManifest(summary))))).toLowerCase(),
    summary.manifestDigest,
  );
  assert.equal(summary.providerIndependenceStatus, "reviewer-attested-requires-retained-evidence-audit");
  assert.equal(summary.fundingAuthorization, false);
  assert.equal(/signature|https?:|wss?:/i.test(JSON.stringify(summary)), false);

  const repeated = promoteReviewedBitDeploymentManifest({
    providerVerification: value.providerVerification,
    reviewVerification: value.reviewVerification,
    promotedAt,
    observedAt: promotedAt,
  });
  assert.equal(repeated.manifestDigest, verification.manifestDigest);
  assert.throws(
    () => buildBitProviderDeploymentEvidence(structuredClone(value.providerVerification)),
    /provenance is invalid/,
  );
  assert.throws(
    () => buildBitIndependentReviewManifestEvidence(structuredClone(value.reviewVerification)),
    /provenance is invalid/,
  );
  assert.throws(
    () => buildReviewedBitDeploymentManifestSummary(structuredClone(verification)),
    /provenance is invalid/,
  );
});

test("rejects cross-bundle substitution and unsafe promotion times", async () => {
  const first = await completeBundle();
  const second = await completeBundle(new Date(PREPARED_AT.getTime() + 10_000));
  const validTime = new Date(second.reviewVerifiedAt.getTime() + 1_000);
  assert.throws(
    () => promoteReviewedBitDeploymentManifest({
      providerVerification: first.providerVerification,
      reviewVerification: second.reviewVerification,
      promotedAt: validTime,
      observedAt: validTime,
    }),
    /provider (?:comparison|evidence record) does not match/,
  );
  assert.throws(
    () => promoteReviewedBitDeploymentManifest({
      providerVerification: first.providerVerification,
      reviewVerification: first.reviewVerification,
      promotedAt: new Date(first.reviewVerifiedAt.getTime() - 1_000),
      observedAt: first.reviewVerifiedAt,
    }),
    /predates verified evidence/,
  );
  assert.throws(
    () => promoteReviewedBitDeploymentManifest({
      providerVerification: first.providerVerification,
      reviewVerification: first.reviewVerification,
      promotedAt: new Date(first.reviewVerifiedAt.getTime() + 61_000),
      observedAt: first.reviewVerifiedAt,
    }),
    /future-dated/,
  );
  const expired = new Date(first.reviewCandidate.record.validUntil * 1_000);
  assert.throws(
    () => promoteReviewedBitDeploymentManifest({
      providerVerification: first.providerVerification,
      reviewVerification: first.reviewVerification,
      promotedAt: expired,
      observedAt: expired,
    }),
    /expired before promotion/,
  );
  assert.throws(
    () => promoteReviewedBitDeploymentManifest({
      providerVerification: first.providerVerification,
      reviewVerification: first.reviewVerification,
      promotedAt: "invalid",
    }),
    /promotion time is invalid/,
  );
  assert.throws(
    () => promoteReviewedBitDeploymentManifest({
      providerVerification: first.providerVerification,
      reviewVerification: first.reviewVerification,
      promotedAt: validTime,
      observedAt: "invalid",
    }),
    /observation time is invalid/,
  );
});

test("guarded promotion CLI reverifies both signature sets and writes private non-overwriting output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "treeswap-reviewed-bit-manifest-"));
  try {
    const bundle = await completeBundle(new Date(Date.now() - 5_000));
    const paths = Object.fromEntries([
      "provider-candidate",
      "provider-attestations",
      "review-candidate",
      "review-attestations",
      "manifest",
    ].map((name) => [name, join(directory, `${name}.json`)]));
    await Promise.all([
      writeFile(paths["provider-candidate"], `${JSON.stringify(bundle.providerCandidate)}\n`, { mode: 0o600 }),
      writeFile(paths["provider-attestations"], `${JSON.stringify(bundle.providerAttestations)}\n`, { mode: 0o600 }),
      writeFile(paths["review-candidate"], `${JSON.stringify(bundle.reviewCandidate)}\n`, { mode: 0o600 }),
      writeFile(paths["review-attestations"], `${JSON.stringify(bundle.reviewAttestations)}\n`, { mode: 0o600 }),
    ]);
    const env = await fakePublishedGit(directory);
    const command = [
      "scripts/promote-bit-reviewed-manifest.mjs",
      "--provider-candidate", paths["provider-candidate"],
      "--provider-attestations", paths["provider-attestations"],
      "--review-candidate", paths["review-candidate"],
      "--review-attestations", paths["review-attestations"],
      "--out", paths.manifest,
    ];
    execFileSync(process.execPath, command, {
      cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"],
    });
    const summary = JSON.parse(await readFile(paths.manifest, "utf8"));
    assert.equal(summary.verifyingContract, BIT_MAINNET_CONTRACT);
    assert.equal(summary.token.symbol, "BIT");
    assert.equal(summary.fundingAuthorization, false);
    assert.equal((await stat(paths.manifest)).mode & 0o777, 0o600);

    const overwrite = spawnSync(process.execPath, command, {
      cwd: process.cwd(), env, encoding: "utf8",
    });
    assert.notEqual(overwrite.status, 0);
    assert.match(overwrite.stderr, /already exists/);

    const duplicate = spawnSync(process.execPath, [
      ...command.slice(0, -2),
      "--review-attestations", paths["review-attestations"],
      "--out", join(directory, "duplicate.json"),
    ], { cwd: process.cwd(), env, encoding: "utf8" });
    assert.notEqual(duplicate.status, 0);
    assert.match(duplicate.stderr, /Usage:/);

    const drifted = spawnSync(process.execPath, [
      ...command.slice(0, -1), join(directory, "drifted.json"),
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...env, TREESWAP_TEST_HEAD: "b".repeat(40), TREESWAP_TEST_PUBLISHED: "b".repeat(40) },
    });
    assert.notEqual(drifted.status, 0);
    assert.match(drifted.stderr, /does not match the exact clean commit published/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
