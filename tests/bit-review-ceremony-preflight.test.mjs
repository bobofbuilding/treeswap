import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Wallet, id, keccak256, toUtf8Bytes } from "ethers";
import { BIT_MAINNET_CONTRACT } from "../lib/bit-deployment-observer.mjs";
import { preflightBitReviewCeremony } from "../lib/bit-independent-review.mjs";

const SOURCE_COMMIT = "a".repeat(40);
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

function valueDigest(value) {
  return keccak256(toUtf8Bytes(JSON.stringify(canonical(value)))).toLowerCase();
}

function providerPolicy() {
  return {
    schema: "treeswap.bit-provider-evidence-policy.v1",
    chainId: 1,
    verifyingContract: BIT_MAINNET_CONTRACT,
    sourceCommit: SOURCE_COMMIT,
    maximumEvidenceLifetimeSeconds: 1_800,
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
    findingsDispositionDigest: id("findings disposition").toLowerCase(),
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

function fixture() {
  return {
    providerPolicy: providerPolicy(),
    reviewPolicy: reviewPolicy(),
    artifacts: artifacts(),
    findingCounts: findingCounts(),
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

test("preflights every static BIT provider and reviewer input before live capture", () => {
  const preflight = preflightBitReviewCeremony(fixture());
  const { preflightDigest, ...body } = preflight;
  assert.equal(preflight.schema, "treeswap.bit-review-ceremony-preflight.v1");
  assert.equal(preflight.status, "static-inputs-valid");
  assert.equal(preflight.sourceCommit, SOURCE_COMMIT);
  assert.equal(preflight.chainId, 1);
  assert.equal(preflight.verifyingContract, BIT_MAINNET_CONTRACT);
  assert.equal(preflight.providerCount, 2);
  assert.equal(preflight.reviewerCount, 2);
  assert.equal(preflight.reviewArtifactCount, 7);
  assert.equal(preflight.effectiveMaximumReviewLifetimeSeconds, 1_800);
  assert.deepEqual(preflight.findingCounts, findingCounts());
  assert.equal(preflightDigest, valueDigest(body));
  assert.equal(preflight.liveEvidenceIncluded, false);
  assert.equal(preflight.externalIndependenceVerified, false);
  assert.equal(preflight.fundingAuthorization, false);
  assert.equal(Object.isFrozen(preflight), true);
  assert.equal(Object.isFrozen(preflight.findingCounts), true);
  const serialized = JSON.stringify(preflight);
  assert.equal(PROVIDER_WALLETS.some((wallet) => serialized.includes(wallet.address)), false);
  assert.equal(REVIEWER_WALLETS.some((wallet) => serialized.includes(wallet.address)), false);
  assert.equal(/signature|https?:|wss?:|private.?key|api.?key/i.test(serialized), false);
  assert.deepEqual(preflightBitReviewCeremony(fixture()), preflight);
});

test("rejects cross-policy mismatch, insufficient time, unsafe findings, and unknown fields", () => {
  const mismatchedSource = fixture();
  mismatchedSource.reviewPolicy.sourceCommit = "b".repeat(40);
  assert.throws(() => preflightBitReviewCeremony(mismatchedSource), /policies do not match/);

  const shortProviderWindow = fixture();
  shortProviderWindow.providerPolicy.maximumEvidenceLifetimeSeconds = 299;
  assert.throws(() => preflightBitReviewCeremony(shortProviderWindow), /minimum independent-review lifetime/);

  for (const field of ["critical", "high", "open"]) {
    const unsafeFindings = fixture();
    unsafeFindings.findingCounts[field] = 1;
    assert.throws(() => preflightBitReviewCeremony(unsafeFindings), /critical, high, or open findings/);
  }

  const unknownProviderField = fixture();
  unknownProviderField.providerPolicy.rpcUrl = "https://secret.invalid";
  assert.throws(() => preflightBitReviewCeremony(unknownProviderField), /fields are not exact/);

  const repeatedArtifact = fixture();
  repeatedArtifact.artifacts.proxySourceBundleDigest = repeatedArtifact.artifacts.compilerInputDigest;
  assert.throws(() => preflightBitReviewCeremony(repeatedArtifact), /artifact digests must be distinct/);
});

test("rejects every provider, reviewer, organization, signer, and artifact control overlap", () => {
  const reusedSigner = fixture();
  reusedSigner.reviewPolicy.reviewApprovers[0].signer = reusedSigner.providerPolicy.providerApprovers[0].signer;
  assert.throws(() => preflightBitReviewCeremony(reusedSigner), /may not reuse a provider signer/);

  const reusedOrganization = fixture();
  reusedOrganization.reviewPolicy.reviewApprovers[0].organizationId = (
    reusedOrganization.providerPolicy.providerApprovers[0].organizationId
  );
  assert.throws(() => preflightBitReviewCeremony(reusedOrganization), /may not reuse a provider organization/);

  const reusedIdentity = fixture();
  reusedIdentity.reviewPolicy.reviewApprovers[0].reviewerIdentity = (
    reusedIdentity.providerPolicy.providerApprovers[0].providerIdentity
  );
  assert.throws(() => preflightBitReviewCeremony(reusedIdentity), /globally distinct/);

  const artifactProviderOverlap = fixture();
  artifactProviderOverlap.artifacts.compilerInputDigest = (
    artifactProviderOverlap.providerPolicy.providerApprovers[0].serviceEvidenceDigest
  );
  assert.throws(() => preflightBitReviewCeremony(artifactProviderOverlap), /globally distinct/);

  const artifactReviewerOverlap = fixture();
  artifactReviewerOverlap.artifacts.compilerInputDigest = (
    artifactReviewerOverlap.reviewPolicy.reviewApprovers[0].identityEvidenceDigest
  );
  assert.throws(() => preflightBitReviewCeremony(artifactReviewerOverlap), /globally distinct/);
});

test("guarded preflight CLI binds clean published main and writes private non-overwriting output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "treeswap-bit-ceremony-preflight-"));
  try {
    const input = fixture();
    const paths = {
      providerPolicy: join(directory, "provider-policy.json"),
      reviewPolicy: join(directory, "review-policy.json"),
      artifacts: join(directory, "artifacts.json"),
      findings: join(directory, "findings.json"),
      output: join(directory, "preflight.json"),
    };
    await Promise.all([
      writeFile(paths.providerPolicy, `${JSON.stringify(input.providerPolicy)}\n`, { mode: 0o600 }),
      writeFile(paths.reviewPolicy, `${JSON.stringify(input.reviewPolicy)}\n`, { mode: 0o600 }),
      writeFile(paths.artifacts, `${JSON.stringify(input.artifacts)}\n`, { mode: 0o600 }),
      writeFile(paths.findings, `${JSON.stringify(input.findingCounts)}\n`, { mode: 0o600 }),
    ]);
    const env = await fakePublishedGit(directory);
    const command = [
      "scripts/preflight-bit-review-ceremony.mjs",
      "--provider-policy", paths.providerPolicy,
      "--review-policy", paths.reviewPolicy,
      "--artifacts", paths.artifacts,
      "--findings", paths.findings,
      "--out", paths.output,
    ];
    execFileSync(process.execPath, command, { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
    const written = JSON.parse(await readFile(paths.output, "utf8"));
    assert.equal(written.preflightDigest, preflightBitReviewCeremony(input).preflightDigest);
    assert.equal((await stat(paths.output)).mode & 0o777, 0o600);

    const overwrite = spawnSync(process.execPath, command, { cwd: process.cwd(), env, encoding: "utf8" });
    assert.notEqual(overwrite.status, 0);
    assert.match(overwrite.stderr, /already exists/);

    const duplicate = spawnSync(process.execPath, [
      ...command.slice(0, -2),
      "--findings", paths.findings,
      "--out", join(directory, "duplicate.json"),
    ], { cwd: process.cwd(), env, encoding: "utf8" });
    assert.notEqual(duplicate.status, 0);
    assert.match(duplicate.stderr, /Usage:/);

    const drifted = spawnSync(process.execPath, [
      ...command.slice(0, -1), join(directory, "drifted.json"),
    ], {
      cwd: process.cwd(),
      env: { ...env, TREESWAP_TEST_HEAD: "b".repeat(40), TREESWAP_TEST_PUBLISHED: "b".repeat(40) },
      encoding: "utf8",
    });
    assert.notEqual(drifted.status, 0);
    assert.match(drifted.stderr, /does not match the exact clean commit published/);

    const symlinkPath = join(directory, "provider-policy-link.json");
    await symlink(paths.providerPolicy, symlinkPath);
    const linked = spawnSync(process.execPath, [
      ...command.slice(0, -10),
      "--provider-policy", symlinkPath,
      ...command.slice(3, -2),
      "--out", join(directory, "linked.json"),
    ], { cwd: process.cwd(), env, encoding: "utf8" });
    assert.notEqual(linked.status, 0);
    assert.match(linked.stderr, /regular file|symlink/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
