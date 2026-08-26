import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import test from "node:test";
import { id, Wallet } from "ethers";
import {
  SOLVER_CAPABILITY_TYPES,
  solverCapabilityClaimsDigest,
  solverCapabilityDomain,
  solverCapabilityProofMessage,
  solverEndpointOriginDigest,
  solverEndpointPublicKeyDigest,
  solverLightningNodePubkeyDigest,
} from "../lib/solver-capability.mjs";
import {
  buildSignedSolverCapabilityResponse,
  buildSolverCapabilityRequest,
  isPublicSolverEndpointAddress,
  pinnedPublicHttpsRequest,
  pinnedPublicRfqRequest,
  pinnedPublicSelectedSolverRequest,
  pinnedPublicSolverContractSigningRequest,
  pinnedPublicWalletSessionRequest,
  queryVerifiedSolverCapability,
  solverEndpointResponseDigest,
} from "../lib/solver-endpoint-transport.mjs";

const NOW = 2_000_000_000;
const ORIGIN = "https://solver.example";
const OTHER_ORIGIN = "https://other.example";
const SOLVER_CONTRACT = "0x1111111111111111111111111111111111111111";
const OTHER_CONTRACT = "0x2222222222222222222222222222222222222222";
const SOLVER_CONTRACT_CODE_HASH = id("solver-contract-runtime");
const OTHER_CONTRACT_CODE_HASH = id("other-contract-runtime");
const NODE_PUBKEY = `02${"33".repeat(32)}`;
const LND_SIGNATURE = "y".repeat(104);
const solver = new Wallet(`0x${"55".repeat(32)}`);
const endpointKeys = generateKeyPairSync("ed25519");
const endpointPublicKey = endpointKeys.publicKey.export({ format: "pem", type: "spki" }).toString();
const policy = {
  chainId: "1",
  lightningToBitContract: SOLVER_CONTRACT,
  bitToLightningContract: OTHER_CONTRACT,
  lightningToBitContractCodeHash: SOLVER_CONTRACT_CODE_HASH,
  bitToLightningContractCodeHash: OTHER_CONTRACT_CODE_HASH,
  maxCapabilityTtlSeconds: 120,
  maxCapacityObservationAgeSeconds: 30,
  maxClockSkewSeconds: 5,
};

async function capabilityEnvelope(overrides = {}) {
  const claims = {
    capabilityId: id("endpoint-capability:one"),
    direction: id("lightning-to-bit"),
    solver: solver.address,
    lightningNodePubkeyDigest: solverLightningNodePubkeyDigest(NODE_PUBKEY),
    endpointPublicKeyDigest: solverEndpointPublicKeyDigest(endpointPublicKey),
    endpointOriginDigest: solverEndpointOriginDigest(ORIGIN),
    availableBitWei: String(100n * 10n ** 18n),
    availableLightningSats: "250000",
    capacityEpoch: "7",
    issuedAt: NOW,
    expiresAt: NOW + 60,
    ...overrides.declaration,
  };
  const declaration = {
    ...claims,
    proofChallenge: solverCapabilityClaimsDigest(claims, {
      chainId: policy.chainId,
      verifyingContract: SOLVER_CONTRACT,
    }),
  };
  const proofMessage = solverCapabilityProofMessage(declaration.proofChallenge);
  const envelope = {
    declaration,
    endpointOrigin: ORIGIN,
    endpointPublicKey,
    endpointSignature: sign(null, proofMessage, endpointKeys.privateKey).toString("base64"),
    evmSignature: await solver.signTypedData(
      solverCapabilityDomain({ chainId: policy.chainId, verifyingContract: SOLVER_CONTRACT }),
      SOLVER_CAPABILITY_TYPES,
      declaration,
    ),
    lightningNodePubkey: NODE_PUBKEY,
    lightningSignature: LND_SIGNATURE,
  };
  return { ...envelope, ...overrides.envelope };
}

function evidence({ verifierCalls = null, readerCalls = null, bitInventory = String(100n * 10n ** 18n) } = {}) {
  return {
    verifyLightningNodeSignature: async ({ message, signature }) => {
      verifierCalls?.push({ message: Buffer.from(message), signature });
      return { valid: true, pubkey: NODE_PUBKEY };
    },
    readVerifiedBitInventory: async (input) => {
      readerCalls?.push({ kind: "bit", input });
      return { solverId: solver.address, availableBitWei: bitInventory, observedAt: NOW };
    },
    readVerifiedLightningCapacity: async (input) => {
      readerCalls?.push({ kind: "lightning", input });
      return {
        nodePubkey: NODE_PUBKEY,
        availableLightningSats: "250000",
        capacityEpoch: "7",
        observedAt: NOW,
      };
    },
  };
}

function responseFor(envelope, request, overrides = {}) {
  return buildSignedSolverCapabilityResponse({
    request,
    capabilityEnvelope: envelope,
    servedAt: NOW,
    expiresAt: NOW + 10,
    endpointPrivateKey: endpointKeys.privateKey,
    ...overrides,
  });
}

function jsonResponse(value, options = {}) {
  return new Response(typeof value === "string" ? value : JSON.stringify(value), {
    status: options.status ?? 200,
    headers: {
      "cache-control": "no-store",
      "content-type": options.contentType ?? "application/json",
      ...options.headers,
    },
  });
}

function queryOptions(overrides = {}) {
  return {
    endpointOrigin: ORIGIN,
    solverId: solver.address,
    direction: "lightning-to-bit",
    policy,
    nowSeconds: () => NOW,
    randomBytesImpl: () => Buffer.alloc(32, 0x99),
    ...evidence(),
    ...overrides,
  };
}

test("authenticates one fresh endpoint response before admitting its capability", async () => {
  const envelope = await capabilityEnvelope();
  const verifierCalls = [];
  const readerCalls = [];
  const result = await queryVerifiedSolverCapability(queryOptions({
    ...evidence({ verifierCalls, readerCalls }),
    requestImpl: async (url, options) => {
      assert.equal(url.href, `${ORIGIN}/v1/capability`);
      assert.equal(options.method, "POST");
      assert.equal(options.redirect, "error");
      assert.equal(options.headers["cache-control"], "no-store");
      const request = JSON.parse(options.body);
      assert.equal(request.challenge, `0x${"99".repeat(32)}`);
      return jsonResponse(responseFor(envelope, request));
    },
  }));
  assert.equal(result.valid, true);
  assert.equal(result.transport.authenticated, true);
  assert.equal(result.transport.endpointOrigin, ORIGIN);
  assert.equal(result.transport.responseExpiresAt, NOW + 10);
  assert.equal(result.capacitySnapshot.capabilityExpiresAt, NOW + 60);
  assert.equal(verifierCalls.length, 1);
  assert.equal(readerCalls.length, 2);
});

test("rejects a changed request and a changed signed response before external verification", async () => {
  const envelope = await capabilityEnvelope();
  let externalCalls = 0;
  const noExternalEvidence = evidence({
    verifierCalls: { push: () => { externalCalls += 1; } },
    readerCalls: { push: () => { externalCalls += 1; } },
  });
  await assert.rejects(
    queryVerifiedSolverCapability(queryOptions({
      ...noExternalEvidence,
      requestImpl: async (_url, options) => {
        const request = JSON.parse(options.body);
        const changed = { ...request, challenge: `0x${"88".repeat(32)}` };
        return jsonResponse(responseFor(envelope, changed));
      },
    })),
    (error) => error.code === "REQUEST_CHANGED" && error.ambiguous === false,
  );

  await assert.rejects(
    queryVerifiedSolverCapability(queryOptions({
      ...noExternalEvidence,
      requestImpl: async (_url, options) => {
        const request = JSON.parse(options.body);
        const response = JSON.parse(JSON.stringify(responseFor(envelope, request)));
        response.capabilityEnvelope.declaration.availableBitWei = "1";
        return jsonResponse(response);
      },
    })),
    (error) => error.code === "INVALID_RESPONSE_SIGNATURE",
  );
  assert.equal(externalCalls, 0);
});

test("rejects a self-authenticated endpoint whose EVM capability is invalid", async () => {
  const invalid = await capabilityEnvelope();
  invalid.evmSignature = `0x${"00".repeat(65)}`;
  let verifierCalls = 0;
  await assert.rejects(
    queryVerifiedSolverCapability(queryOptions({
      verifyLightningNodeSignature: async () => {
        verifierCalls += 1;
        return { valid: true, pubkey: NODE_PUBKEY };
      },
      requestImpl: async (_url, options) => {
        const request = JSON.parse(options.body);
        return jsonResponse(responseFor(invalid, request));
      },
    })),
    (error) => error.code === "INVALID_CAPABILITY",
  );
  assert.equal(verifierCalls, 0);
});

test("pins the queried origin and expected solver identity", async () => {
  const envelope = await capabilityEnvelope();
  const responder = async (_url, options) => jsonResponse(responseFor(envelope, JSON.parse(options.body)));
  await assert.rejects(
    queryVerifiedSolverCapability(queryOptions({ endpointOrigin: OTHER_ORIGIN, requestImpl: responder })),
    (error) => error.code === "INVALID_CAPABILITY",
  );
  await assert.rejects(
    queryVerifiedSolverCapability(queryOptions({
      solverId: "0x6666666666666666666666666666666666666666",
      requestImpl: responder,
    })),
    (error) => error.code === "REQUEST_CHANGED" || error.code === "INVALID_CAPABILITY",
  );
});

test("treats redirects, status failures, malformed bodies, and transport loss as read-only failures", async () => {
  const cases = [
    [async () => { throw new Error("private upstream details"); }, "TRANSPORT_FAILED", {}],
    [async () => new Promise(() => {}), "TRANSPORT_FAILED", { timeoutMs: 5 }],
    [async () => null, "INVALID_RESPONSE", {}],
    [async () => ({ redirected: true, status: 200 }), "REDIRECT_REFUSED", {}],
    [async () => jsonResponse({ private: "upstream details" }, { status: 503 }), "HTTP_REJECTED", {}],
    [async () => jsonResponse("not-json"), "INVALID_RESPONSE", {}],
    [async () => jsonResponse({}, { contentType: "text/plain" }), "INVALID_RESPONSE", {}],
  ];
  for (const [requestImpl, code, overrides] of cases) {
    await assert.rejects(
      queryVerifiedSolverCapability(queryOptions({ requestImpl, ...overrides })),
      (error) => error.code === code && error.ambiguous === false
        && !error.message.includes("private upstream details"),
    );
  }
});

test("bounds and cancels the complete capability response body under the transport deadline", async () => {
  let bodyCancelled = false;
  await assert.rejects(queryVerifiedSolverCapability(queryOptions({
    timeoutMs: 5,
    requestImpl: async () => new Response(new ReadableStream({
      cancel() {
        bodyCancelled = true;
      },
    }), {
      status: 200,
      headers: { "cache-control": "no-store", "content-type": "application/json" },
    }),
  })), (error) => error.code === "TRANSPORT_FAILED" && error.ambiguous === false);
  assert.equal(bodyCancelled, true);
});

test("requires strict non-cacheable capability response framing", async () => {
  const envelope = await capabilityEnvelope();
  const cases = [
    { "cache-control": "" },
    { "content-encoding": "gzip" },
    { "content-length": "01" },
    { "content-length": "2", "transfer-encoding": "chunked" },
    { "content-length": "1" },
    { "content-type": "application/json; charset=utf-16" },
    { "transfer-encoding": "gzip" },
  ];
  for (const headers of cases) {
    await assert.rejects(queryVerifiedSolverCapability(queryOptions({
      requestImpl: async (_url, options) => jsonResponse(
        responseFor(envelope, JSON.parse(options.body)),
        { headers },
      ),
    })), (error) => error.code === "INVALID_RESPONSE" && error.ambiguous === false);
  }

  for (const bytes of [
    [0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc0, 0xaf, 0x22, 0x7d],
    [0xef, 0xbb, 0xbf, ...Buffer.from('{"x":true}')],
  ]) {
    await assert.rejects(queryVerifiedSolverCapability(queryOptions({
      requestImpl: async () => new Response(Uint8Array.from(bytes), {
        headers: { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" },
      }),
    })), (error) => error.code === "INVALID_RESPONSE" && error.ambiguous === false);
  }

  let cancelled = 0;
  await assert.rejects(queryVerifiedSolverCapability(queryOptions({
    requestImpl: async () => ({
      status: 200,
      redirected: false,
      headers: new Headers({ "cache-control": "no-store", "content-type": "text/plain" }),
      body: new ReadableStream({
        cancel() {
          cancelled += 1;
          return new Promise(() => {});
        },
      }),
    }),
  })), (error) => error.code === "INVALID_RESPONSE" && error.ambiguous === false);
  assert.equal(cancelled, 1);
});

test("cancels rejected capability response bodies without trusting teardown", async () => {
  let cancelled = 0;
  for (const response of [
    { status: 503, redirected: false },
    { status: 200, redirected: true },
  ]) {
    await assert.rejects(queryVerifiedSolverCapability(queryOptions({
      requestImpl: async () => ({
        ...response,
        headers: new Headers({ "cache-control": "no-store", "content-type": "application/json" }),
        body: new ReadableStream({
          cancel() {
            cancelled += 1;
            return new Promise(() => {});
          },
        }),
      }),
    })), (error) => (error.code === "HTTP_REJECTED" || error.code === "REDIRECT_REFUSED")
      && error.ambiguous === false);
  }
  assert.equal(cancelled, 2);
});

test("cancels capability proof verification when active preparation shuts down", async () => {
  const envelope = await capabilityEnvelope();
  let verifierStarted;
  const started = new Promise((resolve) => { verifierStarted = resolve; });
  const controller = new AbortController();
  const pending = queryVerifiedSolverCapability(queryOptions({
    signal: controller.signal,
    verifyLightningNodeSignature: async () => {
      verifierStarted();
      return new Promise(() => {});
    },
    requestImpl: async (_url, options) => jsonResponse(responseFor(envelope, JSON.parse(options.body))),
  }));
  await started;
  controller.abort();
  await assert.rejects(pending, (error) => error.code === "TRANSPORT_FAILED" && error.ambiguous === false);
});

test("rejects private and reserved endpoint space before any request", async () => {
  for (const address of [
    "127.0.0.1", "10.0.0.1", "169.254.169.254", "172.16.0.1", "192.168.1.1",
    "100.64.0.1", "192.88.99.1", "198.51.100.1", "::1", "fd00::1", "fe80::1",
    "64:ff9b:1::1", "100:0:0:1::1", "2001::1", "2002::1", "3fff::1", "5f00::1",
    "::ffff:127.0.0.1", "::ffff:8.8.8.8",
  ]) assert.equal(isPublicSolverEndpointAddress(address), false, address);
  assert.equal(isPublicSolverEndpointAddress("8.8.8.8"), true);
  assert.equal(isPublicSolverEndpointAddress("2606:4700:4700::1111"), true);

  let requests = 0;
  for (const endpointOrigin of [
    "https://127.0.0.1", "https://10.0.0.1", "https://169.254.169.254",
    "https://[::1]", "https://localhost", "https://solver.internal", "https://solver.example:444",
  ]) {
    await assert.rejects(queryVerifiedSolverCapability(queryOptions({
      endpointOrigin,
      requestImpl: async () => {
        requests += 1;
        throw new Error();
      },
    })), /public|default HTTPS port/);
  }
  assert.equal(requests, 0);
});

test("pins the resolved public address while preserving the TLS and HTTP hostname", async () => {
  const responseBody = Buffer.from("{}", "utf8");
  const response = await pinnedPublicHttpsRequest(`${ORIGIN}/v1/capability`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{\"request\":true}",
  }, {
    lookupImpl: async () => [{ address: "8.8.8.8", family: 4 }],
    httpsRequestImpl: (options, callback) => {
      assert.equal(options.hostname, "8.8.8.8");
      assert.equal(options.family, 4);
      assert.equal(options.servername, "solver.example");
      assert.equal(options.headers.host, "solver.example");
      assert.equal(options.path, "/v1/capability");
      assert.equal(options.rejectUnauthorized, true);
      const request = new EventEmitter();
      request.end = (body) => {
        assert.equal(body, "{\"request\":true}");
        const incoming = Readable.from([responseBody]);
        incoming.statusCode = 200;
        incoming.headers = { "content-type": "application/json", "content-length": "2" };
        queueMicrotask(() => callback(incoming));
      };
      return request;
    },
  });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const chunk = await reader.read();
  assert.equal(Buffer.from(chunk.value).toString("utf8"), "{}");

  await assert.rejects(
    pinnedPublicHttpsRequest(`${ORIGIN}/v1/capability`, { body: "{}" }, {
      lookupImpl: async () => [
        { address: "8.8.8.8", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ],
      httpsRequestImpl: () => assert.fail("mixed public/private DNS must not connect"),
    }),
    /outside the public network/,
  );
});

test("bounds the live pinned public response stream before JSON parsing", async () => {
  let incoming;
  const response = await pinnedPublicHttpsRequest(`${ORIGIN}/v1/capability`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  }, {
    maximumResponseBytes: 2,
    lookupImpl: async () => [{ address: "8.8.8.8", family: 4 }],
    httpsRequestImpl: (_options, callback) => {
      const request = new EventEmitter();
      request.end = () => {
        incoming = Readable.from([Buffer.from("oversized")]);
        incoming.statusCode = 200;
        incoming.headers = { "cache-control": "no-store", "content-type": "application/json" };
        queueMicrotask(() => callback(incoming));
      };
      return request;
    },
  });
  const reader = response.body.getReader();
  await assert.rejects(reader.read(), /exceeded its size limit/);
  assert.equal(incoming.destroyed, true);
});

test("keeps the public RFQ route pinned and separate from the capability route", async () => {
  const response = await pinnedPublicRfqRequest(`${ORIGIN}/v1/rfq`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  }, {
    lookupImpl: async () => [{ address: "8.8.8.8", family: 4 }],
    httpsRequestImpl: (options, callback) => {
      assert.equal(options.path, "/v1/rfq");
      assert.equal(options.hostname, "8.8.8.8");
      assert.equal(options.servername, "solver.example");
      const request = new EventEmitter();
      request.end = () => {
        const incoming = Readable.from([Buffer.from("{}")]);
        incoming.statusCode = 200;
        incoming.headers = { "content-type": "application/json" };
        queueMicrotask(() => callback(incoming));
      };
      return request;
    },
  });
  assert.equal(response.status, 200);
  await assert.rejects(pinnedPublicRfqRequest(`${ORIGIN}/v1/capability`, { body: "{}" }), /invalid/);
  await assert.rejects(pinnedPublicHttpsRequest(`${ORIGIN}/v1/rfq`, { body: "{}" }), /invalid/);
});

test("keeps the selected-solver finalization route pinned and separate", async () => {
  await assert.rejects(() => pinnedPublicSelectedSolverRequest(`${ORIGIN}/v1/rfq`, {
    body: "{}",
  }), /invalid/);
});

test("keeps the solver contract-signing route pinned and separate", async () => {
  await assert.rejects(() => pinnedPublicSolverContractSigningRequest(`${ORIGIN}/v1/finalize`, {
    body: "{}",
  }), /invalid/);
  await assert.rejects(() => pinnedPublicSelectedSolverRequest(
    `${ORIGIN}/v1/sign-contract-intent`,
    { body: "{}" },
  ), /invalid/);
});

test("keeps the private wallet-session read route pinned and separate", async () => {
  const response = await pinnedPublicWalletSessionRequest(
    `${ORIGIN}/api/internal/wallet-session-read`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    },
    {
      lookupImpl: async () => [{ address: "8.8.8.8", family: 4 }],
      httpsRequestImpl: (options, callback) => {
        assert.equal(options.path, "/api/internal/wallet-session-read");
        assert.equal(options.hostname, "8.8.8.8");
        assert.equal(options.servername, "solver.example");
        const request = new EventEmitter();
        request.end = () => {
          const incoming = Readable.from([Buffer.from("{}")]);
          incoming.statusCode = 200;
          incoming.headers = { "content-type": "application/json" };
          queueMicrotask(() => callback(incoming));
        };
        return request;
      },
    },
  );
  assert.equal(response.status, 200);
  await assert.rejects(
    pinnedPublicWalletSessionRequest(`${ORIGIN}/v1/rfq`, { body: "{}" }),
    /invalid/,
  );
  await assert.rejects(
    pinnedPublicRfqRequest(`${ORIGIN}/api/internal/wallet-session-read`, { body: "{}" }),
    /invalid/,
  );
});

test("rejects expired responses, oversized bodies, and signed capacity overstatement", async () => {
  const envelope = await capabilityEnvelope();
  let clockCalls = 0;
  await assert.rejects(
    queryVerifiedSolverCapability(queryOptions({
      nowSeconds: () => clockCalls++ === 0 ? NOW : NOW + 16,
      requestImpl: async (_url, options) => jsonResponse(responseFor(envelope, JSON.parse(options.body))),
    })),
    (error) => error.code === "STALE_RESPONSE",
  );

  await assert.rejects(
    queryVerifiedSolverCapability(queryOptions({
      maximumResponseBytes: 1_024,
      requestImpl: async () => jsonResponse("x".repeat(1_025)),
    })),
    (error) => error.code === "INVALID_RESPONSE",
  );

  await assert.rejects(
    queryVerifiedSolverCapability(queryOptions({
      ...evidence({ bitInventory: String(99n * 10n ** 18n) }),
      requestImpl: async (_url, options) => jsonResponse(responseFor(envelope, JSON.parse(options.body))),
    })),
    (error) => error.code === "INVALID_CAPABILITY",
  );
});

test("response digest is canonical and the signing key must match the capability", async () => {
  const envelope = await capabilityEnvelope();
  const request = buildSolverCapabilityRequest({
    challenge: `0x${"77".repeat(32)}`,
    solverId: solver.address,
    direction: "lightning-to-bit",
    requestedAt: NOW,
    expiresAt: NOW + 15,
  });
  const response = responseFor(envelope, request);
  const reordered = {
    signature: response.signature,
    expiresAt: response.expiresAt,
    servedAt: response.servedAt,
    capabilityEnvelope: response.capabilityEnvelope,
    request: response.request,
    schema: response.schema,
  };
  assert.equal(solverEndpointResponseDigest(response), solverEndpointResponseDigest(reordered));

  const otherKeys = generateKeyPairSync("ed25519");
  assert.throws(
    () => responseFor(envelope, request, { endpointPrivateKey: otherKeys.privateKey }),
    /does not match the capability/,
  );
});
