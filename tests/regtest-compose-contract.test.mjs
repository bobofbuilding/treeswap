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

test("private invoice-material service and client receive disjoint credential volumes", async () => {
  const source = await readFile(composePath, "utf8");
  const provider = serviceBlock(source, "selected-solver-invoice-material-service");
  const client = serviceBlock(source, "selected-solver-invoice-material-private-smoke");
  const providerExport = serviceBlock(
    source,
    "export-selected-solver-invoice-material-provider-credential",
  );
  const clientExport = serviceBlock(
    source,
    "export-selected-solver-invoice-material-client-credential",
  );

  assert.match(provider, /^    command: \["node", "infra\/selected-solver-invoice-material\/service\.mjs"\]$/m);
  assert.match(provider, /bob-invoice-material-credentials:\/run\/treeswap\/lnd:ro/);
  assert.match(provider, /selected-solver-invoice-material-provider-credentials:\/run\/treeswap\/provider:ro/);
  assert.doesNotMatch(provider, /selected-solver-invoice-material-client-credentials/);
  assert.match(client, /selected-solver-invoice-material-client-credentials:\/run\/treeswap\/client:ro/);
  assert.doesNotMatch(client, /bob-invoice-material-credentials|provider-credentials/);
  assert.match(providerExport, /provider-private\.pem/);
  assert.match(providerExport, /requester-public\.pem/);
  assert.doesNotMatch(providerExport, /requester-private\.pem|provider-public\.pem/);
  assert.match(clientExport, /requester-private\.pem/);
  assert.match(clientExport, /provider-public\.pem/);
  assert.doesNotMatch(clientExport, /provider-private\.pem|requester-public\.pem|payment-secret/);
});
