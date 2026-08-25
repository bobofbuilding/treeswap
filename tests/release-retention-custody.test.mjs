import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { id, Wallet } from "ethers";
import { CoordinatorStore } from "../lib/coordinator-store.mjs";
import {
  assessRetainedReleaseRotation,
  inspectRetainedReleaseCustody,
} from "../lib/release-retention-custody.mjs";

const NOW = 2_100_000_000;
const execFileAsync = promisify(execFile);
const witnessOne = new Wallet(`0x${"b1".repeat(32)}`);
const witnessTwo = new Wallet(`0x${"b2".repeat(32)}`);

function hash(label) {
  return id(label).toLowerCase();
}

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function fileReference(path, root) {
  const bytes = await readFile(path);
  return {
    path: path.slice(root.length + 1),
    sha256: sha256(bytes),
    sizeBytes: (await stat(path)).size,
  };
}

function witnessPolicy() {
  return {
    maximumDrillAgeSeconds: 86_400,
    maximumDrillDurationSeconds: 3_600,
    minimumWitnesses: 2,
    witnesses: [
      {
        operatorId: hash("retention witness one"),
        organizationId: hash("retention witness organization one"),
        signer: witnessOne.address,
      },
      {
        operatorId: hash("retention witness two"),
        organizationId: hash("retention witness organization two"),
        signer: witnessTwo.address,
      },
    ].sort((left, right) => left.operatorId.localeCompare(right.operatorId)),
  };
}

async function emptyCustodyPackage(t, { withUnboundSettlement = false } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "treeswap-retained-release-")));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const databasePath = join(root, "coordinator.sqlite");
  const backupPath = join(root, "coordinator.backup.sqlite");
  const store = await CoordinatorStore.open(databasePath);
  if (withUnboundSettlement) {
    store.acceptSettlement({
      settlementId: hash("unbound settlement"),
      pricingId: hash("unbound pricing"),
      direction: "bit-to-lightning",
      nonceAuthorityDigest: hash("unbound nonce authority"),
      intentNonce: "1",
      intentDigest: hash("unbound intent"),
      paymentHash: hash("unbound payment"),
      invoiceDigest: hash("unbound invoice"),
      amountSats: "1000",
      quoteReceiptDigest: hash("unbound quote receipt"),
      selectedSetDigest: hash("unbound selected set"),
      selectedOfferId: hash("unbound selected offer"),
      capacityEpoch: 1,
      createdAt: NOW,
    });
  }
  await store.createVerifiedBackup(backupPath);
  store.close();
  const manifest = {
    schema: "treeswap.retained-release-custody.v1",
    coordinatorSchema: "treeswap.coordinator.v8",
    createdAt: NOW,
    sealedHostInstanceId: hash("sealed host"),
    sealedProcessInstanceId: hash("sealed process"),
    coordinatorBackup: await fileReference(backupPath, root),
    witnessPolicy: witnessPolicy(),
    releases: [],
  };
  const manifestPath = join(root, "custody.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  await chmod(manifestPath, 0o600);
  return { root, backupPath, databasePath, manifest, manifestPath };
}

test("permits routine rotation only when the verified backup has zero nonterminal liabilities", async (t) => {
  const { databasePath, manifestPath } = await emptyCustodyPackage(t);
  const custody = await inspectRetainedReleaseCustody({ manifestPath });
  assert.equal(custody.status, "all-nonterminal-release-recovery-inputs-retained");
  assert.equal(custody.totalNonterminalSettlementCount, 0);
  assert.equal(custody.releaseCount, 0);
  assert.deepEqual(custody.authorizations, {
    funding: false,
    lightningDispatch: false,
    newExposure: false,
  });
  const liveStore = await CoordinatorStore.open(databasePath);
  try {
    const decision = assessRetainedReleaseRotation({
      oldCustodyVerification: custody,
      liveStore,
      changeKind: "service-runtime",
      now: NOW + 1,
    });
    assert.equal(decision.rotationPermitted, true);
    assert.equal(decision.status, "rotation-permitted-zero-nonterminal-liabilities");
    assert.deepEqual(decision.authorizations, custody.authorizations);
    assert.throws(() => assessRetainedReleaseRotation({
      oldCustodyVerification: structuredClone(custody),
      liveStore,
      changeKind: "service-runtime",
      now: NOW + 1,
    }), /provenance/);
    liveStore.releaseLiabilitySnapshot = () => ({ ...custody });
    assert.throws(() => assessRetainedReleaseRotation({
      oldCustodyVerification: custody,
      liveStore,
      changeKind: "service-runtime",
      now: NOW + 1,
    }), /unmodified liability inspection/);
    delete liveStore.releaseLiabilitySnapshot;
    liveStore.acceptSettlement({
      settlementId: hash("post-seal settlement"),
      pricingId: hash("post-seal pricing"),
      direction: "bit-to-lightning",
      nonceAuthorityDigest: hash("post-seal nonce authority"),
      intentNonce: "2",
      intentDigest: hash("post-seal intent"),
      paymentHash: hash("post-seal payment"),
      invoiceDigest: hash("post-seal invoice"),
      amountSats: "1000",
      quoteReceiptDigest: hash("post-seal quote receipt"),
      selectedSetDigest: hash("post-seal selected set"),
      selectedOfferId: hash("post-seal selected offer"),
      capacityEpoch: 1,
      createdAt: NOW + 1,
    });
    assert.throws(() => assessRetainedReleaseRotation({
      oldCustodyVerification: custody,
      liveStore,
      changeKind: "service-runtime",
      now: NOW + 2,
    }), /liabilities changed after.*backup/);
  } finally {
    liveStore.close();
  }
});

test("refuses custody when any nonterminal settlement has no durable release binding", async (t) => {
  const { manifestPath } = await emptyCustodyPackage(t, { withUnboundSettlement: true });
  await assert.rejects(
    inspectRetainedReleaseCustody({ manifestPath }),
    /cannot cover unbound nonterminal settlements/,
  );
});

test("operator CLI writes only a private non-authorizing custody summary", async (t) => {
  const { root, manifestPath } = await emptyCustodyPackage(t);
  const outputPath = join(root, "custody-summary.json");
  const { stdout } = await execFileAsync(process.execPath, [
    "scripts/verify-retained-release-custody.mjs",
    "--inputs",
    manifestPath,
    "--out",
    outputPath,
  ], { cwd: process.cwd() });
  const output = JSON.parse(stdout);
  assert.equal(output.status, "all-nonterminal-release-recovery-inputs-retained");
  assert.equal(output.rotationAuthorization, false);
  assert.equal(output.lightningDispatchAuthorization, false);
  assert.equal(output.newExposureAuthorization, false);
  assert.equal(output.fundingAuthorization, false);
  assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
  await assert.rejects(execFileAsync(process.execPath, [
    "scripts/verify-retained-release-custody.mjs",
    "--inputs",
    manifestPath,
    "--out",
    outputPath,
  ], { cwd: process.cwd() }), /already exists/);
});

test("rejects backup mutation, permissive files, and manifest field smuggling", async (t) => {
  await t.test("backup mutation", async (subtest) => {
    const { backupPath, manifestPath } = await emptyCustodyPackage(subtest);
    await writeFile(backupPath, "mutation", { flag: "a" });
    await assert.rejects(inspectRetainedReleaseCustody({ manifestPath }), /size does not match/);
  });
  await t.test("permissive backup", async (subtest) => {
    const { backupPath, manifestPath } = await emptyCustodyPackage(subtest);
    await chmod(backupPath, 0o644);
    await assert.rejects(inspectRetainedReleaseCustody({ manifestPath }), /private regular file/);
  });
  await t.test("extra manifest field", async (subtest) => {
    const { manifest, manifestPath } = await emptyCustodyPackage(subtest);
    await writeFile(manifestPath, `${JSON.stringify({ ...manifest, funding: true })}\n`, { mode: 0o600 });
    await assert.rejects(inspectRetainedReleaseCustody({ manifestPath }), /fields are not exact/);
  });
});
