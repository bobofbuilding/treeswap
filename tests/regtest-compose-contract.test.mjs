import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const composePath = new URL("../infra/regtest/compose.yml", import.meta.url);

function serviceBlock(source, serviceName) {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line === `  ${serviceName}:`);
  assert.notEqual(start, -1, `${serviceName} service must exist`);
  const endOffset = lines.slice(start + 1).findIndex((line) => /^  [a-z0-9][a-z0-9-]*:$/.test(line));
  const end = endOffset === -1 ? lines.length : start + 1 + endOffset;
  return lines.slice(start, end).join("\n");
}

test("regtest coordinator smoke tools pin their fixture entrypoints", async () => {
  const source = await readFile(composePath, "utf8");
  assert.match(
    serviceBlock(source, "coordinator-smoke"),
    /^    command: \["node", "infra\/coordinator\/smoke\.mjs"\]$/m,
  );
  assert.match(
    serviceBlock(source, "coordinator-invoice-smoke"),
    /^    command: \["node", "infra\/coordinator\/invoice-smoke\.mjs"\]$/m,
  );
});
