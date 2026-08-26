import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { id } from "ethers";
import {
  RFQ_QUOTE_INGRESS_STORE_SCHEMA,
  RfqQuoteIngressStore,
  isRfqQuoteIngressStore,
  rfqQuoteIngressSelectionBinding,
  rfqQuoteIngressStoreBinding,
} from "../lib/rfq-quote-ingress-store.mjs";

const NOW = 2_000_000_000;
const IDENTITY = "0x1111111111111111111111111111111111111111";
const KEY = Buffer.alloc(32, 17);
const POLICY_DIGEST = id("RFQ quote ingress store policy").toLowerCase();

function config(path, overrides = {}) {
  return {
    allowMemory: false,
    identityKey: KEY,
    initialize: true,
    maximumActiveSessionsPerIdentity: 2,
    maximumLiveRequests: 8,
    maximumRequestLifetimeSeconds: 120,
    maximumRequestsPerIdentityWindow: 3,
    maximumRequestsPerWindowGlobal: 6,
    path,
    policyDigest: POLICY_DIGEST,
    quotaWindowSeconds: 600,
    ...overrides,
  };
}

function claim(label, nonce, overrides = {}) {
  return {
    authorizationDigest: id(`authorization:${label}`).toLowerCase(),
    expiresAt: NOW + 90,
    identity: IDENTITY,
    now: NOW,
    requestDigest: id(`request-digest:${label}`).toLowerCase(),
    requestId: id(`request:${label}`).toLowerCase(),
    requestNonce: String(nonce),
    ...overrides,
  };
}

async function storeFixture(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), "treeswap-quote-ingress-store-"));
  const path = join(directory, "ingress.sqlite");
  const store = await RfqQuoteIngressStore.open(config(path, overrides));
  t.after(async () => {
    try { store.close(); } catch {}
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, path, store };
}

test("persists opaque one-use quote sessions across restart", async (t) => {
  const { path, store } = await storeFixture(t);
  assert.equal(isRfqQuoteIngressStore(store), true);
  assert.equal(rfqQuoteIngressStoreBinding(store).policyDigest, POLICY_DIGEST);
  const requestClaim = store.claim(claim("first", 1));
  assert.equal(requestClaim.schema, RFQ_QUOTE_INGRESS_STORE_SCHEMA);
  assert.equal(store.claim(claim("first", 1)), null);
  assert.equal(store.claim(claim("nonce-collision", 1)), null);

  const sessionToken = id("opaque-session-token").toLowerCase();
  const ready = store.ready(requestClaim, {
    expiresAt: NOW + 60,
    now: NOW + 1,
    sessionToken,
  });
  assert.equal(ready.status, "session-ready");
  assert.notEqual(ready.sessionDigest, sessionToken);
  const selectionClaim = store.claimSelection({ now: NOW + 2, sessionToken });
  assert.equal(selectionClaim.status, "selection-claimed");
  assert.equal(rfqQuoteIngressSelectionBinding(selectionClaim).store, store);
  assert.equal(rfqQuoteIngressSelectionBinding(selectionClaim).sessionDigest, ready.sessionDigest);
  assert.equal(store.claimSelection({ now: NOW + 2, sessionToken }), null);
  assert.deepEqual(store.status({ now: NOW + 2 }), {
    schema: RFQ_QUOTE_INGRESS_STORE_SCHEMA,
    status: "healthy-private-quote-ingress-store",
    liveClaimedRequests: 0,
    liveReadySessions: 0,
    selectedSessions: 1,
    expiredRequestsAwaitingCleanup: 0,
    maximumLiveRequests: 8,
    fundingAuthorization: false,
    settlementAuthorization: false,
    networkListener: false,
  });

  const database = new DatabaseSync(path);
  const stored = database.prepare("SELECT * FROM rfq_quote_ingress_requests").get();
  database.close();
  const serialized = JSON.stringify(stored).toLowerCase();
  assert.equal(serialized.includes(IDENTITY.toLowerCase()), false);
  assert.equal(serialized.includes(sessionToken.slice(2)), false);
  assert.equal(stored.state, "SELECTED");

  store.close();
  const reopened = await RfqQuoteIngressStore.open(config(path, { initialize: false }));
  t.after(() => { try { reopened.close(); } catch {} });
  assert.equal(reopened.claimSelection({ now: NOW + 3, sessionToken }), null);
  assert.equal(reopened.status({ now: NOW + 3 }).selectedSessions, 1);
});

test("atomically bounds identity, global, replay, and clock state", async (t) => {
  const { path, store } = await storeFixture(t, {
    maximumActiveSessionsPerIdentity: 1,
    maximumLiveRequests: 2,
    maximumRequestsPerIdentityWindow: 2,
    maximumRequestsPerWindowGlobal: 2,
  });
  const second = await RfqQuoteIngressStore.open(config(path, {
    initialize: false,
    maximumActiveSessionsPerIdentity: 1,
    maximumLiveRequests: 2,
    maximumRequestsPerIdentityWindow: 2,
    maximumRequestsPerWindowGlobal: 2,
  }));
  t.after(() => { try { second.close(); } catch {} });
  assert.ok(store.claim(claim("a", 1)));
  assert.throws(() => second.claim(claim("b", 2)), /quota is exhausted/);
  assert.throws(() => store.observeTime({ now: NOW - 1 }), /clock regressed/);
  assert.throws(
    () => store.claim(claim("long", 3, { expiresAt: NOW + 121 })),
    /outside its live window/,
  );
  assert.throws(
    () => store.claim({ ...claim("decorated", 4), authority: true }),
    /fields are not exact/,
  );
});

test("rejects policy, key, permission, symlink, and layout substitution", async (t) => {
  const { directory, path, store } = await storeFixture(t);
  store.close();
  await assert.rejects(
    RfqQuoteIngressStore.open(config(path, { initialize: false, policyDigest: id("changed").toLowerCase() })),
    /policy or schema is unsupported/,
  );
  await assert.rejects(
    RfqQuoteIngressStore.open(config(path, { initialize: false, identityKey: Buffer.alloc(32, 18) })),
    /policy or schema is unsupported/,
  );
  await chmod(path, 0o644);
  await assert.rejects(
    RfqQuoteIngressStore.open(config(path, { initialize: false })),
    /private regular file/,
  );
  await chmod(path, 0o600);

  const link = join(directory, "link.sqlite");
  await symlink(path, link);
  await assert.rejects(
    RfqQuoteIngressStore.open(config(link, { initialize: false })),
    /private regular file/,
  );
  const state = await lstat(path);
  assert.equal(state.isFile(), true);
  assert.equal((state.mode & 0o077), 0);

  const bytes = await readFile(path);
  assert.equal(bytes.includes(KEY), false);
  const database = new DatabaseSync(path);
  database.exec("ALTER TABLE rfq_quote_ingress_requests ADD COLUMN authority TEXT");
  database.close();
  await assert.rejects(
    RfqQuoteIngressStore.open(config(path, { initialize: false })),
    /layout is unsupported/,
  );
});

test("keeps memory storage explicitly test-only and provenance noncopyable", async () => {
  await assert.rejects(
    RfqQuoteIngressStore.open(config(":memory:", { allowMemory: false })),
    /initialization-only test state/,
  );
  const store = await RfqQuoteIngressStore.open(config(":memory:", { allowMemory: true }));
  try {
    const requestClaim = store.claim(claim("memory", 1));
    assert.throws(
      () => store.claim(claim("oversized-nonce", (1n << 256n).toString())),
      /canonical uint256/,
    );
    assert.throws(
      () => store.ready({ ...requestClaim }, {
        expiresAt: NOW + 60,
        now: NOW + 1,
        sessionToken: id("memory token").toLowerCase(),
      }),
      /provenance is invalid/,
    );
  } finally {
    store.close();
  }
  await assert.rejects(
    RfqQuoteIngressStore.open(config(":memory:", {
      allowMemory: true,
      maximumRequestsPerIdentityWindow: 3,
      maximumRequestsPerWindowGlobal: 2,
    })),
    /global window quota is below one identity quota/,
  );
});
