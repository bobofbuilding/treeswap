import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const RUNNER = fileURLToPath(new URL("../scripts/run-mainnet-fork.sh", import.meta.url));
const PINNED_HASH = "0xf327faf6fee57fdf66e5973d19364e662da009ba266ab32899e242a2b22aef89";
const SECRET_RPC = "https://rpc.example/credential-that-must-not-be-logged";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "treeswap-mainnet-fork-runner-"));
  const forgeLog = join(directory, "forge.log");
  const castPath = join(directory, "cast");
  const forgePath = join(directory, "forge");
  await writeFile(castPath, `#!/bin/sh
if [ "\${FAKE_CAST_FAIL:-0}" = "1" ]; then
  exit 1
fi
if [ "\${1:-}" = "chain-id" ]; then
  printf '%s\\n' "\${FAKE_CHAIN_ID:-1}"
  exit 0
fi
if [ "\${1:-}" = "block" ] && [ "\${2:-}" = "25788856" ]; then
  printf '%s\\n' "\${FAKE_BLOCK_HASH:-${PINNED_HASH}}"
  exit 0
fi
exit 2
`, { mode: 0o700 });
  await writeFile(forgePath, `#!/bin/sh
printf '%s\\n' "$*" >"$FAKE_FORGE_LOG"
`, { mode: 0o700 });
  await Promise.all([chmod(castPath, 0o700), chmod(forgePath, 0o700)]);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return Object.freeze({ directory, forgeLog });
}

function run({ directory, forgeLog }, overrides = {}) {
  return spawnSync("/bin/bash", [RUNNER], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${directory}:/usr/bin:/bin`,
      MAINNET_RPC_URL: SECRET_RPC,
      FAKE_FORGE_LOG: forgeLog,
      ...overrides,
    },
  });
}

test("fork runner pins Ethereum mainnet and the exact canonical source block before Forge", async (t) => {
  const files = await fixture(t);

  const missingEndpoint = run(files, { MAINNET_RPC_URL: "" });
  assert.notEqual(missingEndpoint.status, 0);
  assert.match(missingEndpoint.stderr, /MAINNET_RPC_URL is required/);

  const wrongChain = run(files, { FAKE_CHAIN_ID: "11155111" });
  assert.notEqual(wrongChain.status, 0);
  assert.match(wrongChain.stderr, /wrong chain/);
  assert.doesNotMatch(wrongChain.stderr, /credential-that-must-not-be-logged/);

  const wrongBlock = run(files, { FAKE_BLOCK_HASH: `0x${"00".repeat(32)}` });
  assert.notEqual(wrongBlock.status, 0);
  assert.match(wrongBlock.stderr, /wrong pinned block/);
  assert.doesNotMatch(wrongBlock.stderr, /credential-that-must-not-be-logged/);

  const unavailable = run(files, { FAKE_CAST_FAIL: "1" });
  assert.notEqual(unavailable.status, 0);
  assert.match(unavailable.stderr, /chain preflight failed/);
  assert.doesNotMatch(unavailable.stderr, /credential-that-must-not-be-logged/);

  const accepted = run(files);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(
    (await readFile(files.forgeLog, "utf8")).trim(),
    "test --match-path contracts/test/fork/*.t.sol -vvv",
  );
  assert.doesNotMatch(`${accepted.stdout}${accepted.stderr}`, /credential-that-must-not-be-logged/);
});
