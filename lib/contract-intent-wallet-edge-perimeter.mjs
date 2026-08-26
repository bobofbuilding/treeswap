import {
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import {
  isAbsolute,
  join,
  resolve,
} from "node:path";
import {
  assertContractIntentWalletSiweEdgeLifecycle,
  claimContractIntentWalletSiweEdgePerimeter,
} from "./contract-intent-wallet-siwe-edge.mjs";

const FENCE_DIRECTORY = "wallet-intent-edge.fence";
const FENCE_OWNER_FILE = "owner.json";
const FENCE_SCHEMA = "treeswap.contract-intent-wallet-edge-replica-fence.v1";
const MAXIMUM_FENCE_FILE_BYTES = 4_096;
const MAXIMUM_REQUEST_BYTES = 64 * 1_024;
const MAXIMUM_RESPONSE_BYTES = 512 * 1_024;
const MAXIMUM_HEADER_BYTES = 8_192;
const MAXIMUM_HEADERS = 32;
const PRODUCTION_MAXIMUM_CONCURRENT_REQUESTS = 16;
const PRODUCTION_MAXIMUM_REQUESTS_PER_WINDOW = 32;
const PRODUCTION_WINDOW_SECONDS = 1;
const TOKEN = /^(?!0{64}$)[0-9a-f]{64}$/;
const FENCES = new WeakMap();
const PERIMETERS = new WeakMap();

function exactRecord(value, fields, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${name} must be plain data`);
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

function integer(value, name, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be a safe integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function canonicalDirectory(value) {
  if (typeof value !== "string") {
    throw new TypeError("wallet edge fence requires a dedicated canonical absolute directory");
  }
  const path = value;
  if (!isAbsolute(path) || resolve(path) !== path || path === "/") {
    throw new TypeError("wallet edge fence requires a dedicated canonical absolute directory");
  }
  return path;
}

function wholeSecondIso(milliseconds) {
  const value = new Date(Math.floor(milliseconds / 1_000) * 1_000).toISOString();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/.test(value)) {
    throw new Error("wallet edge fence time is invalid");
  }
  return value;
}

function randomToken(randomBytesImpl) {
  const value = randomBytesImpl(32);
  if ((!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) || value.byteLength !== 32) {
    throw new Error("wallet edge fence randomness is invalid");
  }
  const token = Buffer.from(value).toString("hex");
  if (!TOKEN.test(token)) throw new Error("wallet edge fence randomness is zero");
  return token;
}

function fenceDigest(token) {
  return `sha256:${createHash("sha256")
    .update("TreeSwap wallet edge replica fence v1\n", "utf8")
    .update(token, "utf8")
    .digest("hex")}`;
}

async function privateDirectory(path) {
  const [state, resolved] = await Promise.all([lstat(path), realpath(path)]);
  const currentUid = process.getuid?.();
  if (resolved !== path || state.isSymbolicLink() || !state.isDirectory()
      || (state.mode & 0o077) !== 0
      || (currentUid !== undefined && state.uid !== currentUid)) {
    throw new Error("wallet edge fence directory is not private and owner-controlled");
  }
}

async function writeOwner(path, value) {
  const bytes = Buffer.from(JSON.stringify(value), "utf8");
  if (bytes.length === 0 || bytes.length > MAXIMUM_FENCE_FILE_BYTES) {
    throw new Error("wallet edge fence owner record is outside policy");
  }
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    bytes.fill(0);
    await handle.close();
  }
}

async function readOwner(context) {
  const [directoryState, ownerState, bytes] = await Promise.all([
    lstat(context.fenceDirectory),
    lstat(context.ownerPath),
    readFile(context.ownerPath),
  ]);
  const currentUid = process.getuid?.();
  try {
    if (directoryState.isSymbolicLink() || !directoryState.isDirectory()
        || (directoryState.mode & 0o077) !== 0
        || ownerState.isSymbolicLink() || !ownerState.isFile()
        || (ownerState.mode & 0o177) !== 0
        || (currentUid !== undefined
          && (directoryState.uid !== currentUid || ownerState.uid !== currentUid))
        || bytes.length === 0 || bytes.length > MAXIMUM_FENCE_FILE_BYTES) {
      throw new Error("wallet edge replica fence is not owner-controlled");
    }
    const source = exactRecord(
      JSON.parse(bytes.toString("utf8")),
      ["schema", "startedAt", "token"],
      "wallet edge replica fence owner",
    );
    if (source.schema !== FENCE_SCHEMA || typeof source.token !== "string"
        || !TOKEN.test(source.token) || source.startedAt !== context.startedAt) {
      throw new Error("wallet edge replica fence owner changed");
    }
    const observed = Buffer.from(source.token, "utf8");
    const expected = Buffer.from(context.token, "utf8");
    if (observed.length !== expected.length || !timingSafeEqual(observed, expected)) {
      throw new Error("wallet edge replica fence owner changed");
    }
  } finally {
    bytes.fill(0);
  }
}

function createFence(input, injected) {
  return (async () => {
    const fields = injected
      ? ["clock", "randomBytes", "runtimeDirectory", "signal"]
      : ["runtimeDirectory", "signal"];
    const source = exactRecord(input, fields, "wallet edge replica fence options");
    if (!(source.signal instanceof AbortSignal) || source.signal.aborted) {
      throw new TypeError("wallet edge replica fence requires an active deployment signal");
    }
    const clock = injected ? source.clock : Date.now;
    const randomBytesImpl = injected ? source.randomBytes : randomBytes;
    if (typeof clock !== "function" || typeof randomBytesImpl !== "function") {
      throw new TypeError("wallet edge test fence dependencies are invalid");
    }
    const runtimeDirectory = canonicalDirectory(source.runtimeDirectory);
    await privateDirectory(runtimeDirectory);
    const fenceDirectory = join(runtimeDirectory, FENCE_DIRECTORY);
    try {
      await mkdir(fenceDirectory, { mode: 0o700 });
    } catch (error) {
      if (error?.code === "EEXIST") {
        throw new Error("another wallet edge replica or an unreconciled crash holds the fence");
      }
      throw error;
    }
    let initialized = false;
    try {
      await chmod(fenceDirectory, 0o700);
      const token = randomToken(randomBytesImpl);
      const startedAt = wholeSecondIso(integer(clock(), "wallet edge fence clock", 1, 8_640_000_000_000_000));
      const context = {
        fenceDirectory,
        fenceId: fenceDigest(token),
        ownerPath: join(fenceDirectory, FENCE_OWNER_FILE),
        signal: source.signal,
        startedAt,
        state: "held",
        token,
      };
      await writeOwner(context.ownerPath, Object.freeze({
        schema: FENCE_SCHEMA,
        startedAt,
        token,
      }));
      await readOwner(context);
      initialized = true;
      const fence = Object.freeze({
        async assertHeld() {
          if (this !== fence || FENCES.get(this) !== context || context.state !== "held"
              || context.signal.aborted) {
            throw new Error("wallet edge replica fence is unavailable");
          }
          await readOwner(context);
          return Object.freeze({
            schema: FENCE_SCHEMA,
            state: "held",
            fenceId: context.fenceId,
            automaticStaleTakeover: false,
            crashRecovery: "manual-after-independent-old-replica-proof",
          });
        },
        status() {
          if (this !== fence || FENCES.get(this) !== context) {
            throw new TypeError("wallet edge fence status requires the original fence");
          }
          return Object.freeze({
            schema: FENCE_SCHEMA,
            state: context.state,
            fenceId: context.fenceId,
            automaticStaleTakeover: false,
            crashRecovery: "manual-after-independent-old-replica-proof",
            runtimeDirectoryDisclosed: false,
            ownerTokenDisclosed: false,
            fundingAuthorization: false,
          });
        },
        async release() {
          if (this !== fence || FENCES.get(this) !== context) {
            throw new TypeError("wallet edge fence release requires the original fence");
          }
          if (context.state === "released") return false;
          await readOwner(context);
          const releasedPath = join(
            runtimeDirectory,
            `.wallet-intent-edge.fence.released.${context.fenceId.slice("sha256:".length, 30)}`,
          );
          await rename(context.fenceDirectory, releasedPath);
          context.state = "released";
          await rm(releasedPath, { recursive: true, force: true });
          return true;
        },
      });
      FENCES.set(fence, context);
      return fence;
    } catch (error) {
      if (!initialized) await rm(fenceDirectory, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  })();
}

export function acquireContractIntentWalletEdgeReplicaFence(input) {
  return createFence(input, false);
}

export function acquireContractIntentWalletEdgeReplicaFenceForTests(input) {
  return createFence(input, true);
}

async function assertFenceLifecycle(fence, signal) {
  const context = fence && typeof fence === "object" ? FENCES.get(fence) : null;
  if (!context || context.signal !== signal || context.state !== "held") {
    throw new TypeError("wallet edge perimeter requires its original replica fence lifecycle");
  }
  return fence.assertHeld();
}

function responseHeaders() {
  return {
    "cache-control": "no-store, max-age=0",
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
    "content-type": "application/json; charset=utf-8",
    "cross-origin-resource-policy": "same-origin",
    pragma: "no-cache",
    "referrer-policy": "no-referrer",
    vary: "Origin, Sec-Fetch-Site, Sec-Fetch-Mode, Sec-Fetch-Dest",
    "x-content-type-options": "nosniff",
  };
}

function rejectedResponse(status) {
  const bytes = JSON.stringify(Object.freeze({ error: "wallet intent request rejected" }));
  return new Response(bytes, {
    status,
    headers: {
      ...responseHeaders(),
      "content-length": String(Buffer.byteLength(bytes, "utf8")),
      ...(status === 429 ? { "retry-after": "1" } : {}),
    },
  });
}

async function cancelBody(request) {
  try {
    await request?.body?.cancel?.();
  } catch {}
}

function validateRequest(request, clientOrigin, paths) {
  if (!(request instanceof Request)) throw new TypeError("wallet edge perimeter requires a Request");
  const url = new URL(request.url);
  if (request.method !== "POST" || url.origin !== clientOrigin || !paths.has(url.pathname)
      || url.search || url.hash || !request.body) {
    throw new Error("wallet edge perimeter route is invalid");
  }
  const declared = request.headers.get("content-length");
  if (declared === null || !/^(?:[1-9][0-9]*)$/.test(declared)) {
    throw new Error("wallet edge perimeter requires an exact content length");
  }
  const length = Number(declared);
  if (!Number.isSafeInteger(length) || length > MAXIMUM_REQUEST_BYTES) {
    throw new Error("wallet edge perimeter request is too large");
  }
  if (request.headers.has("authorization") || request.headers.has("proxy-authorization")
      || request.headers.has("expect") || request.headers.has("upgrade")
      || request.headers.has("transfer-encoding")
      || String(request.headers.get("content-encoding") ?? "identity").toLowerCase() !== "identity") {
    throw new Error("wallet edge perimeter request framing is forbidden");
  }
  let count = 0;
  let bytes = 0;
  for (const [name, value] of request.headers) {
    count += 1;
    bytes += Buffer.byteLength(name, "utf8") + Buffer.byteLength(value, "utf8") + 4;
  }
  if (count > MAXIMUM_HEADERS || bytes > MAXIMUM_HEADER_BYTES
      || String(request.headers.get("cookie") ?? "").length > 4_096) {
    throw new Error("wallet edge perimeter headers exceed policy");
  }
}

function validateResponse(response) {
  if (!(response instanceof Response) || response.headers.has("set-cookie")
      || response.headers.has("location")
      || response.headers.get("content-type") !== "application/json; charset=utf-8"
      || !String(response.headers.get("cache-control") ?? "").includes("no-store")) {
    throw new Error("wallet edge perimeter response is invalid");
  }
  const rawLength = response.headers.get("content-length");
  if (rawLength === null || !/^(?:[1-9][0-9]*)$/.test(rawLength)) {
    throw new Error("wallet edge perimeter response length is invalid");
  }
  const length = Number(rawLength);
  if (!Number.isSafeInteger(length) || length > MAXIMUM_RESPONSE_BYTES) {
    throw new Error("wallet edge perimeter response exceeds policy");
  }
  return response;
}

function createPerimeter(input, injected) {
  return (async () => {
    const fields = injected
      ? [
          "clock",
          "edge",
          "fence",
          "maximumConcurrentRequests",
          "maximumRequestsPerWindow",
          "signal",
          "windowSeconds",
        ]
      : ["edge", "fence", "signal"];
    const source = exactRecord(input, fields, "wallet edge perimeter options");
    if (!(source.signal instanceof AbortSignal) || source.signal.aborted) {
      throw new TypeError("wallet edge perimeter requires an active deployment signal");
    }
    const binding = assertContractIntentWalletSiweEdgeLifecycle(source.edge, source.signal);
    const expectedMode = injected ? "test" : "production";
    if (binding.mode !== expectedMode) {
      throw new TypeError("wallet edge perimeter and SIWE edge modes must match");
    }
    await assertFenceLifecycle(source.fence, source.signal);
    const edgeLease = claimContractIntentWalletSiweEdgePerimeter(source.edge, source.signal);
    const clock = injected ? source.clock : () => Math.floor(Date.now() / 1_000);
    if (typeof clock !== "function") throw new TypeError("wallet edge test perimeter clock is invalid");
    const context = {
      admitted: 0,
      clock,
      clockHighWater: 0,
      concurrent: 0,
      edge: edgeLease,
      fence: source.fence,
      fenceFailures: 0,
      haltedOnClockRollback: false,
      haltedOnFenceLoss: false,
      maximumConcurrentRequests: injected
        ? integer(source.maximumConcurrentRequests, "wallet perimeter concurrency", 1, 256)
        : PRODUCTION_MAXIMUM_CONCURRENT_REQUESTS,
      maximumRequestsPerWindow: injected
        ? integer(source.maximumRequestsPerWindow, "wallet perimeter request rate", 1, 256)
        : PRODUCTION_MAXIMUM_REQUESTS_PER_WINDOW,
      preSessionRejected: 0,
      rateRejected: 0,
      signal: source.signal,
      state: "active",
      windowCount: 0,
      windowEndsAt: 0,
      windowSeconds: injected
        ? integer(source.windowSeconds, "wallet perimeter rate window", 1, 60)
        : PRODUCTION_WINDOW_SECONDS,
    };
    const observeNow = () => {
      const now = integer(context.clock(), "wallet perimeter clock", 1, Number.MAX_SAFE_INTEGER);
      if (now < context.clockHighWater) {
        context.state = "halted";
        context.haltedOnClockRollback = true;
        context.edge.stop();
        throw new Error("wallet edge perimeter clock regressed");
      }
      context.clockHighWater = now;
      return now;
    };
    const stop = () => {
      if (context.state === "stopped") return;
      context.state = "stopped";
      context.edge.stop();
    };
    source.signal.addEventListener("abort", stop, { once: true });

    const execute = async (request, paths, operation) => {
      if (context.state !== "active") {
        await cancelBody(request);
        return rejectedResponse(503);
      }
      let now;
      try {
        now = observeNow();
      } catch {
        await cancelBody(request);
        return rejectedResponse(503);
      }
      if (now >= context.windowEndsAt) {
        context.windowCount = 0;
        context.windowEndsAt = now + context.windowSeconds;
      }
      if (context.windowCount >= context.maximumRequestsPerWindow
          || context.concurrent >= context.maximumConcurrentRequests) {
        context.rateRejected += 1;
        await cancelBody(request);
        return rejectedResponse(429);
      }
      context.windowCount += 1;
      try {
        validateRequest(request, binding.clientOrigin, paths);
      } catch {
        context.preSessionRejected += 1;
        await cancelBody(request);
        return rejectedResponse(400);
      }
      context.concurrent += 1;
      try {
        try {
          await source.fence.assertHeld();
        } catch {
          context.fenceFailures += 1;
          context.haltedOnFenceLoss = true;
          context.state = "halted";
          context.edge.stop();
          await cancelBody(request);
          return rejectedResponse(503);
        }
        const response = validateResponse(await operation());
        context.admitted += 1;
        return response;
      } catch {
        context.state = "halted";
        context.edge.stop();
        return rejectedResponse(503);
      } finally {
        context.concurrent -= 1;
      }
    };

    const service = Object.freeze({
      issue(preflight, request) {
        if (this !== service || PERIMETERS.get(this) !== context) {
          throw new TypeError("wallet edge perimeter issue requires the original service");
        }
        return execute(
          request,
          new Set(["/v1/wallet-intent/prepare"]),
          () => context.edge.issue(preflight, request),
        );
      },
      handle(request) {
        if (this !== service || PERIMETERS.get(this) !== context) {
          throw new TypeError("wallet edge perimeter request requires the original service");
        }
        return execute(
          request,
          new Set(["/v1/wallet-intent/claim", "/v1/wallet-intent/outcome"]),
          () => context.edge.handle(request),
        );
      },
      status() {
        if (this !== service || PERIMETERS.get(this) !== context) {
          throw new TypeError("wallet edge perimeter status requires the original service");
        }
        if (context.state === "active") observeNow();
        return Object.freeze({
          schema: "treeswap.contract-intent-wallet-edge-perimeter-status.v1",
          state: context.state,
          admittedRequests: context.admitted,
          preSessionRejected: context.preSessionRejected,
          rateRejected: context.rateRejected,
          inFlightRequests: context.concurrent,
          fenceFailures: context.fenceFailures,
          haltedOnClockRollback: context.haltedOnClockRollback,
          haltedOnFenceLoss: context.haltedOnFenceLoss,
          maximumRequestBytes: MAXIMUM_REQUEST_BYTES,
          maximumHeaderBytes: MAXIMUM_HEADER_BYTES,
          maximumHeaders: MAXIMUM_HEADERS,
          maximumConcurrentRequests: context.maximumConcurrentRequests,
          maximumRequestsPerWindow: context.maximumRequestsPerWindow,
          windowSeconds: context.windowSeconds,
          replicaPolicy: "single-active-replica-owner-controlled-shared-volume-fence",
          automaticStaleTakeover: false,
          manualCrashReconciliationRequired: true,
          requestBodyLogging: false,
          responseBodyLogging: false,
          rawCookieLogging: false,
          networkListener: false,
          walletDispatchAuthority: false,
          lightningDispatchAuthority: false,
          fundingAuthorization: false,
          edge: context.edge.status(),
        });
      },
      stop() {
        if (this !== service || PERIMETERS.get(this) !== context) {
          throw new TypeError("wallet edge perimeter stop requires the original service");
        }
        stop();
        return this.status();
      },
    });
    PERIMETERS.set(service, context);
    return service;
  })();
}

export function createContractIntentWalletEdgePerimeter(input) {
  return createPerimeter(input, false);
}

export function createContractIntentWalletEdgePerimeterForTests(input) {
  return createPerimeter(input, true);
}
