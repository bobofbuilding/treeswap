import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  ContractIntentWalletAbuseClockRollbackError,
  ContractIntentWalletAbuseRateLimitError,
  ContractIntentWalletAbuseStore,
  assertContractIntentWalletAbuseStoreLifecycle,
  claimContractIntentWalletAbuseStoreEdge,
  isContractIntentWalletAbuseStore,
} from "../lib/contract-intent-wallet-abuse-store.mjs";

const NOW = 1_787_686_400;

function digest(label) {
  return `0x${createHash("sha256").update(label, "utf8").digest("hex")}`;
}

function consumption(sessionDigest = digest("wallet abuse session"), now = NOW) {
  return {
    now,
    sessionDigest,
    sessionExpiresAt: NOW + 600,
  };
}

test("durably enforces the exact per-session window and exposes aggregates only", async () => {
  const store = await ContractIntentWalletAbuseStore.open({
    allowMemory: true,
    initialize: true,
    path: ":memory:",
  });
  assert.equal(isContractIntentWalletAbuseStore(store), true);
  assert.equal(isContractIntentWalletAbuseStore({ ...store }), false);
  assert.deepEqual(assertContractIntentWalletAbuseStoreLifecycle(store), {
    schema: "treeswap.contract-intent-wallet-abuse-store.v1",
    maximumEntries: 128,
    requestLimit: 8,
    windowSeconds: 60,
  });
  for (let count = 1; count <= 8; count += 1) {
    const result = store.consume(consumption());
    assert.equal(result.accepted, true);
    assert.equal(result.durable, true);
    assert.equal(result.walletDispatchAuthority, false);
    assert.equal(result.lightningDispatchAuthority, false);
    assert.equal(result.fundingAuthorization, false);
  }
  assert.throws(
    () => store.consume(consumption()),
    ContractIntentWalletAbuseRateLimitError,
  );
  const status = store.status();
  assert.equal(status.acceptedRequests, 8);
  assert.equal(status.rateRejectedRequests, 1);
  assert.equal(status.activeWindows, 1);
  assert.equal(status.durableClockHighWater, true);
  assert.equal(status.rawSessionTokensStored, false);
  assert.equal(status.sessionTokenHashesStored, false);
  assert.equal(status.sessionDigestsStored, false);
  assert.equal(status.walletsStored, false);
  assert.equal(status.requestBodiesStored, false);
  assert.doesNotMatch(JSON.stringify(status), /wallet abuse session/);
  store.close();
});

test("retains rate consumption and clock high-water state across restart without storing the session digest", async () => {
  const directory = await mkdtemp(join(tmpdir(), "treeswap-wallet-abuse-restart-"));
  await chmod(directory, 0o700);
  const path = join(directory, "abuse.sqlite");
  const rawDigest = digest("restart-persistent wallet abuse session");
  let store = await ContractIntentWalletAbuseStore.open({
    allowMemory: false,
    initialize: true,
    path,
  });
  for (let count = 0; count < 7; count += 1) store.consume(consumption(rawDigest));
  store.close();
  assert.equal((await lstat(path)).mode & 0o077, 0);
  assert.equal((await readFile(path)).includes(Buffer.from(rawDigest, "utf8")), false);

  store = await ContractIntentWalletAbuseStore.open({
    allowMemory: false,
    initialize: false,
    path,
  });
  assert.equal(store.consume(consumption(rawDigest)).accepted, true);
  assert.throws(
    () => store.consume(consumption(rawDigest)),
    ContractIntentWalletAbuseRateLimitError,
  );
  store.close();

  store = await ContractIntentWalletAbuseStore.open({
    allowMemory: false,
    initialize: false,
    path,
  });
  assert.throws(
    () => store.consume(consumption(rawDigest, NOW - 1)),
    ContractIntentWalletAbuseClockRollbackError,
  );
  const halted = store.status();
  assert.equal(halted.state, "halted");
  assert.equal(halted.haltedOnClockRollback, true);
  assert.throws(
    () => store.consume(consumption(rawDigest, NOW + 1)),
    /original active store lifecycle/,
  );
  store.close();
});

test("bounds active session windows and admits new work only after durable expiry", async () => {
  const store = await ContractIntentWalletAbuseStore.open({
    allowMemory: true,
    initialize: true,
    path: ":memory:",
  });
  for (let index = 0; index < 128; index += 1) {
    store.consume(consumption(digest(`bounded abuse session ${index}`)));
  }
  assert.equal(store.status().activeWindows, 128);
  assert.throws(
    () => store.consume(consumption(digest("bounded abuse overflow"))),
    ContractIntentWalletAbuseRateLimitError,
  );
  const afterWindow = {
    now: NOW + 60,
    sessionDigest: digest("bounded abuse after window"),
    sessionExpiresAt: NOW + 600,
  };
  assert.equal(store.consume(afterWindow).accepted, true);
  assert.equal(store.status().activeWindows, 1);
  store.close();
});

test("grants one lifecycle-bound edge lease and rejects copies, accessors, and reuse", async () => {
  const store = await ContractIntentWalletAbuseStore.open({
    allowMemory: true,
    initialize: true,
    path: ":memory:",
  });
  const deployment = new AbortController();
  const lease = claimContractIntentWalletAbuseStoreEdge(store, deployment.signal);
  assert.throws(() => store.consume(consumption()), /original active store lifecycle/);
  assert.throws(() => store.status(), /original store lifecycle/);
  assert.throws(() => store.close(), /edge lifecycle to stop first/);
  assert.throws(
    () => claimContractIntentWalletAbuseStoreEdge(store, deployment.signal),
    /already belongs to a SIWE edge/,
  );
  assert.equal(lease.consume(consumption()).accepted, true);
  assert.throws(() => lease.consume.call({ ...lease }, consumption()), /original lease/);
  let invoked = false;
  const accessor = { ...consumption() };
  Object.defineProperty(accessor, "now", {
    enumerable: true,
    get() {
      invoked = true;
      return NOW;
    },
  });
  assert.throws(() => lease.consume(accessor), /enumerable data properties/);
  assert.equal(invoked, false);
  assert.throws(
    () => lease.consume({ ...consumption(), extra: true }),
    /fields are not exact/,
  );
  assert.throws(
    () => lease.consume({ ...consumption(), sessionDigest: `0x${"00".repeat(32)}` }),
    /nonzero lowercase bytes32/,
  );
  deployment.abort();
  assert.equal(lease.status().state, "stopped");
  assert.throws(() => lease.consume(consumption()), /original active store lifecycle/);
  store.close();
});

test("halts an open ledger on live policy mutation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "treeswap-wallet-abuse-live-tamper-"));
  await chmod(directory, 0o700);
  const path = join(directory, "abuse.sqlite");
  const store = await ContractIntentWalletAbuseStore.open({
    allowMemory: false,
    initialize: true,
    path,
  });
  const database = new DatabaseSync(path);
  database.prepare(`
    UPDATE wallet_intent_abuse_meta SET value = '9'
    WHERE key = 'rate_requests_per_window'
  `).run();
  database.close();
  assert.throws(() => store.consume(consumption()), /failed closed/);
  const status = store.status();
  assert.equal(status.state, "halted");
  assert.equal(status.haltedOnStorageFailure, true);
  assert.equal(status.acceptedRequests, 0);
  store.close();
});

test("rejects unsafe filesystem state and database policy tampering", async () => {
  let coerced = false;
  await assert.rejects(
    ContractIntentWalletAbuseStore.open({
      allowMemory: false,
      initialize: true,
      path: {
        toString() {
          coerced = true;
          return "/tmp/forbidden-wallet-abuse.sqlite";
        },
      },
    }),
    /bounded absolute path/,
  );
  assert.equal(coerced, false);
  await assert.rejects(
    ContractIntentWalletAbuseStore.open({
      allowMemory: false,
      initialize: true,
      path: "relative-wallet-abuse.sqlite",
    }),
    /bounded absolute path/,
  );

  const directory = await mkdtemp(join(tmpdir(), "treeswap-wallet-abuse-filesystem-"));
  await chmod(directory, 0o700);
  const target = join(directory, "target");
  const alias = join(directory, "alias");
  await writeFile(target, "", { mode: 0o600 });
  await symlink(target, alias);
  await assert.rejects(
    ContractIntentWalletAbuseStore.open({ allowMemory: false, initialize: false, path: alias }),
    /private regular file/,
  );

  const permissive = join(directory, "permissive.sqlite");
  await writeFile(permissive, "", { mode: 0o644 });
  await assert.rejects(
    ContractIntentWalletAbuseStore.open({ allowMemory: false, initialize: false, path: permissive }),
    /private regular file/,
  );

  const path = join(directory, "tampered.sqlite");
  const store = await ContractIntentWalletAbuseStore.open({
    allowMemory: false,
    initialize: true,
    path,
  });
  store.close();
  await assert.rejects(
    ContractIntentWalletAbuseStore.open({ allowMemory: false, initialize: true, path }),
    /already exists/,
  );
  const database = new DatabaseSync(path);
  database.prepare(`
    UPDATE wallet_intent_abuse_meta SET value = '9'
    WHERE key = 'rate_requests_per_window'
  `).run();
  database.close();
  await assert.rejects(
    ContractIntentWalletAbuseStore.open({ allowMemory: false, initialize: false, path }),
    /policy or schema is unsupported/,
  );
});
