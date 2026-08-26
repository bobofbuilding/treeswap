import assert from "node:assert/strict";
import { createSecretKey } from "node:crypto";
import {
  chmod,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { id } from "ethers";
import {
  LndRestError,
} from "../lib/lnd-rest-client.mjs";
import {
  SelectedSolverInvoiceMaterialError,
  createSelectedSolverInvoiceMaterialService,
  createTestSelectedSolverInvoiceMaterialNode,
  createTestSelectedSolverInvoiceMaterialService,
  loadSelectedSolverPaymentSecretKey,
  resolveSelectedSolverInvoiceMaterial,
  selectedSolverInvoiceMaterialBinding,
} from "../lib/selected-solver-invoice-material.mjs";

const POLICY = Object.freeze({
  addTimeoutMs: 1_000,
  lookupTimeoutMs: 500,
  invoiceExpirySeconds: 3_600,
  cltvExpiry: 80,
  maximumInvoiceBytes: 4_096,
});
const MEMO = "TreeSwap selected solver hold invoice";
const SECRET_KEY_ID = "solver-payment-secret-1";
const SECRET_KEY = createSecretKey(Buffer.alloc(32, 0x5a));

function request(overrides = {}) {
  return {
    requestId: id("invoice-material-request"),
    requestDigest: id("invoice-material-request-digest"),
    capabilityDigest: id("invoice-material-capability"),
    selectedOfferId: id("invoice-material-offer"),
    amountSats: "400",
    ...overrides,
  };
}

function notFound() {
  return new LndRestError("invoice not found", { grpcCode: 5, ambiguous: false });
}

function invoiceRecord({ paymentHash, amountSats = "400", state = "OPEN", overrides = {} }) {
  const paymentRequest = `lnbcrt1treeswap${paymentHash.slice(2)}`;
  return {
    r_hash: Buffer.from(paymentHash.slice(2), "hex").toString("base64"),
    r_preimage: Buffer.alloc(32).toString("base64"),
    payment_request: paymentRequest,
    payment_addr: Buffer.alloc(32, 0x33).toString("base64"),
    value: amountSats,
    expiry: String(POLICY.invoiceExpirySeconds),
    cltv_expiry: String(POLICY.cltvExpiry),
    memo: MEMO,
    state,
    private: true,
    is_amp: false,
    is_keysend: false,
    is_blinded: false,
    settled: false,
    add_index: "1",
    ...overrides,
  };
}

function memoryNode(options = {}) {
  const invoices = options.invoices ?? new Map();
  const calls = { add: 0, lookup: 0 };
  const node = createTestSelectedSolverInvoiceMaterialNode({
    lookupInvoice: options.lookupInvoice ?? (async (paymentHash) => {
      calls.lookup += 1;
      const invoice = invoices.get(paymentHash);
      if (!invoice) throw notFound();
      return invoice;
    }),
    addHoldInvoice: options.addHoldInvoice ?? (async (input) => {
      calls.add += 1;
      assert.equal(input.isPrivate, true);
      if (invoices.has(input.paymentHash)) {
        throw new LndRestError("already exists", { grpcCode: 6, ambiguous: false });
      }
      const invoice = invoiceRecord({ paymentHash: input.paymentHash, amountSats: input.amountSats });
      invoices.set(input.paymentHash, invoice);
      return { payment_request: invoice.payment_request, add_index: invoice.add_index };
    }),
  });
  return { calls, invoices, node };
}

function service(node, overrides = {}) {
  return createTestSelectedSolverInvoiceMaterialService({
    invoiceNode: node,
    memo: MEMO,
    paymentSecretKey: SECRET_KEY,
    paymentSecretKeyId: SECRET_KEY_ID,
    policy: POLICY,
    ...overrides,
  });
}

function options(recovery = false, signal = new AbortController().signal) {
  return { recovery, signal };
}

test("derives one stable payment hash and confirms the created hold invoice through lookup", async () => {
  const fixture = memoryNode();
  const resolver = service(fixture.node);
  const material = await resolveSelectedSolverInvoiceMaterial(
    resolver,
    request(),
    options(false),
  );
  assert.equal(fixture.calls.add, 1);
  assert.equal(fixture.calls.lookup, 2);
  assert.match(material.paymentHash, /^0x[0-9a-f]{64}$/);
  assert.equal(
    material.paymentHash,
    "0xd5a3bad6d10a2e8455516c4dc452c3ad9109c2b3ca1a68e0df56e744eaada3f0",
  );
  assert.equal(material.invoice, fixture.invoices.get(material.paymentHash).payment_request);
  assert.equal(material.amountSats, "400");
  assert.equal(material.invoiceState, "OPEN");
  assert.equal(material.paymentSecretKeyId, SECRET_KEY_ID);
  assert.equal(material.exposesPreimage, undefined);
  assert.equal("preimage" in material, false);
  assert.equal(material.fundingAuthorization, false);
  assert.equal(material.settlementAuthorization, false);
  assert.equal(selectedSolverInvoiceMaterialBinding(material), material);
  assert.equal(Object.isFrozen(material), true);
  assert.throws(
    () => selectedSolverInvoiceMaterialBinding({ ...material }),
    /provenance is invalid/,
  );
  const status = resolver.status();
  assert.equal(status.exposesPreimage, false);
  assert.equal(status.exposesLndCredential, false);
  assert.equal(status.inFlightRequests, 0);
  assert.doesNotMatch(
    JSON.stringify(status),
    new RegExp(`${request().requestId.slice(2)}|${SECRET_KEY_ID}`, "i"),
  );
});

test("restarts with the same key and recovers the exact invoice without another add", async () => {
  const fixture = memoryNode();
  const first = await resolveSelectedSolverInvoiceMaterial(service(fixture.node), request(), options(false));
  const restarted = service(fixture.node);
  const recovered = await resolveSelectedSolverInvoiceMaterial(restarted, request(), options(true));
  assert.equal(recovered.paymentHash, first.paymentHash);
  assert.equal(recovered.invoice, first.invoice);
  assert.equal(fixture.calls.add, 1);
  assert.equal(fixture.calls.lookup, 3);

  for (const changed of [
    { requestId: id("changed request ID") },
    { requestDigest: id("changed request digest") },
    { capabilityDigest: id("changed capability digest") },
    { selectedOfferId: id("changed selected offer") },
    { amountSats: "401" },
  ]) {
    const differentRequest = await resolveSelectedSolverInvoiceMaterial(
      restarted,
      request(changed),
      options(false),
    );
    assert.notEqual(differentRequest.paymentHash, first.paymentHash);
  }
  const differentKey = await resolveSelectedSolverInvoiceMaterial(
    service(fixture.node, {
      paymentSecretKey: createSecretKey(Buffer.alloc(32, 0x6b)),
      paymentSecretKeyId: "solver-payment-secret-2",
    }),
    request(),
    options(false),
  );
  assert.notEqual(differentKey.paymentHash, first.paymentHash);
  const sameIdDifferentKey = await resolveSelectedSolverInvoiceMaterial(
    service(fixture.node, {
      paymentSecretKey: createSecretKey(Buffer.alloc(32, 0x7c)),
    }),
    request(),
    options(false),
  );
  assert.notEqual(sameIdDifferentKey.paymentHash, first.paymentHash);
});

test("coalesces concurrent exact resolution before contacting LND twice", async () => {
  const invoices = new Map();
  let release;
  let entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  let lookups = 0;
  let adds = 0;
  const node = createTestSelectedSolverInvoiceMaterialNode({
    lookupInvoice: async (paymentHash) => {
      lookups += 1;
      if (lookups === 1) {
        entered();
        await gate;
      }
      const invoice = invoices.get(paymentHash);
      if (!invoice) throw notFound();
      return invoice;
    },
    addHoldInvoice: async (input) => {
      adds += 1;
      const invoice = invoiceRecord({ paymentHash: input.paymentHash });
      invoices.set(input.paymentHash, invoice);
      return { payment_request: invoice.payment_request, add_index: "1" };
    },
  });
  const resolver = service(node);
  const first = resolveSelectedSolverInvoiceMaterial(resolver, request(), options(false));
  await started;
  const second = resolveSelectedSolverInvoiceMaterial(resolver, request(), options(true));
  assert.equal(resolver.status().inFlightRequests, 1);
  release();
  const [left, right] = await Promise.all([first, second]);
  assert.equal(left, right);
  assert.equal(adds, 1);
  assert.equal(lookups, 2);
});

test("recovers after an ambiguous or duplicate add by looking up the same payment hash", async () => {
  for (const addError of [
    new LndRestError("transport lost", { ambiguous: true }),
    new LndRestError("already exists", { grpcCode: 6, ambiguous: false }),
  ]) {
    const invoices = new Map();
    let adds = 0;
    const node = createTestSelectedSolverInvoiceMaterialNode({
      lookupInvoice: async (paymentHash) => {
        const invoice = invoices.get(paymentHash);
        if (!invoice) throw notFound();
        return invoice;
      },
      addHoldInvoice: async (input) => {
        adds += 1;
        invoices.set(input.paymentHash, invoiceRecord({ paymentHash: input.paymentHash }));
        throw addError;
      },
    });
    const material = await resolveSelectedSolverInvoiceMaterial(service(node), request(), options(true));
    assert.equal(adds, 1);
    assert.equal(material.invoice, invoices.get(material.paymentHash).payment_request);
  }
});

test("marks an unresolved add as ambiguous and later recovery may create the exact invoice", async () => {
  const invoices = new Map();
  let failFirstAdd = true;
  let adds = 0;
  const node = createTestSelectedSolverInvoiceMaterialNode({
    lookupInvoice: async (paymentHash) => {
      const invoice = invoices.get(paymentHash);
      if (!invoice) throw notFound();
      return invoice;
    },
    addHoldInvoice: async (input) => {
      adds += 1;
      if (failFirstAdd) {
        failFirstAdd = false;
        throw new LndRestError("transport lost", { ambiguous: true });
      }
      const invoice = invoiceRecord({ paymentHash: input.paymentHash });
      invoices.set(input.paymentHash, invoice);
      return { payment_request: invoice.payment_request, add_index: "1" };
    },
  });
  const resolver = service(node);
  await assert.rejects(
    resolveSelectedSolverInvoiceMaterial(resolver, request(), options(false)),
    (error) => error instanceof SelectedSolverInvoiceMaterialError
      && error.ambiguous === true && error.code === "LND_CREATE_AMBIGUOUS",
  );
  const recovered = await resolveSelectedSolverInvoiceMaterial(resolver, request(), options(true));
  assert.equal(adds, 2);
  assert.equal(recovered.paymentHash, [...invoices.keys()][0]);
});

test("never treats an ambiguous not-found observation as permission to create", async () => {
  let adds = 0;
  const node = createTestSelectedSolverInvoiceMaterialNode({
    lookupInvoice: async () => {
      throw new LndRestError("ambiguous lookup", { grpcCode: 5, ambiguous: true });
    },
    addHoldInvoice: async () => { adds += 1; },
  });
  await assert.rejects(
    resolveSelectedSolverInvoiceMaterial(service(node), request(), options(false)),
    (error) => error instanceof LndRestError
      && error.grpcCode === 5 && error.ambiguous === true,
  );
  assert.equal(adds, 0);
});

test("accepts only the pinned LND REST missing-invoice error as an idempotent-create candidate", async () => {
  for (const lookupError of [
    new LndRestError("pinned missing invoice", {
      httpStatus: 500,
      grpcCode: 2,
      ambiguous: false,
      reason: "invoice-not-found",
    }),
    notFound(),
  ]) {
    const invoices = new Map();
    let firstLookup = true;
    let adds = 0;
    const node = createTestSelectedSolverInvoiceMaterialNode({
      lookupInvoice: async (paymentHash) => {
        if (firstLookup) {
          firstLookup = false;
          throw lookupError;
        }
        return invoices.get(paymentHash);
      },
      addHoldInvoice: async (input) => {
        adds += 1;
        const invoice = invoiceRecord({ paymentHash: input.paymentHash });
        invoices.set(input.paymentHash, invoice);
        return { payment_request: invoice.payment_request, add_index: invoice.add_index };
      },
    });
    await resolveSelectedSolverInvoiceMaterial(service(node), request(), options(false));
    assert.equal(adds, 1);
  }

  for (const changed of [
    new LndRestError("wrong HTTP status", { httpStatus: 502, grpcCode: 2, ambiguous: false }),
    new LndRestError("wrong gRPC code", { httpStatus: 500, grpcCode: 13, ambiguous: false }),
    new LndRestError("ambiguous", { httpStatus: 500, grpcCode: 2, ambiguous: true }),
    new LndRestError("unclassified code two", { httpStatus: 500, grpcCode: 2, ambiguous: false }),
  ]) {
    let adds = 0;
    const node = createTestSelectedSolverInvoiceMaterialNode({
      lookupInvoice: async () => { throw changed; },
      addHoldInvoice: async () => { adds += 1; },
    });
    await assert.rejects(resolveSelectedSolverInvoiceMaterial(
      service(node),
      request(),
      options(false),
    ));
    assert.equal(adds, 0);
  }
});

test("rejects conflicting existing invoice fields and never replaces that payment hash", async () => {
  const mutations = [
    (record) => ({ ...record, value: "401" }),
    (record) => ({ ...record, expiry: "86399" }),
    (record) => ({ ...record, cltv_expiry: "2015" }),
    (record) => ({ ...record, memo: "other" }),
    (record) => ({ ...record, state: "CANCELED" }),
    (record) => ({ ...record, is_amp: true }),
    (record) => ({ ...record, is_keysend: true }),
    (record) => ({ ...record, is_blinded: true }),
    (record) => ({ ...record, settled: true }),
    (record) => ({ ...record, r_preimage: Buffer.alloc(32, 1).toString("base64") }),
    (record) => ({ ...record, payment_addr: Buffer.alloc(32).toString("base64") }),
    (record) => ({ ...record, r_hash: Buffer.alloc(32, 1).toString("base64") }),
    (record) => ({ ...record, payment_request: "not-an-invoice" }),
  ];
  for (const mutate of mutations) {
    let adds = 0;
    const node = createTestSelectedSolverInvoiceMaterialNode({
      lookupInvoice: async (paymentHash) => mutate(invoiceRecord({ paymentHash })),
      addHoldInvoice: async () => { adds += 1; },
    });
    await assert.rejects(resolveSelectedSolverInvoiceMaterial(service(node), request(), options(false)));
    assert.equal(adds, 0);
  }
});

test("treats abort after add as ambiguous and exact recovery returns the existing invoice", async () => {
  const controller = new AbortController();
  const invoices = new Map();
  const node = createTestSelectedSolverInvoiceMaterialNode({
    lookupInvoice: async (paymentHash) => {
      const invoice = invoices.get(paymentHash);
      if (!invoice) throw notFound();
      return invoice;
    },
    addHoldInvoice: async (input) => {
      const invoice = invoiceRecord({ paymentHash: input.paymentHash });
      invoices.set(input.paymentHash, invoice);
      controller.abort();
      return { payment_request: invoice.payment_request, add_index: "1" };
    },
  });
  const resolver = service(node);
  await assert.rejects(
    resolveSelectedSolverInvoiceMaterial(resolver, request(), options(false, controller.signal)),
    (error) => error instanceof SelectedSolverInvoiceMaterialError
      && error.code === "ABORTED_AFTER_ADD" && error.ambiguous === true,
  );
  const recovered = await resolveSelectedSolverInvoiceMaterial(resolver, request(), options(true));
  assert.equal(recovered.paymentHash, [...invoices.keys()][0]);
});

test("keeps injected nodes and services provenance-bound and production requires LND", async () => {
  const fixture = memoryNode();
  assert.throws(() => createTestSelectedSolverInvoiceMaterialService({
    invoiceNode: { ...fixture.node },
    memo: MEMO,
    paymentSecretKey: SECRET_KEY,
    paymentSecretKeyId: SECRET_KEY_ID,
    policy: POLICY,
  }), /concrete test node/);
  assert.throws(() => createSelectedSolverInvoiceMaterialService({
    lndClient: {},
    memo: MEMO,
    paymentSecretKey: SECRET_KEY,
    paymentSecretKeyId: SECRET_KEY_ID,
    policy: POLICY,
  }), /requires an LND REST client/);
  const resolver = service(fixture.node);
  await assert.rejects(
    resolveSelectedSolverInvoiceMaterial({ ...resolver }, request(), options(false)),
    /service provenance is invalid/,
  );
  assert.throws(() => service(fixture.node, {
    paymentSecretKey: createSecretKey(Buffer.alloc(16, 1)),
  }), /32-byte-or-larger/);
  let keyGetterCalls = 0;
  const fakeKey = {};
  Object.defineProperty(fakeKey, "type", {
    get() {
      keyGetterCalls += 1;
      return "secret";
    },
  });
  assert.throws(() => service(fixture.node, {
    paymentSecretKey: fakeKey,
  }), /32-byte-or-larger/);
  assert.equal(keyGetterCalls, 0);
  assert.throws(() => service(fixture.node, {
    policy: { ...POLICY, invoiceExpirySeconds: 10 },
  }), /between 3600 and 10800/);
  assert.throws(() => resolver.status("input"), /accepts no input/);
});

test("rejects noncanonical or out-of-range request scalars before LND", async () => {
  const fixture = memoryNode();
  const resolver = service(fixture.node);
  for (const amountSats of ["0", "01", "9223372036854775808", 400, -1]) {
    await assert.rejects(
      resolveSelectedSolverInvoiceMaterial(
        resolver,
        request({ amountSats }),
        options(false),
      ),
    );
  }
  assert.equal(fixture.calls.lookup, 0);
  assert.equal(fixture.calls.add, 0);
});

test("rejects decorated requests and options without executing accessors", async () => {
  const fixture = memoryNode();
  const resolver = service(fixture.node);
  let getterCalls = 0;
  const hostile = { ...request() };
  Object.defineProperty(hostile, "amountSats", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "400";
    },
  });
  await assert.rejects(
    resolveSelectedSolverInvoiceMaterial(resolver, hostile, options(false)),
    /enumerable data properties/,
  );
  assert.equal(getterCalls, 0);
  let coercionCalls = 0;
  await assert.rejects(resolveSelectedSolverInvoiceMaterial(
    resolver,
    request({
      requestId: {
        toString() {
          coercionCalls += 1;
          return request().requestId;
        },
      },
    }),
    options(false),
  ), /nonzero lowercase bytes32/);
  assert.equal(coercionCalls, 0);
  const decorated = options(false);
  Object.defineProperty(decorated, "extra", { enumerable: false, value: true });
  await assert.rejects(
    resolveSelectedSolverInvoiceMaterial(resolver, request(), decorated),
    /fields are not exact/,
  );
  assert.equal(fixture.calls.lookup, 0);
  assert.equal(fixture.calls.add, 0);
});

test("loads only one private owner-controlled 32-byte payment-secret key file", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "treeswap-invoice-secret-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o700);
  const path = join(root, "payment-secret.bin");
  await writeFile(path, Buffer.alloc(32, 0xa4), { mode: 0o600 });
  const loaded = await loadSelectedSolverPaymentSecretKey(path);
  assert.equal(loaded.type, "secret");
  assert.equal(loaded.symmetricKeySize, 32);

  await chmod(path, 0o644);
  await assert.rejects(loadSelectedSolverPaymentSecretKey(path), /file is unsafe/);
  await chmod(path, 0o600);
  const link = join(root, "payment-secret-link.bin");
  await symlink(path, link);
  await assert.rejects(loadSelectedSolverPaymentSecretKey(link));
  await assert.rejects(loadSelectedSolverPaymentSecretKey("relative.bin"), /bounded absolute path/);
  await writeFile(path, Buffer.alloc(31, 0xa4), { mode: 0o600 });
  await assert.rejects(loadSelectedSolverPaymentSecretKey(path), /file is unsafe/);
});
