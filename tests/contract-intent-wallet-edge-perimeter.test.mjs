import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  realpath,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  acquireContractIntentWalletEdgeReplicaFenceForTests,
} from "../lib/contract-intent-wallet-edge-perimeter.mjs";

const NOW_MILLISECONDS = Date.parse("2026-08-26T12:00:00.000Z");

test("retains a private wallet-edge crash fence until explicit reconciliation", async () => {
  const temporaryAlias = await mkdtemp(join(tmpdir(), "treeswap-wallet-edge-fence-"));
  const temporary = await realpath(temporaryAlias);
  const privateAlias = join(temporary, "private");
  const publicAlias = join(temporary, "public");
  const symlinkAlias = join(temporary, "linked-private");
  await Promise.all([
    mkdtemp(`${privateAlias}-`),
    mkdtemp(`${publicAlias}-`),
  ]).then(async ([privateDirectoryAlias, publicDirectoryAlias]) => {
    const privateDirectory = await realpath(privateDirectoryAlias);
    const publicDirectory = await realpath(publicDirectoryAlias);
    await chmod(privateDirectory, 0o700);
    await chmod(publicDirectory, 0o755);
    await symlink(privateDirectory, symlinkAlias);

    const active = new AbortController();
    const options = {
      clock: () => NOW_MILLISECONDS,
      randomBytes: () => Buffer.alloc(32, 7),
      runtimeDirectory: privateDirectory,
      signal: active.signal,
    };
    await assert.rejects(
      acquireContractIntentWalletEdgeReplicaFenceForTests({ ...options, extra: true }),
      /fields are not exact/,
    );
    await assert.rejects(
      acquireContractIntentWalletEdgeReplicaFenceForTests({
        ...options,
        runtimeDirectory: "relative/fence",
      }),
      /canonical absolute directory/,
    );
    let coercedDirectory = false;
    await assert.rejects(
      acquireContractIntentWalletEdgeReplicaFenceForTests({
        ...options,
        runtimeDirectory: {
          toString() {
            coercedDirectory = true;
            return privateDirectory;
          },
        },
      }),
      /canonical absolute directory/,
    );
    assert.equal(coercedDirectory, false);
    await assert.rejects(
      acquireContractIntentWalletEdgeReplicaFenceForTests({
        ...options,
        runtimeDirectory: publicDirectory,
      }),
      /not private and owner-controlled/,
    );
    await assert.rejects(
      acquireContractIntentWalletEdgeReplicaFenceForTests({
        ...options,
        runtimeDirectory: symlinkAlias,
      }),
      /not private and owner-controlled/,
    );
    await assert.rejects(
      acquireContractIntentWalletEdgeReplicaFenceForTests({
        ...options,
        randomBytes: () => Buffer.alloc(32),
      }),
      /randomness is zero/,
    );

    const fence = await acquireContractIntentWalletEdgeReplicaFenceForTests(options);
    const status = fence.status();
    assert.equal(status.state, "held");
    assert.equal(status.automaticStaleTakeover, false);
    assert.equal(status.runtimeDirectoryDisclosed, false);
    assert.equal(status.ownerTokenDisclosed, false);
    assert.doesNotMatch(JSON.stringify(status), new RegExp(privateDirectory));
    await assert.rejects(
      acquireContractIntentWalletEdgeReplicaFenceForTests({
        ...options,
        randomBytes: () => Buffer.alloc(32, 8),
      }),
      /another wallet edge replica or an unreconciled crash holds the fence/,
    );
    await assert.rejects(
      ({ ...fence }).assertHeld(),
      /unavailable/,
    );

    active.abort();
    assert.equal(fence.status().state, "held");
    await assert.rejects(fence.assertHeld(), /unavailable/);
    const replacement = new AbortController();
    await assert.rejects(
      acquireContractIntentWalletEdgeReplicaFenceForTests({
        ...options,
        randomBytes: () => Buffer.alloc(32, 9),
        signal: replacement.signal,
      }),
      /another wallet edge replica or an unreconciled crash holds the fence/,
    );
    assert.equal(await fence.release(), true);
    assert.equal(await fence.release(), false);
    const reconciled = await acquireContractIntentWalletEdgeReplicaFenceForTests({
      ...options,
      clock: () => NOW_MILLISECONDS + 1_000,
      randomBytes: () => Buffer.alloc(32, 10),
      signal: replacement.signal,
    });
    assert.equal((await reconciled.assertHeld()).automaticStaleTakeover, false);
    assert.equal(await reconciled.release(), true);
    replacement.abort();
  });
  await rm(temporary, { recursive: true, force: true });
});

test("rejects an already-aborted wallet-edge fence lifecycle", async () => {
  const directoryAlias = await mkdtemp(join(tmpdir(), "treeswap-wallet-edge-aborted-"));
  const directory = await realpath(directoryAlias);
  await chmod(directory, 0o700);
  const lifecycle = new AbortController();
  lifecycle.abort();
  try {
    await assert.rejects(
      acquireContractIntentWalletEdgeReplicaFenceForTests({
        clock: () => NOW_MILLISECONDS,
        randomBytes: () => Buffer.alloc(32, 11),
        runtimeDirectory: directory,
        signal: lifecycle.signal,
      }),
      /active deployment signal/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
