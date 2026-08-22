import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { id } from "ethers";
import { CoordinatorStore, coordinatorCommitmentDigest } from "../lib/coordinator-store.mjs";

const NOW = 2_000_000_000;
const SEND_PAYMENT = "/routerrpc.Router/SendPaymentV2";
const SETTLE_INVOICE = "/invoicesrpc.Invoices/SettleInvoice";
const CANCEL_INVOICE = "/invoicesrpc.Invoices/CancelInvoice";

function hash(label) {
  return id(label).toLowerCase();
}

function settlement(label = "one", overrides = {}) {
  return {
    settlementId: hash(`${label}:settlement`),
    pricingId: hash(`${label}:pricing`),
    direction: "bit-to-lightning",
    nonceAuthorityDigest: hash(`${label}:nonce-authority`),
    intentNonce: "7",
    intentDigest: hash(`${label}:intent`),
    paymentHash: hash(`${label}:payment`),
    invoiceDigest: hash(`${label}:invoice`),
    amountSats: "10000",
    quoteReceiptDigest: hash(`${label}:quote-receipt`),
    selectedSetDigest: hash(`${label}:selected-set`),
    selectedOfferId: hash(`${label}:selected-offer`),
    capacityEpoch: 9,
    createdAt: NOW,
    ...overrides,
  };
}

function reservation(value, overrides = {}) {
  return {
    settlementId: value.settlementId,
    reservationId: hash(`${value.settlementId}:reservation`),
    reservationTxHash: hash(`${value.settlementId}:transaction`),
    reservationBlockNumber: 20_000_000,
    reservationBlockHash: hash(`${value.settlementId}:block`),
    reservationIntentDigest: value.intentDigest,
    observedAt: NOW + 10,
    ...overrides,
  };
}

function action(value, label = "send", overrides = {}) {
  return {
    actionId: hash(`${value.settlementId}:${label}:action`),
    settlementId: value.settlementId,
    method: SEND_PAYMENT,
    requestId: hash(`${value.settlementId}:${label}:request`),
    payloadDigest: hash(`${value.settlementId}:${label}:payload`),
    intentDigest: value.intentDigest,
    paymentHash: value.paymentHash,
    invoiceDigest: value.invoiceDigest,
    amountSats: value.amountSats,
    capacityEpoch: value.capacityEpoch,
    plannedAt: NOW + 20,
    ...overrides,
  };
}

test("atomically binds one private settlement to its nonce, payment hash, quote receipt, and selected set", async () => {
  const store = await CoordinatorStore.open(":memory:", { allowMemory: true });
  const value = settlement();
  try {
    const accepted = store.acceptSettlement(value);
    assert.equal(accepted.state, "INTENT_ACCEPTED");
    assert.equal(accepted.intentNonce, value.intentNonce);
    assert.equal(accepted.paymentHash, value.paymentHash);
    assert.equal(accepted.quoteReceiptDigest, value.quoteReceiptDigest);
    assert.equal(accepted.selectedSetDigest, value.selectedSetDigest);
    assert.equal(accepted.capacityEpoch, value.capacityEpoch);
    assert.equal(store.acceptSettlement(value).version, accepted.version);
    assert.throws(() => store.acceptSettlement({ ...value, amountSats: "10001" }), /different terms/);

    const collision = settlement("collision", { paymentHash: value.paymentHash });
    assert.throws(() => store.acceptSettlement(collision), /existing nonce, intent, or payment hash/);
    assert.deepEqual(store.metrics(), {
      settlementStates: { INTENT_ACCEPTED: 1 },
      actionStates: {},
      evmTransactionStates: {},
      reconciliationRequired: 0,
    });
    assert.equal(store.secretFreeEvents().length, 1);
  } finally {
    store.close();
  }
});

test("persists reservation and outbox action before exactly one dispatch, then permits only one terminal outcome", async () => {
  const store = await CoordinatorStore.open(":memory:", { allowMemory: true });
  const value = settlement("successful");
  try {
    store.acceptSettlement(value);
    assert.throws(() => store.planAction(action(value)), /observed reservation/);
    const observed = store.recordReservation(reservation(value));
    assert.equal(observed.state, "RESERVATION_OBSERVED");
    assert.equal(observed.reservationId, reservation(value).reservationId);
    assert.equal(store.recordReservation(reservation(value)).version, observed.version);

    const planned = store.planAction(action(value));
    assert.equal(planned.state, "PENDING");
    assert.equal(planned.dispatchCount, 0);
    const claimed = store.claimAction(planned.actionId, NOW + 21);
    assert.equal(claimed.state, "DISPATCHING");
    assert.equal(claimed.dispatchCount, 1);
    assert.throws(() => store.claimAction(planned.actionId, NOW + 22), /not dispatchable/);

    const result = store.recordActionResult({
      actionId: planned.actionId,
      outcome: "confirmed",
      resultDigest: hash("successful:payment-result"),
      resultCode: "SUCCEEDED",
      recordedAt: NOW + 30,
    });
    assert.equal(result.state, "CONFIRMED");
    assert.throws(() => store.recordActionResult({
      actionId: planned.actionId,
      outcome: "confirmed",
      resultDigest: hash("successful:payment-result"),
      resultCode: "SUCCEEDED",
      recordedAt: NOW + 30,
      invoice: "lnbc-smuggled",
    }), /fields are not exact/);
    assert.equal(store.recordActionResult({
      actionId: planned.actionId,
      outcome: "confirmed",
      resultDigest: hash("successful:payment-result"),
      resultCode: "SUCCEEDED",
      recordedAt: NOW + 31,
    }).state, "CONFIRMED");

    const terminal = store.recordTerminal({
      settlementId: value.settlementId,
      terminalState: "COMPLETED",
      proofDigest: hash("successful:both-assets-proof"),
      assetsReconciled: true,
      recordedAt: NOW + 40,
    });
    assert.equal(terminal.terminalState, "COMPLETED");
    assert.equal(store.recordTerminal({
      settlementId: value.settlementId,
      terminalState: "COMPLETED",
      proofDigest: hash("successful:both-assets-proof"),
      assetsReconciled: true,
      recordedAt: NOW + 41,
    }).terminalState, "COMPLETED");
    assert.throws(() => store.recordTerminal({
      settlementId: value.settlementId,
      terminalState: "REFUNDED",
      proofDigest: hash("successful:refund-proof"),
      assetsReconciled: true,
      recordedAt: NOW + 42,
    }), /different terminal outcome/);
    assert.throws(() => store.planAction(action(value, "duplicate")), /closed to new actions/);
  } finally {
    store.close();
  }
});

test("turns a process crash into UNKNOWN and requires read-only reconciliation before any new action", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "treeswap-coordinator-"));
  const path = join(directory, "coordinator.sqlite");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const value = settlement("crash");
  const planned = action(value);

  const first = await CoordinatorStore.open(path);
  first.acceptSettlement(value);
  first.recordReservation(reservation(value));
  first.planAction(planned);
  first.claimAction(planned.actionId, NOW + 21);
  first.close();

  const recovered = await CoordinatorStore.open(path);
  try {
    assert.equal(recovered.recoverInterruptedActions(NOW + 30), 1);
    assert.equal(recovered.getAction(planned.actionId).state, "UNKNOWN");
    assert.equal(recovered.getSettlement(value.settlementId).reconciliationRequired, true);
    assert.throws(
      () => recovered.planAction(action(value, "another", { method: "evm:claim" })),
      /requires reconciliation/,
    );

    const notFound = recovered.reconcileAction({
      actionId: planned.actionId,
      observedState: "NOT_FOUND",
      observationDigest: hash("crash:not-found-observation"),
      observedAt: NOW + 31,
    });
    assert.equal(notFound.disposition, "unresolved");
    assert.equal(notFound.settlement.reconciliationRequired, true);
    assert.throws(() => recovered.planAction(action(value, "retry")), /requires reconciliation/);

    const reconciled = recovered.reconcileAction({
      actionId: planned.actionId,
      observedState: "SUCCEEDED",
      observationDigest: hash("crash:successful-track-payment"),
      observedAt: NOW + 32,
    });
    assert.equal(reconciled.disposition, "confirmed");
    assert.equal(reconciled.action.state, "CONFIRMED");
    assert.equal(reconciled.settlement.reconciliationRequired, false);
    assert.throws(() => recovered.planAction(action(value, "retry")), /existing method or request identifier/);
  } finally {
    recovered.close();
  }
});

test("halts on an impossible reconciliation result and never treats it as a retry opportunity", async () => {
  const store = await CoordinatorStore.open(":memory:", { allowMemory: true });
  const value = settlement("mismatch", { direction: "lightning-to-bit" });
  const cancel = action(value, "cancel", { method: CANCEL_INVOICE });
  try {
    store.acceptSettlement(value);
    store.planAction(cancel);
    store.claimAction(cancel.actionId, NOW + 21);
    store.recordActionResult({
      actionId: cancel.actionId,
      outcome: "ambiguous",
      resultDigest: hash("mismatch:lost-cancel-response"),
      resultCode: "RPC_AMBIGUOUS",
      recordedAt: NOW + 22,
    });
    const mismatch = store.reconcileAction({
      actionId: cancel.actionId,
      observedState: "SETTLED",
      observationDigest: hash("mismatch:settled-invoice"),
      observedAt: NOW + 23,
    });
    assert.equal(mismatch.disposition, "mismatch");
    assert.equal(mismatch.settlement.state, "HALTED");
    assert.equal(mismatch.settlement.haltCode, "RECONCILIATION_MISMATCH");
    assert.throws(
      () => store.planAction(action(value, "settle", { method: SETTLE_INVOICE })),
      /closed to new actions/,
    );
    assert.throws(() => store.recordTerminal({
      settlementId: value.settlementId,
      terminalState: "FAILED",
      proofDigest: hash("mismatch:terminal"),
      assetsReconciled: true,
      recordedAt: NOW + 24,
    }), /unresolved settlement/);
  } finally {
    store.close();
  }
});

test("stores only commitments and exposes aggregate metrics without cross-network identifiers", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "treeswap-coordinator-privacy-"));
  const path = join(directory, "coordinator.sqlite");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const privateInvoice = "lnbc1privateinvoicepayloadthatmustneverreachstorage";
  const privatePreimage = "private-preimage-that-must-never-reach-storage";
  const value = settlement("privacy", { direction: "lightning-to-bit" });
  const store = await CoordinatorStore.open(path);
  store.acceptSettlement(value);
  store.planAction(action(value, "hold", {
    method: "/invoicesrpc.Invoices/AddHoldInvoice",
    payloadDigest: coordinatorCommitmentDigest({ privateInvoice, privatePreimage }),
  }));
  const metrics = store.metrics();
  const events = store.secretFreeEvents();
  assert.equal(JSON.stringify(metrics).includes(value.settlementId), false);
  assert.equal(JSON.stringify(events).includes(value.settlementId), false);
  assert.equal(JSON.stringify(events).includes(value.paymentHash), false);
  store.close();

  const bytes = [];
  for (const filename of await readdir(directory)) bytes.push(await readFile(join(directory, filename)));
  const persisted = Buffer.concat(bytes).toString("utf8");
  assert.equal(persisted.includes(privateInvoice), false);
  assert.equal(persisted.includes(privatePreimage), false);
});

test("creates a verified private backup and restores it only to a fresh path", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "treeswap-coordinator-backup-"));
  const path = join(directory, "coordinator.sqlite");
  const backupPath = join(directory, "coordinator.backup.sqlite");
  const restoredPath = join(directory, "restored", "coordinator.sqlite");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const value = settlement("backup");
  const store = await CoordinatorStore.open(path);
  try {
    store.acceptSettlement(value);
    assert.deepEqual(store.integrityCheck({ full: true }), {
      check: "integrity_check",
      schema: "treeswap.coordinator.v5",
      status: "ok",
    });
    const backup = await store.createVerifiedBackup(backupPath);
    assert.equal(backup.check, "integrity_check");
    assert.equal(backup.schema, "treeswap.coordinator.v5");
    assert.equal(backup.status, "ok");
    assert.ok(Number(backup.pages) > 0);
    assert.equal((await stat(backupPath)).mode & 0o777, 0o600);
    await assert.rejects(store.createVerifiedBackup(backupPath), /already exists/);
  } finally {
    store.close();
  }

  assert.equal((await CoordinatorStore.verifyBackup(backupPath)).status, "ok");
  const restore = await CoordinatorStore.restoreVerifiedBackup(backupPath, restoredPath);
  assert.deepEqual(restore, {
    check: "integrity_check",
    schema: "treeswap.coordinator.v5",
    status: "ok",
    restoredToFreshPath: true,
  });
  assert.equal((await stat(restoredPath)).mode & 0o777, 0o600);
  await assert.rejects(
    CoordinatorStore.restoreVerifiedBackup(backupPath, restoredPath),
    /already exists/,
  );
  const restored = await CoordinatorStore.open(restoredPath);
  try {
    assert.equal(restored.getSettlement(value.settlementId).recordDigest, storeDigest(value));
  } finally {
    restored.close();
  }
});

test("recovers a committed WAL transaction and discards an interrupted transaction after SIGKILL", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "treeswap-coordinator-kill-"));
  const path = join(directory, "coordinator.sqlite");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const value = settlement("abrupt-kill");
  const initial = await CoordinatorStore.open(path);
  initial.acceptSettlement(value);
  initial.close();

  const fixture = fileURLToPath(new URL("./fixtures/coordinator-abrupt-kill.mjs", import.meta.url));
  const child = spawn(process.execPath, [fixture, path], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  const ready = await new Promise((resolve, reject) => {
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("exit", (code, signal) => reject(new Error(`crash fixture exited before ready: ${code ?? signal}: ${stderr}`)));
    child.stdout.once("data", (chunk) => {
      if (chunk.toString("utf8").trim() !== "READY") reject(new Error("crash fixture emitted an invalid readiness signal"));
      else resolve();
    });
  });
  assert.equal(ready, undefined);
  const exited = new Promise((resolve) => child.once("exit", resolve));
  assert.equal(child.kill("SIGKILL"), true);
  await exited;

  const recovered = await CoordinatorStore.open(path);
  try {
    assert.equal(recovered.integrityCheck({ full: true }).status, "ok");
    assert.equal(recovered.getSettlement(value.settlementId).recordDigest, storeDigest(value));
  } finally {
    recovered.close();
  }
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal(database.prepare("SELECT value FROM coordinator_meta WHERE key = 'crash_committed_probe'").get().value, "committed");
    assert.equal(database.prepare("SELECT value FROM coordinator_meta WHERE key = 'crash_uncommitted_probe'").get(), undefined);
  } finally {
    database.close();
  }
});

test("refuses a corrupted coordinator database before accepting work", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "treeswap-coordinator-corrupt-"));
  const path = join(directory, "coordinator.sqlite");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await CoordinatorStore.open(path);
  store.acceptSettlement(settlement("corruption"));
  store.close();
  const bytes = await readFile(path);
  bytes.fill(0, 0, 16);
  await writeFile(path, bytes, { mode: 0o600 });
  await assert.rejects(CoordinatorStore.open(path), /database|integrity|malformed/i);
});

test("refuses an unsupported schema without migrating or mutating it", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "treeswap-coordinator-schema-"));
  const path = join(directory, "coordinator.sqlite");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const database = new DatabaseSync(path);
  database.exec("CREATE TABLE coordinator_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL) STRICT");
  database.prepare("INSERT INTO coordinator_meta(key, value) VALUES ('schema', 'treeswap.coordinator.v999')").run();
  database.close();

  await assert.rejects(CoordinatorStore.open(path), /schema is unsupported/);
  const unchanged = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal(unchanged.prepare("SELECT value FROM coordinator_meta WHERE key = 'schema'").get().value, "treeswap.coordinator.v999");
    assert.equal(unchanged.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'settlements'").get().count, 0);
  } finally {
    unchanged.close();
  }
});

function storeDigest(value) {
  return coordinatorCommitmentDigest(value);
}
