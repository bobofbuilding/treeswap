import assert from "node:assert/strict";
import { test } from "node:test";
import { destroyQualificationRegtest } from "../lib/regtest-qualification-lifecycle.mjs";

test("qualification destroys only its named regtest lab with the supplied process boundary", () => {
  const environment = Object.freeze({ QUALIFICATION_TEST: "1" });
  const calls = [];
  destroyQualificationRegtest({
    repository: "/workspace/treeswap",
    environment,
    stdio: "pipe",
    run(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0 };
    },
  });

  assert.deepEqual(calls, [{
    command: "npm",
    args: ["run", "regtest:destroy"],
    options: {
      cwd: "/workspace/treeswap",
      env: environment,
      stdio: "pipe",
    },
  }]);
});

test("qualification fails closed when regtest destruction does not complete", () => {
  assert.throws(
    () => destroyQualificationRegtest({ repository: "/workspace/treeswap", run: () => ({ status: 1 }) }),
    /regtest destruction failed/,
  );
  assert.throws(
    () => destroyQualificationRegtest({ repository: "", run: () => ({ status: 0 }) }),
    /repository is required/,
  );
  assert.throws(
    () => destroyQualificationRegtest({ repository: "/workspace/treeswap", run: null }),
    /process runner is required/,
  );
});
