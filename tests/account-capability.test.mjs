import assert from "node:assert/strict";
import test from "node:test";

import {
  ACCOUNT_SCHEMA_PROBE,
  inspectAccountStorage,
  requireAccountCapability,
} from "../lib/account-capability.mjs";

function binding(overrides = {}) {
  const observed = { sql: null };
  return {
    observed,
    prepare(sql) {
      observed.sql = sql;
      if (overrides.prepareThrows) throw new Error("credential-bearing backend failure");
      if (overrides.malformedStatement) return {};
      return {
        async all() {
          if (overrides.allThrows) throw new Error("missing table or column");
          return overrides.response ?? { results: [] };
        },
      };
    },
  };
}

test("enables accounts only when every required durable table and column is queryable", async () => {
  const db = binding();
  const result = await inspectAccountStorage(db);

  assert.deepEqual(result, {
    schema: "treeswap.account-capability.v1",
    enabled: true,
    durableStorage: true,
    emailDeliveryEnabled: false,
  });
  assert.equal(db.observed.sql, ACCOUNT_SCHEMA_PROBE);
  assert.match(db.observed.sql, /retention_expires_at/);
  assert.match(db.observed.sql, /WHERE 0$/);
  assert.equal(requireAccountCapability(result), result);
});

test("fails closed when the binding, schema, or response is unavailable", async (t) => {
  const cases = [
    ["missing binding", undefined],
    ["missing table or column", binding({ allThrows: true })],
    ["malformed statement", binding({ malformedStatement: true })],
    ["malformed response", binding({ response: {} })],
    ["prepare failure", binding({ prepareThrows: true })],
  ];

  for (const [name, db] of cases) {
    await t.test(name, async () => {
      const result = await inspectAccountStorage(db);
      assert.deepEqual(result, {
        schema: "treeswap.account-capability.v1",
        enabled: false,
        durableStorage: false,
        emailDeliveryEnabled: false,
      });
      assert.throws(() => requireAccountCapability(result), /disabled/);
      assert.doesNotMatch(JSON.stringify(result), /credential|failure|table|backend/i);
    });
  }
});

test("rejects incomplete or weakened capability objects", () => {
  for (const value of [
    null,
    {},
    { schema: "treeswap.account-capability.v1", enabled: true, durableStorage: false, emailDeliveryEnabled: false },
    { schema: "treeswap.account-capability.v1", enabled: true, durableStorage: true, emailDeliveryEnabled: true },
    { schema: "treeswap.account-capability.v0", enabled: true, durableStorage: true, emailDeliveryEnabled: false },
  ]) {
    assert.throws(() => requireAccountCapability(value), /disabled/);
  }
});
