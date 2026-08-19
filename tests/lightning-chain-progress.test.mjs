import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LightningChainProgressStore } from "../lib/lightning-chain-progress.mjs";

test("requires durable forward progress before exposure and preserves the clock across restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "treeswap-chain-progress-"));
  const path = join(directory, "state.json");
  const first = await LightningChainProgressStore.open(path);
  assert.deepEqual(await first.observe({
    blockHeight: 900_000,
    bestHeaderTimestamp: 1_999_999_990,
    observedAt: 2_000_000_000,
  }), {
    initialized: false,
    conflicted: false,
    noProgressSeconds: 0,
    blockHeight: 900_000,
    bestHeaderTimestamp: 1_999_999_990,
  });

  const restarted = await LightningChainProgressStore.open(path);
  const unchanged = await restarted.observe({
    blockHeight: 900_000,
    bestHeaderTimestamp: 1_999_999_990,
    observedAt: 2_000_000_120,
  });
  assert.equal(unchanged.initialized, false);
  assert.equal(unchanged.noProgressSeconds, 120);

  const advanced = await restarted.observe({
    blockHeight: 900_001,
    bestHeaderTimestamp: 2_000_000_100,
    observedAt: 2_000_000_121,
  });
  assert.equal(advanced.initialized, true);
  assert.equal(advanced.noProgressSeconds, 0);

  const restartedAgain = await LightningChainProgressStore.open(path);
  const persisted = await restartedAgain.observe({
    blockHeight: 900_001,
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
  await store.observe({ blockHeight: 10, bestHeaderTimestamp: 100, observedAt: 100 });
  await store.observe({ blockHeight: 11, bestHeaderTimestamp: 110, observedAt: 110 });
  assert.equal((await store.observe({ blockHeight: 10, bestHeaderTimestamp: 100, observedAt: 111 })).conflicted, true);

  const restarted = await LightningChainProgressStore.open(path);
  assert.equal((await restarted.observe({
    blockHeight: 11,
    bestHeaderTimestamp: 110,
    observedAt: 112,
  })).conflicted, true);
  const recovered = await restarted.observe({ blockHeight: 12, bestHeaderTimestamp: 120, observedAt: 120 });
  assert.equal(recovered.conflicted, false);
  assert.equal(recovered.initialized, true);
});

test("latches a backward wall-clock observation until later chain progress", async () => {
  const directory = await mkdtemp(join(tmpdir(), "treeswap-chain-clock-"));
  const path = join(directory, "state.json");
  const store = await LightningChainProgressStore.open(path);
  await store.observe({ blockHeight: 10, bestHeaderTimestamp: 100, observedAt: 1_000 });
  await store.observe({ blockHeight: 11, bestHeaderTimestamp: 110, observedAt: 1_010 });
  const regressed = await store.observe({ blockHeight: 12, bestHeaderTimestamp: 120, observedAt: 1_009 });
  assert.equal(regressed.conflicted, true);
  assert.equal(regressed.initialized, true);

  const restarted = await LightningChainProgressStore.open(path);
  assert.equal((await restarted.observe({
    blockHeight: 11,
    bestHeaderTimestamp: 110,
    observedAt: 1_011,
  })).conflicted, true);
  assert.equal((await restarted.observe({
    blockHeight: 12,
    bestHeaderTimestamp: 120,
    observedAt: 1_012,
  })).conflicted, false);
});

test("rejects malformed or permissive chain-progress files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "treeswap-chain-invalid-"));
  const path = join(directory, "state.json");
  await writeFile(path, "{}\n", { mode: 0o600 });
  await assert.rejects(() => LightningChainProgressStore.open(path), /fields do not match/);
  await chmod(path, 0o644);
  await assert.rejects(() => LightningChainProgressStore.open(path), /must not be group\/world accessible/);
});
