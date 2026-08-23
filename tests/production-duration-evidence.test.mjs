import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  buildProductionDurationEvidence,
  productionDurationEvidencePolicy,
  verifyProductionDurationEvidence,
} from "../lib/production-duration-evidence.mjs";

const sourceCommit = "a".repeat(40);

function input(overrides = {}) {
  return {
    sourceCommit,
    startedAtEpochSeconds: 1_787_155_200,
    finishedAtEpochSeconds: 1_787_158_801,
    maximumObservationGapSeconds: 31,
    monotonicElapsedSeconds: 3601,
    observationCount: 119,
    restartElapsedSeconds: 1806,
    ...overrides,
  };
}

test("builds and verifies deterministic uncompressed production-duration evidence", () => {
  const first = buildProductionDurationEvidence(input());
  const second = buildProductionDurationEvidence(input());
  assert.deepEqual(first, second);
  assert.equal(first.schema, "treeswap.production-duration-evidence.v1");
  assert.equal(first.measurements.wallElapsedSeconds, 3601);
  assert.equal(first.measurements.monotonicElapsedSeconds, 3601);
  assert.equal(first.measurements.maximumObservationGapSeconds, 31);
  assert.equal(first.controls.guardIntervalBlockAdvances, 0);
  assert.equal(first.controls.targetPaymentDispatches, 0);
  assert.match(first.evidenceDigest, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(verifyProductionDurationEvidence(first, { expectedSourceCommit: sourceCommit }), first);
});

test("rejects compressed, discontinuous, late-restart, divergent-clock, and mutated evidence", () => {
  assert.throws(
    () => buildProductionDurationEvidence(input({ finishedAtEpochSeconds: 1_787_158_800, monotonicElapsedSeconds: 3600 })),
    /required uncompressed interval/,
  );
  assert.throws(() => buildProductionDurationEvidence(input({ observationCount: 109 })), /observation count/);
  assert.throws(() => buildProductionDurationEvidence(input({ maximumObservationGapSeconds: 46 })), /cadence/);
  assert.throws(() => buildProductionDurationEvidence(input({ restartElapsedSeconds: 1861 })), /midpoint window/);
  assert.throws(
    () => buildProductionDurationEvidence(input({ finishedAtEpochSeconds: 1_787_158_807 })),
    /clocks diverged/,
  );

  const evidence = buildProductionDurationEvidence(input());
  assert.throws(
    () => verifyProductionDurationEvidence(evidence, { expectedSourceCommit: "b".repeat(40) }),
    /source does not match/,
  );
  assert.throws(
    () => verifyProductionDurationEvidence({
      ...evidence,
      controls: { ...evidence.controls, targetPaymentDispatches: 1 },
    }, { expectedSourceCommit: sourceCommit }),
    /did not fail closed/,
  );
  assert.throws(
    () => verifyProductionDurationEvidence({ ...evidence, evidenceDigest: `sha256:${"0".repeat(64)}` }),
    /digest or content/,
  );
  assert.equal(productionDurationEvidencePolicy.minimumElapsedSeconds, 3601);
  assert.equal(productionDurationEvidencePolicy.minimumObservations, 110);
});

test("writer creates one private non-overwriting record", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "treeswap-production-duration-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await chmod(directory, 0o700);
  const output = join(directory, "production-duration-0123456789abcdef0123456789abcdef.json");
  const script = resolve("scripts/write-production-duration-evidence.mjs");
  const args = [
    script,
    "--output", output,
    "--source-commit", sourceCommit,
    "--started-at-epoch-seconds", String(input().startedAtEpochSeconds),
    "--finished-at-epoch-seconds", String(input().finishedAtEpochSeconds),
    "--maximum-observation-gap-seconds", String(input().maximumObservationGapSeconds),
    "--monotonic-elapsed-seconds", String(input().monotonicElapsedSeconds),
    "--observation-count", String(input().observationCount),
    "--restart-elapsed-seconds", String(input().restartElapsedSeconds),
  ];
  const result = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const state = await lstat(output);
  assert.equal(state.isFile(), true);
  assert.equal(state.mode & 0o777, 0o600);
  const evidence = JSON.parse(await readFile(output, "utf8"));
  assert.deepEqual(verifyProductionDurationEvidence(evidence, { expectedSourceCommit: sourceCommit }), evidence);

  const overwrite = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.notEqual(overwrite.status, 0);
  assert.deepEqual(JSON.parse(await readFile(output, "utf8")), evidence);

  await chmod(directory, 0o755);
  const unsafeOutput = join(directory, "production-duration-fedcba9876543210fedcba9876543210.json");
  const unsafeArgs = [...args];
  unsafeArgs[2] = unsafeOutput;
  const unsafeParent = spawnSync(process.execPath, unsafeArgs, { encoding: "utf8" });
  assert.notEqual(unsafeParent.status, 0);
  await assert.rejects(() => lstat(unsafeOutput), { code: "ENOENT" });
});

test("the qualification runner binds and removes the companion only after fail-closed checks", async () => {
  const [lab, runner, plan] = await Promise.all([
    readFile(new URL("../infra/regtest/lab.sh", import.meta.url), "utf8"),
    readFile(new URL("../scripts/run-local-qualification.mjs", import.meta.url), "utf8"),
    readFile(new URL("../lib/qualification-plan.mjs", import.meta.url), "utf8"),
  ]);
  const start = lab.indexOf("smoke_production_duration_chain_delay() {");
  const end = lab.indexOf("\nsmoke_stale_chain_header() {", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const campaign = lab.slice(start, end);
  const zeroDispatch = campaign.indexOf("if (( payment_count != 0 ))");
  const noPaymentProof = campaign.indexOf("assert_adapter_payment_not_found", zeroDispatch);
  const writer = campaign.indexOf("write-production-duration-evidence.mjs");
  assert.ok(zeroDispatch > 0 && noPaymentProof > zeroDispatch && writer > noPaymentProof);
  assert.match(runner, /TREESWAP_PRODUCTION_DURATION_EVIDENCE_PATH: productionDurationCompanionPath/);
  assert.match(runner, /verifyProductionDurationEvidence\(parsed, \{ expectedSourceCommit \}\)/);
  assert.match(runner, /await unlink\(productionDurationCompanionPath\)/);
  assert.match(runner, /RELEASE_QUALIFICATION_CONFIGURATION_FILES/);
  assert.match(plan, /"lib\/qualification-evidence\.mjs"/);
  assert.match(plan, /"lib\/production-duration-evidence\.mjs"/);
  assert.match(plan, /"scripts\/write-production-duration-evidence\.mjs"/);
});
