import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, link, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  readPrivateQualificationArtifact,
  verifyCurrentReleaseQualification,
} from "../lib/local-qualification-verification.mjs";
import { qualificationArtifact } from "./fixtures/verified-qualification-review.mjs";

const SOURCE_COMMIT = "a".repeat(40);

function fixture() {
  const artifact = qualificationArtifact({ sourceCommit: SOURCE_COMMIT, finishedAt: 1_800_000_000 });
  return {
    artifact,
    bytes: Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`),
    hashes: artifact.configurationHashes,
  };
}

test("reconstructs the exact current qualification into a non-authorizing receipt", () => {
  const value = fixture();
  const receipt = verifyCurrentReleaseQualification({
    qualificationFileBytes: value.bytes,
    publishedSourceCommit: SOURCE_COMMIT,
    currentConfigurationHashes: value.hashes,
  });
  assert.equal(receipt.schema, "treeswap.local-qualification-verification-receipt.v1");
  assert.equal(receipt.source.commit, SOURCE_COMMIT);
  assert.equal(receipt.campaignCount, value.artifact.campaigns.length);
  assert.equal(receipt.configurationHashCount, Object.keys(value.hashes).length);
  assert.equal(receipt.qualificationEvidenceDigest, value.artifact.evidenceDigest);
  assert.equal(receipt.productionDurationEvidenceDigest, value.artifact.productionDuration.evidenceDigest);
  assert.match(receipt.receiptDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(receipt.checks.exactCurrentConfigurationManifest, true);
  assert.deepEqual(receipt.authorizations, {
    externalReview: false,
    productionInfrastructure: false,
    publicTestnet: false,
    funding: false,
  });
});

test("rejects source drift, configuration drift, missing files, and artifact mutation", () => {
  const value = fixture();
  const verify = (overrides = {}) => verifyCurrentReleaseQualification({
    qualificationFileBytes: value.bytes,
    publishedSourceCommit: SOURCE_COMMIT,
    currentConfigurationHashes: value.hashes,
    ...overrides,
  });
  assert.throws(() => verify({ publishedSourceCommit: "b".repeat(40) }), /currently published main/);
  const changed = { ...value.hashes, "package.json": `sha256:${"f".repeat(64)}` };
  assert.throws(() => verify({ currentConfigurationHashes: changed }), /package.json/);
  const missing = { ...value.hashes };
  delete missing[Object.keys(missing)[0]];
  assert.throws(() => verify({ currentConfigurationHashes: missing }), /fields are not exact/);
  const mutated = JSON.parse(value.bytes);
  mutated.evidenceDigest = `sha256:${"f".repeat(64)}`;
  assert.throws(() => verify({ qualificationFileBytes: Buffer.from(JSON.stringify(mutated)) }), /digest or content/);
  assert.throws(() => verifyCurrentReleaseQualification({
    qualificationFileBytes: value.bytes,
    publishedSourceCommit: SOURCE_COMMIT,
    currentConfigurationHashes: value.hashes,
    funding: true,
  }), /fields are not exact/);
});

test("reads only one stable private regular artifact", async () => {
  const directory = await mkdtemp(join(tmpdir(), "treeswap-local-qualification-"));
  const value = fixture();
  const artifact = join(directory, "artifact.json");
  const symbolicLink = join(directory, "artifact-link.json");
  const hardLink = join(directory, "artifact-hard-link.json");
  try {
    await writeFile(artifact, value.bytes, { mode: 0o600 });
    assert.deepEqual(await readPrivateQualificationArtifact(artifact), value.bytes);
    await chmod(artifact, 0o644);
    await assert.rejects(readPrivateQualificationArtifact(artifact), /mode-0600/);
    await chmod(artifact, 0o600);
    await symlink(artifact, symbolicLink);
    await assert.rejects(readPrivateQualificationArtifact(symbolicLink), /non-symlink/);
    await link(artifact, hardLink);
    await assert.rejects(readPrivateQualificationArtifact(artifact), /owner-only/);
    await rm(hardLink);
    await writeFile(join(directory, "large.json"), Buffer.alloc(1_000_001), { mode: 0o600 });
    await assert.rejects(readPrivateQualificationArtifact(join(directory, "large.json")), /bounded owner-only/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("operator CLI is exact-main only and exposes no signing or funding surface", async () => {
  const script = await readFile(new URL("../scripts/verify-local-qualification.mjs", import.meta.url), "utf8");
  assert.match(script, /ls-remote.*refs\/heads\/main/s);
  assert.match(script, /status.*--porcelain.*--untracked-files=all/s);
  assert.match(script, /currentPublishedCommit\(\).*currentPublishedCommit\(\)/s);
  assert.doesNotMatch(script, /private.?key|signTypedData|sendTransaction|broadcast|funding\s*:\s*true/i);
  assert.throws(() => execFileSync(process.execPath, [
    "scripts/verify-local-qualification.mjs",
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), /Command failed/);
});
