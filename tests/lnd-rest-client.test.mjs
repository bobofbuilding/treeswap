import assert from "node:assert/strict";
import test from "node:test";
import { invoiceDigest, isPrivateLndHostname, LndRestError } from "../lib/lnd-rest-client.mjs";

test("uses a deterministic secret-free digest for an exact BOLT 11 invoice", () => {
  assert.equal(
    invoiceDigest("lnbcrt1exact"),
    "0x9d2be841298aa306110b4ea75e30ede67813e303790eec000c2698cfe327b922",
  );
  assert.notEqual(invoiceDigest("lnbcrt1exact"), invoiceDigest("lnbcrt1changed"));
});

test("LND transport errors expose status metadata but no response or credential body", () => {
  const error = new LndRestError("LND rejected POST /v2/router/send", { httpStatus: 403, grpcCode: 7 });
  assert.equal(error.httpStatus, 403);
  assert.equal(error.grpcCode, 7);
  assert.equal(error.ambiguous, false);
  assert.equal(JSON.stringify(error).includes("macaroon"), false);
});

test("accepts only explicit private-network LND host forms", () => {
  for (const host of ["alice", "127.0.0.1", "10.4.0.2", "172.20.0.2", "192.168.1.2", "lnd.internal", "lnd.default.svc.cluster.local", "fd00::1"]) {
    assert.equal(isPrivateLndHostname(host), true, host);
  }
  for (const host of ["lnd.example.com", "8.8.8.8", "172.15.0.1", "172.32.0.1", "2001:4860:4860::8888"]) {
    assert.equal(isPrivateLndHostname(host), false, host);
  }
});
