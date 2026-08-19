import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LightningChainProgressStore } from "../lib/lightning-chain-progress.mjs";

const HASH_A = "aa".repeat(32);
const HASH_B = "bb".repeat(32);
const HASH_C = "cc".repeat(32);

test("requires durable forward progress before exposure and preserves the clock across restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "treeswap-chain-progress-"));
  const path = join(directory, "state.json");
  const first = await LightningChainProgressStore.open(path);
  assert.deepEqual(await first.observe({
    blockHeight: 900_000,
    bestBlockHash: HASH_A,
    bestHeaderTimestamp: 1_999_999_990,
    observedAt: 2_000_000_000,
  }), {
    initialized: false,
    conflicted: false,
    noProgressSeconds: 0,
    blockHeight: 900_000,
    bestBlockHash: HASH_A,
    bestHeaderTimestamp: 1_999_999_990,
  });

  const restarted = await LightningChainProgressStore.open(path);
  const unchanged = await restarted.observe({
    blockHeight: 900_000,
    bestBlockHash: HASH_A,
    bestHeaderTimestamp: 1_999_999_990,
    observedAt: 2_000_000_120,
  });
  assert.equal(unchanged.initialized, false);
  assert.equal(unchanged.noProgressSeconds, 120);

  const advanced = await restarted.observe({
    blockHeight: 900_001,
    bestBlockHash: HASH_B,
    bestHeaderTimestamp: 2_000_000_100,
    observedAt: 2_000_000_121,
  });
  assert.equal(advanced.initialized, true);
  assert.equal(advanced.noProgressSeconds, 0);

  const restartedAgain = await LightningChainProgressStore.open(path);
  const persisted = await restartedAgain.observe({
    blockHeight: 900_001,
    bestBlockHash: HASH_B,
    bestHeaderTimestamp: 2_000_000_100,
    observedAt: 2_000_000_181,
  });
  assert.equal(persisted.initialized, true);
  assert.equal(persisted.noProgressSeconds, 60);
});

test("persists a height or same-height-header conflict until a higher block arrives", async () => {
  const directory = await mkdtemp(join(tmpdir(), "treeswap-chain-conflict-"));
  const path = join(directory, "state.json");
  const store = await LightningChainProgressStore.open(path);
  await store.observe({ blockHeight: 10, bestBlockHash: HASH_A, bestHeaderTimestamp: 100, observedAt: 100 });
  await store.observe({ blockHeight: 11, bestBlockHash: HASH_B, bestHeaderTimestamp: 110, observedAt: 110 });
  assert.equal((await store.observe({
    blockHeight: 10,
    bestBlockHash: HASH_A,
    bestHeaderTimestamp: 100,
    observedAt: 111,
  })).conflicted, true);

  const restarted = await LightningChainProgressStore.open(path);
  assert.equal((await restarted.observe({
    blockHeight: 11,
    bestBlockHash: HASH_B,
    bestHeaderTimestamp: 110,
    observedAt: 112,
  })).conflicted, true);
  const recovered = await restarted.observe({
    blockHeight: 12,
    bestBlockHash: HASH_C,
    bestHeaderTimestamp: 120,
    observedAt: 120,
  });
  assert.equal(recovered.conflicted, false);
  assert.equal(recovered.initialized, true);
});

test("latches a backward wall-clock observation until later chain progress", async () => {
  const directory = await mkdtemp(join(tmpdir(), "treeswap-chain-clock-"));
  const path = join(directory, "state.json");
  const store = await LightningChainProgressStore.open(path);
  await store.observe({ blockHeight: 10, bestBlockHash: HASH_A, bestHeaderTimestamp: 100, observedAt: 1_000 });
  await store.observe({ blockHeight: 11, bestBlockHash: HASH_B, bestHeaderTimestamp: 110, observedAt: 1_010 });
  const regressed = await store.observe({
    blockHeight: 12,
    bestBlockHash: HASH_C,
    bestHeaderTimestamp: 120,
    observedAt: 1_009,
  });
  assert.equal(regressed.conflicted, true);
  assert.equal(regressed.initialized, true);

  const restarted = await LightningChainProgressStore.open(path);
  assert.equal((await restarted.observe({
    blockHeight: 11,
    bestBlockHash: HASH_B,
    bestHeaderTimestamp: 110,
    observedAt: 1_011,
  })).conflicted, true);
  assert.equal((await restarted.observe({
    blockHeight: 12,
    bestBlockHash: HASH_C,
    bestHeaderTimestamp: 120,
    observedAt: 1_012,
  })).conflicted, false);
});

test("latches same-height reorgs and impossible higher heights with an unchanged block hash", async () => {
  const directory = await mkdtemp(join(tmpdir(), "treeswap-chain-hash-"));
  const path = join(directory, "state.json");
  const store = await LightningChainProgressStore.open(path);
  await store.observe({ blockHeight: 10, bestBlockHash: HASH_A, bestHeaderTimestamp: 100, observedAt: 100 });
  await store.observe({ blockHeight: 11, bestBlockHash: HASH_B, bestHeaderTimestamp: 110, observedAt: 110 });
  assert.equal((await store.observe({
    blockHeight: 11,
    bestBlockHash: HASH_C,
    bestHeaderTimestamp: 110,
    observedAt: 111,
  })).conflicted, true);

  const secondDirectory = await mkdtemp(join(tmpdir(), "treeswap-chain-impossible-"));
  const second = await LightningChainProgressStore.open(join(secondDirectory, "state.json"));
  await second.observe({ blockHeight: 10, bestBlockHash: HASH_A, bestHeaderTimestamp: 100, observedAt: 100 });
  assert.equal((await second.observe({
    blockHeight: 11,
    bestBlockHash: HASH_A,
    bestHeaderTimestamp: 110,
    observedAt: 110,
  })).conflicted, true);
});

test("migrates a valid hashless v1 record into a closed v2 baseline", async () => {
  const directory = await mkdtemp(join(tmpdir(), "treeswap-chain-v1-"));
  const path = join(directory, "state.json");
  await writeFile(path, `${JSON.stringify({
    schema: "treeswap.lightning-chain-progress.v1",
    blockHeight: 10,
    bestHeaderTimestamp: 100,
    lastAdvancedAt: 100,
    initialized: true,
    conflicted: false,
  })}\n`, { mode: 0o600 });
  const migrated = await LightningChainProgressStore.open(path);
  assert.equal((await migrated.observe({
    blockHeight: 10,
    bestBlockHash: HASH_A,
    bestHeaderTimestamp: 100,
    observedAt: 110,
  })).initialized, false);
  const persisted = JSON.parse(await readFile(path, "utf8"));
  assert.equal(persisted.schema, "treeswap.lightning-chain-progress.v2");
  assert.equal(persisted.bestBlockHash, HASH_A);
});

test("rejects malformed or permissive chain-progress files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "treeswap-chain-invalid-"));
  const path = join(directory, "state.json");
  await writeFile(path, "{}\n", { mode: 0o600 });
  await assert.rejects(() => LightningChainProgressStore.open(path), /fields do not match/);
  const empty = await LightningChainProgressStore.open(join(directory, "empty.json"));
  await assert.rejects(() => empty.observe({
    blockHeight: 1,
    bestBlockHash: "AA".repeat(32),
    bestHeaderTimestamp: 1,
    observedAt: 1,
  }), /canonical 32-byte hex/);
  await chmod(path, 0o644);
  await assert.rejects(() => LightningChainProgressStore.open(path), /must not be group\/world accessible/);
});
