import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import test from "node:test";
import { fixedSolverDaemonEvidenceHttpsRequest } from "../lib/solver-daemon-evidence-client.mjs";
import { fixedPrivatePacketHttpsRequest } from "../lib/solver-private-packet.mjs";

function requestOptions() {
  return {
    method: "POST",
    redirect: "error",
    headers: {
      accept: "application/json",
      "cache-control": "no-store",
      "content-type": "application/json",
    },
    body: "{}",
    signal: new AbortController().signal,
  };
}

function httpsHarness() {
  const captured = [];
  return {
    captured,
    requestImpl(options, callback) {
      const request = new EventEmitter();
      request.end = (body) => {
        captured.push({ options, body });
        const response = Readable.from([Buffer.from("{}")]);
        response.statusCode = 200;
        response.headers = {
          "cache-control": "no-store",
          "content-type": "application/json",
        };
        callback(response);
      };
      return request;
    },
  };
}

const TRANSPORTS = Object.freeze([
  Object.freeze({
    label: "private packet",
    endpoint: "https://packet-provider.internal/v1/private-packet",
    request: fixedPrivatePacketHttpsRequest,
    hostname: "packet-provider.internal",
  }),
  Object.freeze({
    label: "dual evidence",
    endpoint: "https://evidence-provider.internal/v1/solver-daemon-evidence",
    request: fixedSolverDaemonEvidenceHttpsRequest,
    hostname: "evidence-provider.internal",
  }),
]);

test("pins each operator transport to one validated private address while preserving TLS and Host identity", async () => {
  for (const transport of TRANSPORTS) {
    const harness = httpsHarness();
    const lookups = [];
    const response = await transport.request(
      transport.endpoint,
      requestOptions(),
      {
        httpsRequestImpl: harness.requestImpl,
        lookupImpl: async (hostname, options) => {
          lookups.push({ hostname, options });
          return [
            { address: "10.24.0.9", family: 4 },
            { address: "fd00::9", family: 6 },
          ];
        },
      },
    );
    assert.equal(response.status, 200, transport.label);
    assert.deepEqual(lookups, [{
      hostname: transport.hostname,
      options: { all: true, verbatim: true },
    }], transport.label);
    assert.equal(harness.captured.length, 1, transport.label);
    const [{ options, body }] = harness.captured;
    assert.equal(options.protocol, "https:", transport.label);
    assert.equal(options.hostname, "10.24.0.9", transport.label);
    assert.equal(options.family, 4, transport.label);
    assert.equal(options.servername, transport.hostname, transport.label);
    assert.equal(options.port, 443, transport.label);
    assert.equal(options.agent, false, transport.label);
    assert.equal(options.rejectUnauthorized, true, transport.label);
    assert.equal(options.headers.host, transport.hostname, transport.label);
    assert.equal(options.headers["content-length"], 2, transport.label);
    assert.equal(body, "{}", transport.label);
  }
});

test("rejects empty, public, mixed, and family-forged DNS answers before either operator transport dispatches", async () => {
  const unsafeAnswerSets = [
    [],
    [{ address: "203.0.113.9", family: 4 }],
    [{ address: "10.24.0.9", family: 4 }, { address: "203.0.113.9", family: 4 }],
    [{ address: "10.24.0.9", family: 6 }],
    [{ address: "fd00::9", family: 4 }],
  ];
  for (const transport of TRANSPORTS) {
    for (const answers of unsafeAnswerSets) {
      let dispatched = false;
      await assert.rejects(
        transport.request(transport.endpoint, requestOptions(), {
          lookupImpl: async () => answers,
          httpsRequestImpl: () => {
            dispatched = true;
            throw new Error("must not dispatch");
          },
        }),
        /did not resolve|outside the private network/,
        transport.label,
      );
      assert.equal(dispatched, false, transport.label);
    }
  }
});

test("private IP literals bypass DNS without weakening certificate verification", async () => {
  for (const transport of [
    {
      endpoint: "https://10.24.0.9/v1/private-packet",
      request: fixedPrivatePacketHttpsRequest,
    },
    {
      endpoint: "https://10.24.0.9/v1/solver-daemon-evidence",
      request: fixedSolverDaemonEvidenceHttpsRequest,
    },
  ]) {
    const harness = httpsHarness();
    let lookupCalled = false;
    await transport.request(transport.endpoint, requestOptions(), {
      httpsRequestImpl: harness.requestImpl,
      lookupImpl: async () => {
        lookupCalled = true;
        return [{ address: "203.0.113.9", family: 4 }];
      },
    });
    assert.equal(lookupCalled, false);
    const [{ options }] = harness.captured;
    assert.equal(options.hostname, "10.24.0.9");
    assert.equal(options.family, 4);
    assert.equal(options.servername, undefined);
    assert.equal(options.rejectUnauthorized, true);
  }
});

test("globally disabled Node TLS verification rejects before DNS or dispatch", async () => {
  const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  try {
    for (const transport of TRANSPORTS) {
      let touched = false;
      await assert.rejects(
        transport.request(transport.endpoint, requestOptions(), {
          lookupImpl: async () => {
            touched = true;
            return [{ address: "10.24.0.9", family: 4 }];
          },
          httpsRequestImpl: () => {
            touched = true;
            throw new Error("must not dispatch");
          },
        }),
        /TLS certificate verification is disabled/,
        transport.label,
      );
      assert.equal(touched, false, transport.label);
    }
  } finally {
    if (previous === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous;
  }
});
