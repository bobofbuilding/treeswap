import assert from "node:assert/strict";
import { open, rm } from "node:fs/promises";
import {
  ContractIntentWalletAbuseStore,
} from "../../lib/contract-intent-wallet-abuse-store.mjs";

const path = process.env.WALLET_ABUSE_DISK_FULL_PATH
  ?? "/data/wallet-abuse-disk-full.sqlite";
const fillerPath = process.env.WALLET_ABUSE_DISK_FULL_FILLER_PATH
  ?? "/data/wallet-abuse-disk-full.fill";
const now = 1_787_686_400;
const firstSession = `0x${"11".repeat(32)}`;
const secondSession = `0x${"22".repeat(32)}`;

function containsDiskFull(error) {
  let current = error;
  for (let depth = 0; depth < 8 && current; depth += 1) {
    if (/database or disk is full|SQLITE_FULL/i.test(String(current.message))) return true;
    current = current.cause;
  }
  return false;
}

let store = await ContractIntentWalletAbuseStore.open({
  allowMemory: false,
  initialize: true,
  path,
});
store.consume({
  now,
  sessionDigest: firstSession,
  sessionExpiresAt: now + 600,
});

const filler = await open(fillerPath, "wx", 0o600);
const chunk = Buffer.alloc(16 * 1_024, 0x5a);
let reachedFilesystemLimit = false;
try {
  while (!reachedFilesystemLimit) {
    try {
      await filler.write(chunk);
    } catch (error) {
      if (error?.code !== "ENOSPC") throw error;
      reachedFilesystemLimit = true;
    }
  }
} finally {
  chunk.fill(0);
  await filler.close();
}
assert.equal(reachedFilesystemLimit, true, "bounded filesystem did not reach ENOSPC");

let failedClosed = false;
try {
  store.consume({
    now: now + 1,
    sessionDigest: secondSession,
    sessionExpiresAt: now + 600,
  });
} catch (error) {
  assert.equal(containsDiskFull(error), true, "wallet abuse failure did not retain SQLITE_FULL");
  failedClosed = true;
}
assert.equal(failedClosed, true, "wallet abuse ledger accepted work on a full filesystem");
const halted = store.status();
assert.equal(halted.state, "halted");
assert.equal(halted.haltedOnStorageFailure, true);
assert.equal(halted.activeWindows, 1);
store.close();

await rm(fillerPath, { force: true });
store = await ContractIntentWalletAbuseStore.open({
  allowMemory: false,
  initialize: false,
  path,
});
assert.equal(store.status().activeWindows, 1);
assert.equal(store.consume({
  now: now + 1,
  sessionDigest: secondSession,
  sessionExpiresAt: now + 600,
}).accepted, true);
assert.equal(store.status().activeWindows, 2);
store.close();

console.log(JSON.stringify({
  baselineWindowsRecovered: 1,
  failedClosedOnDiskFull: true,
  status: "passed",
}));
