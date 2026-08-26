import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { invoiceDigest } from "../lib/lnd-rest-client.mjs";
import {
  buildPrivatePacketRequest,
  buildSignedPrivatePacketResponse,
  fetchVerifiedPrivatePacket,
  isVerifiedPrivatePacketResult,
  privatePacketRequestDigest,
  signPrivatePacketRequest,
  verifyPrivatePacketRequest,
  verifyPrivatePacketResponse,
} from "../lib/solver-private-packet.mjs";

const requesterKeys = generateKeyPairSync("ed25519");
const providerKeys = generateKeyPairSync("ed25519");
const REQUESTER_KEY_ID = "coordinator-2026-08";
const PROVIDER_KEY_ID = "packet-provider-2026-08";
const SAFETY_SECONDS = 600;

function hash(label) {
  return `0x${createHash("sha256").update(label).digest("hex")}`;
}

function settlement(label, overrides = {}) {
  const paymentRequest = `lnbcrt-private-packet-${label}`;
  return {
    settlementId: hash(`${label}:settlement`),
    reservationId: hash(`${label}:reservation`),
    direction: "bit-to-lightning",
    intentDigest: hash(`${label}:intent`),
    paymentHash: hash(`${label}:payment`),
    invoiceDigest: invoiceDigest(paymentRequest),
    quoteReceiptDigest: hash(`${label}:quote`),
    selectedSetDigest: hash(`${label}:set`),
    selectedOfferId: hash(`${label}:offer`),
    capacityEpoch: 7,
    paymentRequest,
    ...overrides,
  };
}

function requestEnvelope(value, { purpose = "SEND_PAYMENT", action = null, requestId = hash("request:1") } = {}) {
  const payload = buildPrivatePacketRequest({
    settlement: value,
    action,
    purpose,
    requestId,
    requesterKeyId: REQUESTER_KEY_ID,
    requestedAt: 1_000,
    expiresAt: 1_020,
  });
  return signPrivatePacketRequest(payload, requesterKeys.privateKey);
}

function packet(value, request, operation, overrides = {}) {
  return {
    settlementId: value.settlementId,
    reservationId: value.reservationId,
    actionId: request.payload.actionId,
    payloadDigest: request.payload.payloadDigest,
    purpose: request.payload.purpose,
    direction: value.direction,
    intentDigest: value.intentDigest,
    paymentHash: value.paymentHash,
    invoiceDigest: value.invoiceDigest,
    quoteReceiptDigest: value.quoteReceiptDigest,
    selectedSetDigest: value.selectedSetDigest,
    selectedOfferId: value.selectedOfferId,
    capacityEpoch: value.capacityEpoch,
    quoteExpiresAt: 2_000,
    lightningActionDeadline: 1_800,
    evmRefundAt: 2_500,
    operation,
    ...overrides,
  };
}

async function response(request, privatePacket, overrides = {}) {
  const {
    consumeRequest = async () => true,
    ...responseOverrides
  } = overrides;
  return buildSignedPrivatePacketResponse({
    requestEnvelope: request,
    requesterPublicKey: requesterKeys.publicKey,
    expectedRequesterKeyId: REQUESTER_KEY_ID,
    packet: privatePacket,
    providerKeyId: PROVIDER_KEY_ID,
    providerPrivateKey: providerKeys.privateKey,
    consumeRequest,
    servedAt: 1_001,
    expiresAt: 1_015,
    minimumEvmSafetySeconds: SAFETY_SECONDS,
    ...responseOverrides,
  });
}

function verify(envelope, expectedRequest) {
  return verifyPrivatePacketResponse({
    envelope,
    expectedRequestEnvelope: expectedRequest,
    providerPublicKey: providerKeys.publicKey,
    expectedProviderKeyId: PROVIDER_KEY_ID,
    now: 1_002,
    minimumEvmSafetySeconds: SAFETY_SECONDS,
  });
}

test("authenticates a fresh exact send-payment packet and private transport", async () => {
  const value = settlement("send");
  const action = { actionId: hash("send:action"), settlementId: value.settlementId, payloadDigest: hash("send:payload") };
  const request = requestEnvelope(value, { action });
  const verifiedRequest = verifyPrivatePacketRequest({
    envelope: request,
    publicKey: requesterKeys.publicKey,
    expectedKeyId: REQUESTER_KEY_ID,
    now: 1_001,
  });
  assert.equal(verifiedRequest.actionId, action.actionId);

  const signed = await response(request, packet(value, request, {
    paymentRequest: value.paymentRequest,
    feeLimitSats: "25",
    timeoutSeconds: 30,
  }));
  const verified = verify(signed, request);
  assert.equal(isVerifiedPrivatePacketResult(verified), true);
  assert.equal(isVerifiedPrivatePacketResult({ ...verified }), false);
  assert.equal(verified.packet.operation.paymentRequest, value.paymentRequest);
  assert.match(verified.responseDigest, /^0x[0-9a-f]{64}$/);

  let requestedUrl;
  const transported = await fetchVerifiedPrivatePacket({
    providerOrigin: "https://packet-provider.internal:443",
    requestEnvelope: request,
    providerPublicKey: providerKeys.publicKey,
    expectedProviderKeyId: PROVIDER_KEY_ID,
    minimumEvmSafetySeconds: SAFETY_SECONDS,
    nowSeconds: () => 1_002,
    requestImpl: async (url, options) => {
      requestedUrl = String(url);
      assert.equal(options.redirect, "error");
      assert.equal(options.headers["cache-control"], "no-store");
      assert.deepEqual(JSON.parse(options.body), request);
      return new Response(JSON.stringify(signed), {
        status: 200,
        headers: { "cache-control": "no-store", "content-type": "application/json" },
      });
    },
  });
  assert.equal(requestedUrl, "https://packet-provider.internal/v1/private-packet");
  assert.equal(transported.packet.operation.feeLimitSats, "25");
});

test("requires atomic request consumption before releasing a signed response", async () => {
  const value = settlement("consume");
  const request = requestEnvelope(value, { requestId: hash("request:consume") });
  const privatePacket = packet(value, request, {
    paymentRequest: value.paymentRequest,
    feeLimitSats: "25",
    timeoutSeconds: 30,
  });
  let consumed = false;
  let descriptor;
  const consumeRequest = async (input) => {
    descriptor = input;
    if (consumed) return false;
    consumed = true;
    return true;
  };
  const signed = await response(request, privatePacket, { consumeRequest });
  assert.equal(signed.request.payload.requestId, request.payload.requestId);
  assert.equal(Object.isFrozen(descriptor), true);
  assert.deepEqual(descriptor, {
    requesterKeyId: REQUESTER_KEY_ID,
    requestId: request.payload.requestId,
    requestDigest: privatePacketRequestDigest(request.payload),
    servedAt: 1_001,
    expiresAt: 1_020,
  });
  await assert.rejects(response(request, privatePacket, { consumeRequest }), /already consumed/);
  const nominalValue = settlement("nominal-consume");
  const nominalRequest = requestEnvelope(nominalValue);
  await assert.rejects(
    response(nominalRequest, packet(
      nominalValue,
      nominalRequest,
      { paymentRequest: nominalValue.paymentRequest, feeLimitSats: "25", timeoutSeconds: 30 },
    ), { consumeRequest: async () => ({ accepted: true }) }),
    /already consumed/,
  );

  await assert.rejects(buildSignedPrivatePacketResponse({
    requestEnvelope: request,
    requesterPublicKey: requesterKeys.publicKey,
    expectedRequesterKeyId: REQUESTER_KEY_ID,
    packet: privatePacket,
    providerKeyId: PROVIDER_KEY_ID,
    providerPrivateKey: providerKeys.privateKey,
    servedAt: 1_001,
    expiresAt: 1_015,
    minimumEvmSafetySeconds: SAFETY_SECONDS,
  }), /durable request replay consumer/);
});

test("rejects replay, changed action commitments, changed invoices, and changed signed packets", async () => {
  const value = settlement("mutation");
  const action = { actionId: hash("mutation:action"), settlementId: value.settlementId, payloadDigest: hash("mutation:payload") };
  const request = requestEnvelope(value, { action });
  const operation = { paymentRequest: value.paymentRequest, feeLimitSats: "25", timeoutSeconds: 30 };
  const signed = await response(request, packet(value, request, operation));

  const replayRequest = requestEnvelope(value, { action, requestId: hash("request:replay") });
  assert.throws(() => verify(signed, replayRequest), /changed the request/);

  const changedAction = structuredClone(request);
  changedAction.payload.actionId = hash("mutation:other-action");
  await assert.rejects(
    response(changedAction, packet(value, changedAction, operation)),
    /request signature|changed actionId/,
  );

  await assert.rejects(
    response(request, packet(value, request, { ...operation, paymentRequest: `${value.paymentRequest}-changed` })),
    /digest changed/,
  );

  const changedResponse = structuredClone(signed);
  changedResponse.packet.operation.feeLimitSats = "26";
  assert.throws(() => verify(changedResponse, request), /signature is invalid/);
});

test("binds settle-invoice preimages and ordered deadlines", async () => {
  const preimage = hash("settle:preimage");
  const paymentHash = `0x${createHash("sha256").update(Buffer.from(preimage.slice(2), "hex")).digest("hex")}`;
  const value = settlement("settle", { direction: "lightning-to-bit", paymentHash });
  const request = requestEnvelope(value, { purpose: "SETTLE_INVOICE" });
  const signed = await response(request, packet(value, request, { preimage }));
  assert.equal(verify(signed, request).packet.operation.preimage, preimage);

  await assert.rejects(
    response(request, packet(value, request, { preimage: hash("wrong-preimage") })),
    /does not match/,
  );
  await assert.rejects(
    response(request, packet(value, request, { preimage }, { lightningActionDeadline: 2_000, evmRefundAt: 2_599 })),
    /ordering is unsafe/,
  );
  await assert.rejects(
    response(request, packet(value, request, { preimage }), { expiresAt: 1_000 }),
    /authority window/,
  );
});

test("binds an EVM claim template without accepting a provider-supplied preimage", async () => {
  const value = settlement("claim");
  const request = requestEnvelope(value, { purpose: "EVM_CLAIM" });
  const operation = {
    chainId: "1",
    contract: "0x00000000000000000000000000000000000000a1",
    contractCodeHash: hash("claim:code"),
    nonce: "9",
    gasLimit: "250000",
    maxFeePerGas: "30000000000",
    maxPriorityFeePerGas: "1000000000",
    value: "0",
    quoteId: value.reservationId,
  };
  const signed = await response(request, packet(value, request, operation));
  assert.equal(verify(signed, request).packet.operation.quoteId, value.reservationId);

  await assert.rejects(
    response(request, packet(value, request, { ...operation, quoteId: hash("wrong-quote") })),
    /quote changed/,
  );
  await assert.rejects(
    response(request, packet(value, request, { ...operation, preimage: hash("provider-preimage") })),
    /fields are not exact/,
  );
  await assert.rejects(
    response(request, packet(value, request, { ...operation, value: "1" })),
    /cannot transfer/,
  );
});

test("requires private HTTPS port 443 and hides hard transport failures", async () => {
  const value = settlement("transport");
  const request = requestEnvelope(value);
  let dispatches = 0;
  const args = {
    requestEnvelope: request,
    providerPublicKey: providerKeys.publicKey,
    expectedProviderKeyId: PROVIDER_KEY_ID,
    minimumEvmSafetySeconds: SAFETY_SECONDS,
    nowSeconds: () => 1_002,
    requestImpl: async () => {
      dispatches += 1;
      throw new Error("offline");
    },
  };
  for (const providerOrigin of [
    "https://provider.example",
    "https://8.8.8.8",
    "https://user:pass@packet-provider.internal",
    "http://packet-provider.internal",
    "https://packet-provider.internal:8443",
    "https://packet-provider.internal/private",
    "https://packet-provider.internal?token=secret",
    "https://packet-provider.internal#fragment",
    "ftp://packet-provider.internal",
    "::::",
  ]) {
    await assert.rejects(
      fetchVerifiedPrivatePacket({ ...args, providerOrigin }),
      /isolated private HTTPS origin on port 443/,
    );
  }
  assert.equal(dispatches, 0);
  await assert.rejects(
    fetchVerifiedPrivatePacket({ ...args, providerOrigin: "https://packet-provider.internal" }),
    /transport failed/,
  );
  assert.equal(dispatches, 1);
});

test("bounds headers and the complete response-body read under the same deadline", async () => {
  const value = settlement("response-policy");
  const request = requestEnvelope(value);
  const signed = await response(request, packet(value, request, {
    paymentRequest: value.paymentRequest,
    feeLimitSats: "25",
    timeoutSeconds: 30,
  }));
  const args = {
    providerOrigin: "https://packet-provider.internal",
    requestEnvelope: request,
    providerPublicKey: providerKeys.publicKey,
    expectedProviderKeyId: PROVIDER_KEY_ID,
    minimumEvmSafetySeconds: SAFETY_SECONDS,
    nowSeconds: () => 1_002,
  };

  let rejectedBodyCancelled = false;
  await assert.rejects(
    fetchVerifiedPrivatePacket({
      ...args,
      requestImpl: async () => new Response(new ReadableStream({
        cancel() {
          rejectedBodyCancelled = true;
        },
      }), { status: 503 }),
    }),
    /rejected the request/,
  );
  assert.equal(rejectedBodyCancelled, true);

  await assert.rejects(
    fetchVerifiedPrivatePacket({
      ...args,
      requestImpl: async () => new Response(JSON.stringify(signed), {
        headers: { "cache-control": "no-store", "content-type": "application/jsonp" },
      }),
    }),
    /content type is invalid/,
  );
  await assert.rejects(
    fetchVerifiedPrivatePacket({
      ...args,
      requestImpl: async () => new Response(JSON.stringify(signed), {
        headers: { "content-type": "application/json" },
      }),
    }),
    /must disable storage/,
  );
  await assert.rejects(
    fetchVerifiedPrivatePacket({
      ...args,
      requestImpl: async () => new Response(JSON.stringify(signed), {
        headers: {
          "cache-control": "no-store",
          "content-length": "invalid",
          "content-type": "application/json",
        },
      }),
    }),
    /content length is invalid/,
  );
  await assert.rejects(
    fetchVerifiedPrivatePacket({
      ...args,
      requestImpl: async () => new Response(JSON.stringify(signed), {
        headers: {
          "cache-control": "no-store",
          "content-length": "65537",
          "content-type": "application/json",
        },
      }),
    }),
    /response is too large/,
  );
  const signedBytes = Buffer.byteLength(JSON.stringify(signed));
  for (const headers of [
    { "content-encoding": "gzip" },
    { "content-length": String(signedBytes), "transfer-encoding": "chunked" },
    { "content-length": String(signedBytes + 1) },
  ]) {
    await assert.rejects(
      fetchVerifiedPrivatePacket({
        ...args,
        requestImpl: async () => new Response(JSON.stringify(signed), {
          headers: {
            "cache-control": "no-store",
            "content-type": "application/json",
            ...headers,
          },
        }),
      }),
      /content encoding is invalid|framing is ambiguous|length changed/,
    );
  }
  await assert.rejects(
    fetchVerifiedPrivatePacket({
      ...args,
      requestImpl: async () => new Response(new Uint8Array(65_537), {
        headers: { "cache-control": "no-store", "content-type": "application/json" },
      }),
    }),
    /response is too large/,
  );

  const stalled = new ReadableStream({ pull: () => new Promise(() => {}) });
  const startedAt = Date.now();
  await assert.rejects(
    fetchVerifiedPrivatePacket({
      ...args,
      timeoutMs: 20,
      requestImpl: async () => new Response(stalled, {
        headers: { "cache-control": "private, no-store", "content-type": "application/json; charset=utf-8" },
      }),
    }),
    /transport failed/,
  );
  assert.ok(Date.now() - startedAt < 500, "response-body timeout must remain bounded");
});

test("refuses private packet dispatch when Node TLS verification is globally disabled", async () => {
  const value = settlement("tls-disabled");
  const request = requestEnvelope(value);
  const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  let dispatched = false;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  try {
    await assert.rejects(
      fetchVerifiedPrivatePacket({
        providerOrigin: "https://packet-provider.internal",
        requestEnvelope: request,
        providerPublicKey: providerKeys.publicKey,
        expectedProviderKeyId: PROVIDER_KEY_ID,
        minimumEvmSafetySeconds: SAFETY_SECONDS,
        requestImpl: async () => {
          dispatched = true;
          throw new Error("must not dispatch");
        },
      }),
      /TLS certificate verification is disabled/,
    );
  } finally {
    if (previous === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous;
  }
  assert.equal(dispatched, false);
});
