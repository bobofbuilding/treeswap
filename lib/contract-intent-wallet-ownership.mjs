import {
  createHash,
  randomBytes as nodeRandomBytes,
} from "node:crypto";
import { getAddress } from "ethers";
import {
  assertContractIntentWalletGatewayLifecycle,
  contractIntentWalletGatewayMode,
} from "./contract-intent-wallet-gateway.mjs";
import { contractIntentWalletJournalArtifact } from "./contract-intent-wallet.mjs";

const BYTES32 = /^0x(?!0{64}$)[0-9a-f]{64}$/;
const TOKEN = /^(?!0{64}$)[0-9a-f]{64}$/;
const MAXIMUM_ACTIVE_HANDLES = 128;
const MAXIMUM_HANDLE_LIFETIME_SECONDS = 60;
const MAXIMUM_GATEWAY_REQUEST_LIFETIME_SECONDS = 30;
const SERVICES = new WeakMap();
const CLAIMS = new WeakMap();
const EDGE_LEASES = new WeakMap();
const BOUND_GATEWAYS = new WeakSet();

function exactRecord(value, fields, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${name} must be a plain data object`);
  }
  const keys = Reflect.ownKeys(value);
  const expected = [...fields].sort();
  if (keys.some((key) => typeof key !== "string") || keys.length !== expected.length
      || [...keys].sort().some((key, index) => key !== expected[index])) {
    throw new TypeError(`${name} fields are not exact`);
  }
  const result = Object.create(null);
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor || !Object.hasOwn(descriptor, "value") || descriptor.enumerable !== true) {
      throw new TypeError(`${name} fields must be enumerable data properties`);
    }
    result[field] = descriptor.value;
  }
  return Object.freeze(result);
}

function integer(value, name, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be a safe integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function address(value, name) {
  if (typeof value !== "string") throw new TypeError(`${name} must be an Ethereum address`);
  try {
    const normalized = getAddress(value).toLowerCase();
    if (normalized === "0x0000000000000000000000000000000000000000") throw new Error();
    return normalized;
  } catch {
    throw new TypeError(`${name} must be a nonzero Ethereum address`);
  }
}

function bytes32(value, name) {
  if (typeof value !== "string" || !BYTES32.test(value)) {
    throw new TypeError(`${name} must be nonzero lowercase bytes32`);
  }
  return value;
}

function token(value, name) {
  if (typeof value !== "string" || !TOKEN.test(value)) {
    throw new TypeError(`${name} must be an exact secret token`);
  }
  return value;
}

function handleDigest(value) {
  return createHash("sha256")
    .update("TreeSwap contract-intent wallet ownership handle v1\n", "utf8")
    .update(value, "utf8")
    .digest("hex");
}

function systemClock() {
  return Math.floor(Date.now() / 1_000);
}

function systemRandomBytes(size) {
  return nodeRandomBytes(size);
}

function createOwnershipService(input, injected) {
  const fields = injected
    ? ["clock", "gateway", "randomBytes", "signal"]
    : ["gateway", "signal"];
  const source = exactRecord(input, fields, "contract-intent wallet ownership options");
  if (!(source.signal instanceof AbortSignal) || source.signal.aborted) {
    throw new TypeError("wallet ownership requires an active deployment AbortSignal");
  }
  assertContractIntentWalletGatewayLifecycle(source.gateway, source.signal);
  const expectedMode = injected ? "test" : "production";
  if (contractIntentWalletGatewayMode(source.gateway) !== expectedMode) {
    throw new TypeError("wallet ownership and gateway modes must match");
  }
  if (BOUND_GATEWAYS.has(source.gateway)) {
    throw new TypeError("wallet gateway already has an ownership boundary");
  }
  const context = {
    claimsTaken: 0,
    clock: injected ? source.clock : systemClock,
    gateway: source.gateway,
    handles: new Map(),
    handlesClaimed: 0,
    handlesIssued: 0,
    mode: injected ? "test" : "production",
    rejected: 0,
    randomBytes: injected ? source.randomBytes : systemRandomBytes,
    requestIndex: new Map(),
    signal: source.signal,
    state: "active",
    edgeLease: null,
  };
  if (typeof context.clock !== "function" || typeof context.randomBytes !== "function") {
    throw new TypeError("test wallet ownership clock and entropy must be functions");
  }
  BOUND_GATEWAYS.add(source.gateway);

  const stop = () => {
    if (context.state === "stopped") return;
    context.state = "stopped";
    context.handles.clear();
    context.requestIndex.clear();
  };
  source.signal.addEventListener("abort", stop, { once: true });

  const observeNow = () => integer(context.clock(), "wallet ownership clock", 1);
  const prune = (now) => {
    for (const [digest, record] of context.handles) {
      if (record.preflight.expiresAt <= now) {
        context.handles.delete(digest);
        if (context.requestIndex.get(record.preflight.requestDigest) === digest) {
          context.requestIndex.delete(record.preflight.requestDigest);
        }
      } else if (record.state === "ISSUED" && record.handleExpiresAt <= now) {
        context.handles.set(digest, Object.freeze({ ...record, state: "EXPIRED" }));
      }
    }
  };
  const assertService = (service) => {
    if (service !== ownership || SERVICES.get(service) !== context || context.state !== "active") {
      throw new TypeError("wallet ownership operation requires the original active service");
    }
  };
  const assertEdgeOwner = (lease) => {
    if (context.edgeLease !== null && lease !== context.edgeLease) {
      throw new TypeError("wallet ownership operations belong to its claimed SIWE edge");
    }
  };

  const ownership = Object.freeze({
    issue(inputValue, edgeLease) {
      assertService(this);
      assertEdgeOwner(edgeLease);
      try {
        const value = exactRecord(
          inputValue,
          ["preflight", "sessionDigest", "wallet"],
          "wallet ownership issuance",
        );
        const now = observeNow();
        const artifact = contractIntentWalletJournalArtifact(value.preflight);
        if (artifact.kind !== "PREFLIGHT" || now < value.preflight.preparedAt
            || now >= value.preflight.expiresAt) {
          throw new Error("wallet ownership requires a live original preflight");
        }
        const wallet = address(value.wallet, "wallet ownership wallet");
        const sessionDigest = bytes32(value.sessionDigest, "wallet ownership session digest");
        if (wallet !== value.preflight.from) {
          throw new Error("wallet ownership wallet does not match the contract intent");
        }
        prune(now);
        if (context.requestIndex.has(value.preflight.requestDigest)) {
          throw new Error("wallet ownership already exists for this preflight");
        }
        if (context.handles.size >= MAXIMUM_ACTIVE_HANDLES) {
          throw new Error("wallet ownership handle bound is exhausted");
        }
        const entropy = context.randomBytes(32);
        if ((!Buffer.isBuffer(entropy) && !(entropy instanceof Uint8Array))
            || entropy.byteLength !== 32) {
          throw new Error("wallet ownership entropy source is invalid");
        }
        const ownershipHandle = Buffer.from(entropy).toString("hex");
        token(ownershipHandle, "wallet ownership generated handle");
        const digest = handleDigest(ownershipHandle);
        if (context.handles.has(digest)) throw new Error("wallet ownership handle collided");
        const handleExpiresAt = Math.min(
          value.preflight.expiresAt,
          now + MAXIMUM_HANDLE_LIFETIME_SECONDS,
        );
        const record = Object.freeze({
          handleExpiresAt,
          preflight: value.preflight,
          sessionDigest,
          state: "ISSUED",
          wallet,
        });
        context.handles.set(digest, record);
        context.requestIndex.set(value.preflight.requestDigest, digest);
        context.handlesIssued += 1;
        return Object.freeze({
          schema: "treeswap.contract-intent-wallet-ownership-handle.v1",
          ownershipHandle,
          expiresAt: handleExpiresAt,
          singleUse: true,
          requestDigestDisclosed: false,
          contractIntentDisclosed: false,
          quoteDisclosed: false,
          invoiceDisclosed: false,
          walletDispatchAuthority: false,
          lightningDispatchAuthority: false,
          fundingAuthorization: false,
        });
      } catch (error) {
        context.rejected += 1;
        throw error;
      }
    },
    claim(inputValue, edgeLease) {
      assertService(this);
      assertEdgeOwner(edgeLease);
      try {
        const value = exactRecord(
          inputValue,
          ["ownershipHandle", "sessionDigest", "wallet"],
          "wallet ownership claim",
        );
        const now = observeNow();
        const ownershipHandle = token(value.ownershipHandle, "wallet ownership handle");
        const wallet = address(value.wallet, "wallet ownership claim wallet");
        const sessionDigest = bytes32(
          value.sessionDigest,
          "wallet ownership claim session digest",
        );
        prune(now);
        const digest = handleDigest(ownershipHandle);
        const record = context.handles.get(digest);
        if (!record || record.state !== "ISSUED" || now >= record.handleExpiresAt
            || wallet !== record.wallet || sessionDigest !== record.sessionDigest) {
          throw new Error("wallet ownership handle is unavailable");
        }
        const consumed = Object.freeze({
          ...record,
          claimedAt: now,
          state: "CLAIMED",
        });
        context.handles.set(digest, consumed);
        context.handlesClaimed += 1;
        context.gateway.stage(consumed.preflight, { now });
        const claim = Object.freeze({
          schema: "treeswap.claimed-contract-intent-wallet-ownership.v1",
          claimedAt: now,
          expiresAt: consumed.handleExpiresAt,
          singleUse: true,
          ownershipHandleDisclosed: false,
          requestDigestDisclosed: false,
          contractIntentDisclosed: false,
          quoteDisclosed: false,
          invoiceDisclosed: false,
          walletDispatchAuthority: false,
          lightningDispatchAuthority: false,
          fundingAuthorization: false,
        });
        CLAIMS.set(claim, {
          context,
          preflight: consumed.preflight,
          sessionDigest: consumed.sessionDigest,
          taken: false,
          wallet: consumed.wallet,
        });
        return claim;
      } catch (error) {
        context.rejected += 1;
        throw error;
      }
    },
    take(claim, edgeLease) {
      assertService(this);
      assertEdgeOwner(edgeLease);
      try {
        const claimContext = CLAIMS.get(claim);
        if (!claimContext || claimContext.context !== context || claimContext.taken) {
          throw new TypeError("wallet ownership handoff requires the original unused claim");
        }
        const now = observeNow();
        if (now >= claim.expiresAt || now >= claimContext.preflight.expiresAt) {
          throw new Error("wallet ownership claim expired before private handoff");
        }
        claimContext.taken = true;
        context.claimsTaken += 1;
        return Object.freeze({
          schema: "treeswap.contract-intent-wallet-ownership-private-handoff.v1",
          preflight: claimContext.preflight,
          requestDigest: claimContext.preflight.requestDigest,
          wallet: claimContext.wallet,
          sessionDigest: claimContext.sessionDigest,
          requestedAt: now,
          expiresAt: Math.min(
            claimContext.preflight.expiresAt,
            now + MAXIMUM_GATEWAY_REQUEST_LIFETIME_SECONDS,
          ),
          retryAuthorized: false,
          browserWalletProvider: false,
          walletDispatchAuthority: false,
          lightningDispatchAuthority: false,
          fundingAuthorization: false,
        });
      } catch (error) {
        context.rejected += 1;
        throw error;
      }
    },
    status() {
      if (this !== ownership || SERVICES.get(this) !== context) {
        throw new TypeError("wallet ownership status requires the original service");
      }
      const now = context.state === "active" ? observeNow() : null;
      if (now !== null) prune(now);
      let liveHandles = 0;
      let consumedHandles = 0;
      let expiredHandles = 0;
      for (const record of context.handles.values()) {
        if (record.state === "ISSUED") liveHandles += 1;
        else if (record.state === "CLAIMED") consumedHandles += 1;
        else expiredHandles += 1;
      }
      return Object.freeze({
        schema: "treeswap.contract-intent-wallet-ownership-status.v1",
        state: context.state,
        liveHandles,
        consumedHandles,
        expiredHandles,
        handlesIssued: context.handlesIssued,
        handlesClaimed: context.handlesClaimed,
        claimsTaken: context.claimsTaken,
        requestsRejected: context.rejected,
        handleTokensInStatus: false,
        requestDigestsInStatus: false,
        contractIntentsInStatus: false,
        quotesInStatus: false,
        invoicesInStatus: false,
        walletsInStatus: false,
        sessionDigestsInStatus: false,
        persistentHandles: false,
        networkListener: false,
        browserWalletProvider: false,
        automaticRetry: false,
        walletDispatchAuthority: false,
        lightningDispatchAuthority: false,
        fundingAuthorization: false,
      });
    },
    stop() {
      if (this !== ownership || SERVICES.get(this) !== context) {
        throw new TypeError("wallet ownership stop requires the original service");
      }
      stop();
      return this.status();
    },
  });
  SERVICES.set(ownership, context);
  return ownership;
}

export function createContractIntentWalletOwnershipService(input) {
  return createOwnershipService(input, false);
}

export function createContractIntentWalletOwnershipServiceForTests(input) {
  return createOwnershipService(input, true);
}

export function contractIntentWalletOwnershipMode(value) {
  const context = SERVICES.get(value);
  if (!context) throw new TypeError("wallet ownership service lacks factory provenance");
  return context.mode;
}

export function assertContractIntentWalletOwnershipLifecycle(value, gateway, signal) {
  const context = SERVICES.get(value);
  if (!context) throw new TypeError("wallet ownership service lacks factory provenance");
  if (context.gateway !== gateway || context.signal !== signal || signal.aborted
      || context.state !== "active") {
    throw new TypeError("wallet ownership service does not share the active gateway lifecycle");
  }
  return value;
}

export function claimContractIntentWalletOwnershipEdge(value, gateway, signal) {
  const context = SERVICES.get(value);
  assertContractIntentWalletOwnershipLifecycle(value, gateway, signal);
  if (context.edgeLease !== null) {
    throw new TypeError("wallet ownership service already belongs to a SIWE edge");
  }
  const assertLease = (candidate) => {
    if (candidate !== lease || EDGE_LEASES.get(candidate) !== context
        || context.edgeLease !== candidate || context.state !== "active") {
      throw new TypeError("wallet ownership SIWE-edge lease lacks active factory provenance");
    }
  };
  const lease = Object.freeze({
    issue(input) {
      assertLease(this);
      return value.issue(input, lease);
    },
    claim(input) {
      assertLease(this);
      return value.claim(input, lease);
    },
    take(claim) {
      assertLease(this);
      return value.take(claim, lease);
    },
  });
  context.edgeLease = lease;
  EDGE_LEASES.set(lease, context);
  return lease;
}
