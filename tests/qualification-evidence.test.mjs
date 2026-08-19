import assert from "node:assert/strict";
import test from "node:test";
import {
  assertQualificationEvidenceIsSecretFree,
  buildQualificationEvidence,
  hashQualificationFile,
} from "../lib/qualification-evidence.mjs";

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
});
