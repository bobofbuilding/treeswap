import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { id, Wallet } from "ethers";
import { invoiceDigest } from "../lib/lnd-rest-client.mjs";
import {
  assertSelectedSolverFinalizationClientLifecycle,
  buildSignedSelectedSolverFinalizationResponse,
  createSelectedSolverFinalizationClient,
  createTestSelectedSolverFinalizationClient,
  SelectedSolverFinalizationError,
  selectedSolverFinalizationClientMode,
  verifySelectedSolverFinalizationRequest,
} from "../lib/selected-solver-finalization-transport.mjs";
import {
  SOLVER_CAPABILITY_TYPES,
  solverCapabilityClaimsDigest,
  solverCapabilityDomain,
  solverCapabilityProofMessage,
  solverEndpointOriginDigest,
  solverEndpointPublicKeyDigest,
  solverLightningNodePubkeyDigest,
  verifySolverCapability,
} from "../lib/solver-capability.mjs";

const NOW = 2_100_000_000;
const ORIGIN = "https://solver.example";
const CONTRACT = "0x1111111111111111111111111111111111111111";
const OTHER_CONTRACT = "0x2222222222222222222222222222222222222222";
const CODE_HASH = id("selected-finalization-runtime");
const OTHER_CODE_HASH = id("selected-finalization-other-runtime");
const NODE_PUBKEY = `02${"44".repeat(32)}`;
const solver = new Wallet(`0x${"51".repeat(32)}`);
const endpointKeys = generateKeyPairSync("ed25519");
const requesterKeys = generateKeyPairSync("ed25519");
const otherKeys = generateKeyPairSync("ed25519");
const endpointPublicKey = endpointKeys.publicKey.export({ format: "pem", type: "spki" }).toString();
const requesterPublicKey = requesterKeys.publicKey.export({ format: "pem", type: "spki" }).toString();
const requesterPublicKeyDigest = solverEndpointPublicKeyDigest(requesterPublicKey);
const policy = {
  chainId: "1",
  lightningToBitContract: CONTRACT,
  bitToLightningContract: OTHER_CONTRACT,
  lightningToBitContractCodeHash: CODE_HASH,
  bitToLightningContractCodeHash: OTHER_CODE_HASH,
  maxCapabilityTtlSeconds: 120,
  maxCapacityObservationAgeSeconds: 30,
  maxClockSkewSeconds: 5,
};

async function capabilityVerification(direction = "lightning-to-bit") {
  const verifyingContract = direction === "lightning-to-bit" ? CONTRACT : OTHER_CONTRACT;
  const declaration = {
    capabilityId: id(`selected-finalization-capability:${direction}`),
    direction: id(direction),
    solver: solver.address,
    lightningNodePubkeyDigest: solverLightningNodePubkeyDigest(NODE_PUBKEY),
    endpointPublicKeyDigest: solverEndpointPublicKeyDigest(endpointPublicKey),
    endpointOriginDigest: solverEndpointOriginDigest(ORIGIN),
    availableBitWei: direction === "lightning-to-bit" ? String(100n * 10n ** 18n) : "0",
    availableLightningSats: "250000",
    capacityEpoch: "7",
    issuedAt: NOW,
    expiresAt: NOW + 60,
  };
  declaration.proofChallenge = solverCapabilityClaimsDigest(declaration, {
    chainId: policy.chainId,
    verifyingContract,
  });
  const proof = solverCapabilityProofMessage(declaration.proofChallenge);
  const envelope = {
    declaration,
    endpointOrigin: ORIGIN,
    endpointPublicKey,
    endpointSignature: sign(null, proof, endpointKeys.privateKey).toString("base64"),
    evmSignature: await solver.signTypedData(
      solverCapabilityDomain({ chainId: policy.chainId, verifyingContract }),
      SOLVER_CAPABILITY_TYPES,
      declaration,
    ),
    lightningNodePubkey: NODE_PUBKEY,
    lightningSignature: "z".repeat(104),
  };
  const result = await verifySolverCapability({
    envelope,
    now: NOW,
    policy,
    verifyLightningNodeSignature: async () => ({ valid: true, pubkey: NODE_PUBKEY }),
    readVerifiedBitInventory: async () => ({
      solverId: solver.address,
      availableBitWei: declaration.availableBitWei,
      observedAt: NOW,
    }),
    readVerifiedLightningCapacity: async () => ({
      nodePubkey: NODE_PUBKEY,
      availableLightningSats: declaration.availableLightningSats,
      capacityEpoch: declaration.capacityEpoch,
      observedAt: NOW,
    }),
  });
  assert.equal(result.valid, true);
  return result;
}

function disclosure(overrides = {}) {
  return {
    requestId: id("private selected request"),
    pricingCommitment: id("private pricing commitment"),
    direction: "lightning-to-bit",
    chainId: "1",
    verifyingContract: CONTRACT,
    user: "0x3333333333333333333333333333333333333333",
    beneficiary: "0x4444444444444444444444444444444444444444",
    paymentHash: `0x${"0".repeat(64)}`,
    invoiceDigest: `0x${"0".repeat(64)}`,
    invoice: "",
    selectedSolver: solver.address,
    selectedOfferId: id("selected blind offer"),
    requestNonce: "9",
    exactBitOutputWei: String(4n * 10n ** 18n),
    exactLightningOutputSats: "400",
    maxFeeBps: "500",
    maxRoutingFeeSats: "10",
    expiresAt: NOW + 45,
    ...overrides,
  };
}

function executable(invoice = "lnbc4u1selectedsolverinvoice") {
  return {
    invoice,
    envelope: {
      offer: {
        invoiceDigest: invoiceDigest(invoice),
        paymentHash: id("selected solver payment hash"),
      },
      signature: `0x${"11".repeat(65)}`,
    },
  };
}

function jsonResponse(value, options = {}) {
  return new Response(JSON.stringify(value), {
    status: options.status ?? 200,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json",
      ...options.headers,
    },
  });
}

function providerAuthority(request, overrides = {}) {
  return {
    requesterPublicKeyDigest,
    capabilityDigest: request.capabilityDigest,
    endpointPublicKeyDigest: solverEndpointPublicKeyDigest(endpointPublicKey),
    solverId: solver.address,
    direction: request.direction,
    ...overrides,
  };
}

async function responseFor(rawRequest, overrides = {}) {
  const request = verifySelectedSolverFinalizationRequest({
    request: rawRequest,
    authority: providerAuthority(rawRequest),
    now: NOW,
  });
  const value = executable();
  return buildSignedSelectedSolverFinalizationResponse({
    request,
    invoice: value.invoice,
    envelope: value.envelope,
    servedAt: NOW,
    expiresAt: NOW + 10,
    endpointPrivateKey: endpointKeys.privateKey,
    ...overrides,
  });
}

async function preparedClient(requestImpl, options = {}) {
  const controller = new AbortController();
  const capability = await capabilityVerification(options.direction);
  const client = createTestSelectedSolverFinalizationClient({
    requesterPrivateKey: requesterKeys.privateKey,
    signal: controller.signal,
    nowSeconds: () => NOW,
    requestImpl,
  });
  const attempt = client.prepare({
    capabilityVerification: capability,
    disclosure: options.disclosure ?? disclosure(),
    requestTtlSeconds: 15,
  });
  return { attempt, capability, client, controller };
}

test("authenticates one exact private finalization request and capability-bound response", async () => {
  let observedUrl;
  let observedOptions;
  const prepared = await preparedClient(async (url, options) => {
    observedUrl = url;
    observedOptions = options;
    return jsonResponse(await responseFor(JSON.parse(options.body)));
  });
  const result = await prepared.client.send(prepared.attempt);
  assert.equal(observedUrl.href, `${ORIGIN}/v1/finalize`);
  assert.equal(observedOptions.method, "POST");
  assert.equal(observedOptions.redirect, "error");
  assert.equal(observedOptions.headers["cache-control"], "no-store");
  assert.equal(observedOptions.headers["referrer-policy"], "no-referrer");
  assert.equal(result.solverId, solver.address.toLowerCase());
  assert.equal(result.invoice, executable().invoice);
  assert.equal(result.channel.authenticated, true);
  assert.equal(result.channel.encrypted, true);
  assert.equal(result.channel.peer, solver.address.toLowerCase());
  assert.equal(result.fundingAuthorization, false);
  assert.equal(selectedSolverFinalizationClientMode(prepared.client), "injected-test");
  prepared.controller.abort();
  assert.equal(prepared.client.status().state, "stopped");
});

test("retries one byte-identical signed request after ambiguous transport and caches one response", async () => {
  const bodies = [];
  let calls = 0;
  const prepared = await preparedClient(async (_url, options) => {
    calls += 1;
    bodies.push(options.body);
    if (calls === 1) throw new Error("lost after dispatch");
    return jsonResponse(await responseFor(JSON.parse(options.body)));
  });
  await assert.rejects(
    prepared.client.send(prepared.attempt),
    (error) => error instanceof SelectedSolverFinalizationError
      && error.code === "TRANSPORT_AMBIGUOUS" && error.ambiguous === true,
  );
  const first = await prepared.client.send(prepared.attempt);
  const replay = await prepared.client.send(prepared.attempt);
  assert.equal(first, replay);
  assert.equal(calls, 2);
  assert.equal(bodies[0], bodies[1]);
});

test("binds BIT-to-Lightning to the user's existing invoice", async () => {
  const userInvoice = "lnbc4u1userprovidedinvoice";
  const privateRequest = disclosure({
    direction: "bit-to-lightning",
    verifyingContract: OTHER_CONTRACT,
    invoice: `lightning:${userInvoice.toUpperCase()}`,
    invoiceDigest: invoiceDigest(userInvoice),
    paymentHash: id("user invoice payment hash"),
  });
  const prepared = await preparedClient(async (_url, options) => {
    const request = verifySelectedSolverFinalizationRequest({
      request: JSON.parse(options.body),
      authority: providerAuthority(JSON.parse(options.body)),
      now: NOW,
    });
    return jsonResponse(buildSignedSelectedSolverFinalizationResponse({
      request,
      invoice: userInvoice,
      envelope: {
        offer: { invoiceDigest: invoiceDigest(userInvoice), paymentHash: privateRequest.paymentHash },
        signature: `0x${"22".repeat(65)}`,
      },
      servedAt: NOW,
      expiresAt: NOW + 10,
      endpointPrivateKey: endpointKeys.privateKey,
    }));
  }, { direction: "bit-to-lightning", disclosure: privateRequest });
  const result = await prepared.client.send(prepared.attempt);
  assert.equal(result.invoice, userInvoice);
});

test("rejects request mutation, unknown requester keys, stale requests, and wrong endpoint response keys", async () => {
  let captured;
  const prepared = await preparedClient(async (_url, options) => {
    captured = JSON.parse(options.body);
    return jsonResponse(await responseFor(captured));
  });
  await prepared.client.send(prepared.attempt);
  assert.throws(() => verifySelectedSolverFinalizationRequest({
    request: { ...captured, disclosure: { ...captured.disclosure, beneficiary: CONTRACT } },
    authority: providerAuthority(captured),
    now: NOW,
  }), /digest changed/);
  assert.throws(() => verifySelectedSolverFinalizationRequest({
    request: captured,
    authority: providerAuthority(captured, {
      requesterPublicKeyDigest: solverEndpointPublicKeyDigest(
        otherKeys.publicKey.export({ format: "pem", type: "spki" }).toString(),
      ),
    }),
    now: NOW,
  }), /not allowlisted/);
  assert.throws(() => verifySelectedSolverFinalizationRequest({
    request: captured,
    authority: providerAuthority(captured, { capabilityDigest: id("retired provider capability") }),
    now: NOW,
  }), /provider authority/);
  assert.throws(() => verifySelectedSolverFinalizationRequest({
    request: captured,
    authority: providerAuthority(captured),
    now: NOW + 20,
  }), /time window/);
  const verified = verifySelectedSolverFinalizationRequest({
    request: captured,
    authority: providerAuthority(captured),
    now: NOW,
  });
  assert.throws(() => buildSignedSelectedSolverFinalizationResponse({
    request: verified,
    ...executable(),
    servedAt: NOW,
    expiresAt: NOW + 10,
    endpointPrivateKey: otherKeys.privateKey,
  }), /does not match/);
  assert.throws(() => buildSignedSelectedSolverFinalizationResponse({
    request: { ...verified },
    ...executable(),
    servedAt: NOW,
    expiresAt: NOW + 10,
    endpointPrivateKey: endpointKeys.privateKey,
  }), /original verified/);
});

test("rejects changed authority, signatures, invoice bindings, framing, and stale responses", async () => {
  const mutations = [
    async (response) => ({ ...response, solverId: CONTRACT }),
    async (response) => ({ ...response, capabilityDigest: id("other capability") }),
    async (response) => ({ ...response, signature: `${response.signature.slice(0, -4)}AAAA` }),
    async (response) => ({ ...response, invoice: "lnbc1changedinvoice" }),
    async (response) => ({ ...response, expiresAt: NOW + 16 }),
  ];
  for (const mutate of mutations) {
    const prepared = await preparedClient(async (_url, options) => {
      const response = await responseFor(JSON.parse(options.body));
      return jsonResponse(await mutate(response));
    });
    await assert.rejects(prepared.client.send(prepared.attempt), SelectedSolverFinalizationError);
  }
  const cacheable = await preparedClient(async (_url, options) => jsonResponse(
    await responseFor(JSON.parse(options.body)),
    { headers: { "cache-control": "public" } },
  ));
  await assert.rejects(
    cacheable.client.send(cacheable.attempt),
    (error) => error.code === "INVALID_RESPONSE",
  );
});

test("keeps injected transport and clock out of the production constructor", () => {
  const controller = new AbortController();
  assert.throws(() => createSelectedSolverFinalizationClient({
    requesterPrivateKey: requesterKeys.privateKey,
    signal: controller.signal,
    requestImpl: async () => {},
  }), /fields are (?:not exact|outside policy)/);
  const production = createSelectedSolverFinalizationClient({
    requesterPrivateKey: requesterKeys.privateKey,
    signal: controller.signal,
  });
  assert.equal(selectedSolverFinalizationClientMode(production), "production");
  assert.equal(assertSelectedSolverFinalizationClientLifecycle(production, controller.signal), production);
  assert.throws(() => assertSelectedSolverFinalizationClientLifecycle(
    production,
    new AbortController().signal,
  ), /share one active deployment lifecycle/);
});
