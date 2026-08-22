import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  assertQualificationEvidenceIsSecretFree,
  buildQualificationEvidence,
  hashQualificationFile,
} from "../lib/qualification-evidence.mjs";
import {
  TREESWAP_CANONICAL_ORIGIN,
  assertTreeSwapCanonicalOrigin,
  parsePublishedMainReference,
  validatePublishedMainSource,
} from "../lib/published-source.mjs";

function input() {
  return {
    branch: "main",
    sourceCommit: "a".repeat(40),
    startedAt: "2026-08-19T16:00:00.000Z",
    finishedAt: "2026-08-19T16:01:00.000Z",
    runtimeVersions: { node: "v22.22.0", docker: "28.0.0", dockerCompose: "2.30.0", forge: "forge 1.4.0" },
    pinnedImages: [
      `bitcoin/bitcoin:31.1@sha256:${"1".repeat(64)}`,
      `lightninglabs/lnd:v0.21.2-beta@sha256:${"2".repeat(64)}`,
      `node:22.22.0-alpine@sha256:${"3".repeat(64)}`,
    ],
    configurationHashes: {
      "infra/regtest/compose.yml": `sha256:${"4".repeat(64)}`,
      "infra/coordinator/Dockerfile": `sha256:${"5".repeat(64)}`,
    },
    campaigns: [{ name: "lightning:invoice-faults", status: "passed" }],
  };
}

test("builds one deterministic secret-free qualification record", () => {
  const first = buildQualificationEvidence(input());
  const second = buildQualificationEvidence(input());
  assert.deepEqual(first, second);
  assert.match(first.evidenceDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(first.source.clean, true);
  assert.equal(first.source.published, true);
  assert.equal(first.privacy.commandOutputIncluded, false);
  assert.equal(first.limitations.publicTestnetIncluded, false);
  assert.equal(assertQualificationEvidenceIsSecretFree(first), true);
  assert.equal(hashQualificationFile(Buffer.from("exact config")), "sha256:e51a29cdb4a0e7193635ae370ec012104a0682936579e459c1d8fde3586e9c73");
});

test("rejects failed campaigns, mutable images, and secret-bearing fields", () => {
  assert.throws(() => buildQualificationEvidence({
    ...input(),
    campaigns: [{ name: "lightning:invoice-faults", status: "failed" }],
  }), /must have a safe name and pass/);
  assert.throws(() => buildQualificationEvidence({
    ...input(),
    pinnedImages: ["bitcoin/bitcoin:latest"],
  }), /immutable image digests/);
  assert.throws(() => assertQualificationEvidenceIsSecretFree({ privateKey: "not-recorded" }), /forbidden field/);
  assert.throws(() => assertQualificationEvidenceIsSecretFree({ note: "lnbcrt1thisisasecretinvoicepayload" }), /secret material/);
  assert.throws(() => buildQualificationEvidence({
    ...input(),
    configurationHashes: { "../outside config": `sha256:${"4".repeat(64)}` },
  }), /configuration hash entry is invalid/);
});

test("requires the exact clean commit currently published at the canonical TreeSwap origin", () => {
  const commit = "a".repeat(40);
  assert.equal(assertTreeSwapCanonicalOrigin(TREESWAP_CANONICAL_ORIGIN), TREESWAP_CANONICAL_ORIGIN);
  assert.equal(
    assertTreeSwapCanonicalOrigin("https://github.com/bobofbuilding/treeswap"),
    TREESWAP_CANONICAL_ORIGIN,
  );
  assert.equal(parsePublishedMainReference(`${commit}\trefs/heads/main`), commit);
  assert.equal(validatePublishedMainSource({
    branch: "main",
    head: commit,
    originUrl: TREESWAP_CANONICAL_ORIGIN,
    published: commit,
    status: "",
  }), commit);

  for (const mutation of [
    { branch: "feature" },
    { head: "b".repeat(40) },
    { originUrl: "git@github.com:bobofbuilding/treeswap.git" },
    { originUrl: "https://github.com/bobofbuilding/treeswap/" },
    { originUrl: "https://token@github.com/bobofbuilding/treeswap.git" },
    { published: "b".repeat(40) },
    { status: "?? untracked" },
  ]) {
    assert.throws(() => validatePublishedMainSource({
      branch: "main",
      head: commit,
      originUrl: TREESWAP_CANONICAL_ORIGIN,
      published: commit,
      status: "",
      ...mutation,
    }), /canonical TreeSwap|exact clean commit/);
  }
  assert.throws(
    () => parsePublishedMainReference(`${commit}\trefs/heads/main\n${"b".repeat(40)}\trefs/heads/other`),
    /one exact remote main reference/,
  );
  assert.throws(() => validatePublishedMainSource({
    branch: "main",
    head: commit,
    originUrl: TREESWAP_CANONICAL_ORIGIN,
    published: commit,
    status: "",
    ignored: true,
  }), /fields are not exact/);
});

test("isolates disposable stale-chain state from the main payer volume", async () => {
  const lab = await readFile(new URL("../infra/regtest/lab.sh", import.meta.url), "utf8");
  const start = lab.indexOf("smoke_stale_chain_header() {");
  const end = lab.indexOf("\nsmoke_unsynced_chain_catchup() {", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const campaign = lab.slice(start, end);
  assert.match(campaign, /ADAPTER_JOURNAL_PATH=\/tmp\/stale-actions\.jsonl/);
  assert.match(campaign, /CHAIN_PROGRESS_PATH=\/tmp\/stale-chain-progress\.json/);
});

test("binds credentialed live-BIT reorg evidence to exact published main", async () => {
  const [runner, deadlineRunner, campaign, verifier] = await Promise.all([
    readFile(new URL("../scripts/run-live-bit-reorg-smoke.sh", import.meta.url), "utf8"),
    readFile(new URL("../scripts/run-live-bit-cross-chain-deadline-smoke.sh", import.meta.url), "utf8"),
    readFile(new URL("../infra/evm/escrow-reorg-smoke.mjs", import.meta.url), "utf8"),
    readFile(new URL("../scripts/verify-published-main.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(runner, /node scripts\/verify-published-main\.mjs/);
  assert.match(deadlineRunner, /node scripts\/verify-published-main\.mjs/);
  assert.doesNotMatch(runner, /git rev-parse origin\/main/);
  assert.doesNotMatch(deadlineRunner, /git rev-parse origin\/main/);
  assert.match(verifier, /remote.*get-url.*origin/s);
  assert.match(verifier, /ls-remote.*refs\/heads\/main/s);
  assert.match(verifier, /status.*--porcelain.*--untracked-files=all/s);
  assert.match(runner, /--fork-block-number 25788856/);
  assert.match(campaign, /live-BIT reorg evidence requires a clean source tree/);
  assert.match(campaign, /live-BIT reorg evidence requires exact published main/);
  assert.match(campaign, /return Object\.freeze\(\{ branch, commit, clean: true, published: true \}\)/);
});
