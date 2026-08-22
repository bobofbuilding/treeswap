import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Interface, getAddress, keccak256 } from "ethers";
import {
  BIT_DEPLOYMENT_COMPARISON_SCHEMA,
  BIT_DEPLOYMENT_OBSERVATION_SCHEMA,
  BIT_MAINNET_CONTRACT,
  BIT_RPC_MAXIMUM_RESPONSE_BYTES,
  EIP1967_IMPLEMENTATION_SLOT,
  assessBitDeploymentObservation,
  bitDeploymentObservationValueDigest,
  buildBitDeploymentComparisonReport,
  compareBitDeploymentObservations,
  createJsonRpcClient,
  normalizeBitDeploymentObservation,
  observeBitDeployment,
  validateBitComparisonSourceProvenance,
  validateBitObservationSourceProvenance,
} from "../lib/bit-deployment-observer.mjs";

const TOKEN_INTERFACE = new Interface([
  "function decimals() view returns (uint8)",
  "function paused() view returns (bool)",
  "function symbol() view returns (string)",
]);
const IMPLEMENTATION = getAddress("0x1111111111111111111111111111111111111111");
const FINALIZED_BLOCK = {
  number: "0x1234",
  hash: `0x${"ab".repeat(32)}`,
  timestamp: "0x65a00000",
};
const OLDER_BLOCK = {
  number: "0x1200",
  hash: `0x${"cd".repeat(32)}`,
  timestamp: "0x659ff000",
};
const PROXY_CODE = "0x6001600055";
const IMPLEMENTATION_CODE = "0x6002600055";
const SOURCE_COMMIT = "a".repeat(40);
const OBSERVED_AT = new Date("2026-08-19T12:00:00.000Z");
const PROVIDER_A = `0x${"11".repeat(32)}`;
const PROVIDER_B = `0x${"22".repeat(32)}`;

function fixtureRpc({ chainId = "0x1", paused = false, decimals = 18, symbol = "BIT", targetBlock = FINALIZED_BLOCK } = {}) {
  const calls = [];
  const rpcCall = async (method, params) => {
    calls.push({ method, params });
    if (method === "eth_chainId") return chainId;
    if (method === "eth_getBlockByNumber") return params[0] === "finalized" ? FINALIZED_BLOCK : targetBlock;
    if (method === "eth_getStorageAt") return `0x${"0".repeat(24)}${IMPLEMENTATION.slice(2).toLowerCase()}`;
    if (method === "eth_getCode") return getAddress(params[0]) === BIT_MAINNET_CONTRACT ? PROXY_CODE : IMPLEMENTATION_CODE;
    if (method === "eth_call") {
      const selector = params[0].data;
      if (selector === TOKEN_INTERFACE.encodeFunctionData("decimals")) {
        return TOKEN_INTERFACE.encodeFunctionResult("decimals", [decimals]);
      }
      if (selector === TOKEN_INTERFACE.encodeFunctionData("paused")) {
        return TOKEN_INTERFACE.encodeFunctionResult("paused", [paused]);
      }
      if (selector === TOKEN_INTERFACE.encodeFunctionData("symbol")) {
        return TOKEN_INTERFACE.encodeFunctionResult("symbol", [symbol]);
      }
    }
    throw new Error(`unexpected RPC method: ${method}`);
  };
  return { rpcCall, calls };
}

function observe(rpcCall, overrides = {}) {
  return observeBitDeployment({
    rpcCall,
    providerLabel: "provider-a",
    providerIdentity: PROVIDER_A,
    sourceCommit: SOURCE_COMMIT,
    observedAt: OBSERVED_AT,
    ...overrides,
  });
}

async function fakePublishedGit(directory, {
  branch = "main",
  head = SOURCE_COMMIT,
  origin = "https://github.com/bobofbuilding/treeswap.git",
  published = head,
  status = "",
} = {}) {
  const bin = join(directory, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "git"), `#!/bin/sh
case "$1:$2:$3" in
  remote:get-url:origin) printf '%s\\n' "$TREESWAP_TEST_ORIGIN" ;;
  branch:--show-current:) printf '%s\\n' "$TREESWAP_TEST_BRANCH" ;;
  rev-parse:HEAD:) printf '%s\\n' "$TREESWAP_TEST_HEAD" ;;
  ls-remote:--exit-code:origin) printf '%s\\trefs/heads/main\\n' "$TREESWAP_TEST_PUBLISHED" ;;
  status:--porcelain:--untracked-files=all) printf '%s' "$TREESWAP_TEST_STATUS" ;;
  *) exit 64 ;;
esac
`, { mode: 0o700 });
  return {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    TREESWAP_TEST_BRANCH: branch,
    TREESWAP_TEST_HEAD: head,
    TREESWAP_TEST_ORIGIN: origin,
    TREESWAP_TEST_PUBLISHED: published,
    TREESWAP_TEST_STATUS: status,
  };
}

test("records one internally consistent finalized BIT deployment observation", async () => {
  const { rpcCall, calls } = fixtureRpc();
  const observation = await observe(rpcCall, { providerLabel: "test-provider" });

  assert.equal(observation.chainId, 1);
  assert.equal(observation.schema, BIT_DEPLOYMENT_OBSERVATION_SCHEMA);
  assert.equal(observation.providerIdentity, PROVIDER_A);
  assert.equal(observation.providerFinalizedHead.number, 0x1234);
  assert.equal(observation.finalizedBlock.number, 0x1234);
  assert.deepEqual(observation.stateAnchor, { blockHash: FINALIZED_BLOCK.hash, requireCanonical: true });
  assert.equal(observation.proxy.address, BIT_MAINNET_CONTRACT);
  assert.equal(observation.proxy.codeHash, keccak256(PROXY_CODE));
  assert.equal(observation.proxy.implementationSlot, EIP1967_IMPLEMENTATION_SLOT);
  assert.equal(observation.implementation.address, IMPLEMENTATION);
  assert.equal(observation.implementation.codeHash, keccak256(IMPLEMENTATION_CODE));
  assert.deepEqual(observation.token, { symbol: "BIT", decimals: 18, paused: false });
  assert.deepEqual(observation.safety, { eligible: true, reasons: [] });

  for (const call of calls.filter(({ method }) => ["eth_getCode", "eth_getStorageAt", "eth_call"].includes(method))) {
    assert.deepEqual(call.params.at(-1), { blockHash: FINALIZED_BLOCK.hash, requireCanonical: true });
  }
});

test("pins an exact older block only after proving the provider finalized past it", async () => {
  const { rpcCall, calls } = fixtureRpc({ targetBlock: OLDER_BLOCK });
  const observation = await observe(rpcCall, { targetBlockNumber: "4608" });

  assert.equal(observation.providerFinalizedHead.number, 0x1234);
  assert.equal(observation.finalizedBlock.number, 0x1200);
  assert.equal(observation.finalizedBlock.hash, OLDER_BLOCK.hash);
  assert.deepEqual(
    calls.filter(({ method }) => method === "eth_getBlockByNumber").map(({ params }) => params[0]),
    ["finalized", "0x1200", "finalized", "0x1200"],
  );
  for (const call of calls.filter(({ method }) => ["eth_getCode", "eth_getStorageAt", "eth_call"].includes(method))) {
    assert.deepEqual(call.params.at(-1), { blockHash: OLDER_BLOCK.hash, requireCanonical: true });
  }
});

test("rejects an unfinalized target, a wrong target response, and a changing finalized hash", async () => {
  await assert.rejects(
    () => observe(fixtureRpc().rpcCall, { targetBlockNumber: 0x1235 }),
    /newer than.*finalized head/,
  );
  await assert.rejects(
    () => observe(fixtureRpc({ targetBlock: OLDER_BLOCK }).rpcCall, { targetBlockNumber: 0x1100 }),
    /wrong target block number/,
  );
  const changing = fixtureRpc({ targetBlock: { ...FINALIZED_BLOCK, hash: `0x${"ef".repeat(32)}` } }).rpcCall;
  await assert.rejects(
    () => observe(changing),
    /finalized head changed/,
  );
});

test("rejects chain rotation, finality regression, and target replacement during anchored reads", async () => {
  let chainReads = 0;
  const chainBase = fixtureRpc({ targetBlock: OLDER_BLOCK }).rpcCall;
  await assert.rejects(
    () => observe(async (method, params) => {
      if (method === "eth_chainId" && chainReads++ > 0) return "0x2";
      return chainBase(method, params);
    }, { targetBlockNumber: 0x1200 }),
    /chain changed/,
  );

  let finalizedReads = 0;
  const finalityBase = fixtureRpc({ targetBlock: OLDER_BLOCK }).rpcCall;
  await assert.rejects(
    () => observe(async (method, params) => {
      if (method === "eth_getBlockByNumber" && params[0] === "finalized" && finalizedReads++ > 0) {
        return OLDER_BLOCK;
      }
      return finalityBase(method, params);
    }, { targetBlockNumber: 0x1200 }),
    /finalized head regressed/,
  );

  let targetReads = 0;
  const targetBase = fixtureRpc({ targetBlock: OLDER_BLOCK }).rpcCall;
  await assert.rejects(
    () => observe(async (method, params) => {
      if (method === "eth_getBlockByNumber" && params[0] === "0x1200" && targetReads++ > 0) {
        return { ...OLDER_BLOCK, hash: `0x${"ef".repeat(32)}` };
      }
      return targetBase(method, params);
    }, { targetBlockNumber: 0x1200 }),
    /target block changed/,
  );
});

test("compares two providers at one exact finalized block and rejects drift", async () => {
  const common = {
    sourceCommit: SOURCE_COMMIT,
    observedAt: OBSERVED_AT,
  };
  const left = await observeBitDeployment({
    ...common,
    rpcCall: fixtureRpc().rpcCall,
    providerLabel: "provider-a",
    providerIdentity: PROVIDER_A,
  });
  const right = await observeBitDeployment({
    ...common,
    rpcCall: fixtureRpc().rpcCall,
    providerLabel: "provider-b",
    providerIdentity: PROVIDER_B,
  });
  assert.deepEqual(compareBitDeploymentObservations(left, right, { comparedAt: OBSERVED_AT }), {
    eligible: true,
    reasons: [],
    comparedFields: [
      "schema",
      "sourceCommit",
      "chainId",
      "finalizedBlock.number",
      "finalizedBlock.hash",
      "finalizedBlock.timestamp",
      "stateAnchor.blockHash",
      "stateAnchor.requireCanonical",
      "proxy.address",
      "proxy.codeHash",
      "proxy.implementationSlot",
      "implementation.address",
      "implementation.codeHash",
      "token.symbol",
      "token.decimals",
      "token.paused",
    ],
  });

  const drifted = structuredClone(right);
  drifted.implementation.codeHash = `0x${"00".repeat(32)}`;
  const comparison = compareBitDeploymentObservations(left, drifted, { comparedAt: OBSERVED_AT });
  assert.equal(comparison.eligible, false);
  assert.deepEqual(comparison.reasons, ["implementation.codeHash differs between providers"]);

  const unbound = structuredClone(right);
  unbound.sourceCommit = null;
  unbound.stateAnchor.blockHash = `0x${"11".repeat(32)}`;
  const unboundComparison = compareBitDeploymentObservations(left, unbound, { comparedAt: OBSERVED_AT });
  assert.equal(unboundComparison.eligible, false);
  assert.match(unboundComparison.reasons.join("; "), /sourceCommit must be full lowercase hex/);
});

test("binds the exact provider observations into a non-authorizing comparison report", async () => {
  const left = await observe(fixtureRpc().rpcCall);
  const right = await observe(fixtureRpc().rpcCall, {
    providerLabel: "provider-b",
    providerIdentity: PROVIDER_B,
  });
  const report = buildBitDeploymentComparisonReport(left, right, { comparedAt: OBSERVED_AT });

  assert.equal(report.schema, BIT_DEPLOYMENT_COMPARISON_SCHEMA);
  assert.equal(report.eligible, true);
  assert.equal(report.fundingAuthorization, false);
  assert.equal(report.independenceStatus, "requires-external-organizational-verification");
  assert.deepEqual(report.observations, [
    {
      providerIdentity: PROVIDER_A,
      providerLabel: "provider-a",
      observationDigest: bitDeploymentObservationValueDigest(left),
    },
    {
      providerIdentity: PROVIDER_B,
      providerLabel: "provider-b",
      observationDigest: bitDeploymentObservationValueDigest(right),
    },
  ]);
  assert.notEqual(report.observations[0].observationDigest, report.observations[1].observationDigest);
  const publishedSource = {
    branch: "main",
    head: SOURCE_COMMIT,
    originUrl: "https://github.com/bobofbuilding/treeswap.git",
    published: SOURCE_COMMIT,
    status: "",
  };
  assert.equal(validateBitComparisonSourceProvenance(report, publishedSource), SOURCE_COMMIT);
  assert.throws(
    () => validateBitComparisonSourceProvenance(report, {
      ...publishedSource,
      head: "b".repeat(40),
      published: "b".repeat(40),
    }),
    /requires observations from the exact clean commit published/,
  );
});

test("rejects relabelled, stale, future, and widely separated provider evidence", async () => {
  const left = await observe(fixtureRpc().rpcCall);
  const sameIdentity = await observe(fixtureRpc().rpcCall, {
    providerLabel: "provider-b",
    providerIdentity: PROVIDER_A,
  });
  assert.match(
    compareBitDeploymentObservations(left, sameIdentity, { comparedAt: OBSERVED_AT }).reasons.join("; "),
    /distinct identity commitments/,
  );

  const sameLabel = await observe(fixtureRpc().rpcCall, {
    providerLabel: "PROVIDER-A",
    providerIdentity: PROVIDER_B,
  });
  assert.match(
    compareBitDeploymentObservations(left, sameLabel, { comparedAt: OBSERVED_AT }).reasons.join("; "),
    /distinct labels/,
  );

  const later = new Date(OBSERVED_AT.getTime() + 1_801_000);
  const separated = await observe(fixtureRpc().rpcCall, {
    providerLabel: "provider-b",
    providerIdentity: PROVIDER_B,
    observedAt: later,
  });
  assert.match(
    compareBitDeploymentObservations(left, separated, { comparedAt: later }).reasons.join("; "),
    /allowed window/,
  );
  assert.match(
    compareBitDeploymentObservations(left, separated, {
      comparedAt: new Date(OBSERVED_AT.getTime() + 3_601_000),
    }).reasons.join("; "),
    /first observation is stale/,
  );
  assert.match(
    compareBitDeploymentObservations(left, separated, {
      comparedAt: new Date(OBSERVED_AT.getTime() - 61_000),
    }).reasons.join("; "),
    /future-dated/,
  );
});

test("rejects noncanonical, unknown-field, endpoint-bearing, and mismatched safety evidence", async () => {
  const value = await observe(fixtureRpc().rpcCall);
  assert.deepEqual(normalizeBitDeploymentObservation(value), value);
  assert.throws(
    () => normalizeBitDeploymentObservation({ ...value, rpcUrl: "https://secret.invalid" }),
    /fields are not exact/,
  );
  assert.throws(
    () => normalizeBitDeploymentObservation({ ...value, providerLabel: "https://rpc.invalid" }),
    /credential-free provider label/,
  );
  assert.throws(
    () => normalizeBitDeploymentObservation({ ...value, providerIdentity: `0x${"00".repeat(32)}` }),
    /nonzero lowercase bytes32/,
  );
  assert.throws(
    () => normalizeBitDeploymentObservation({ ...value, safety: { eligible: false, reasons: [] } }),
    /does not match/,
  );
});

test("requires an exact clean published main source before live capture", () => {
  assert.equal(validateBitObservationSourceProvenance({
    branch: "main",
    head: SOURCE_COMMIT,
    originUrl: "https://github.com/bobofbuilding/treeswap.git",
    published: SOURCE_COMMIT,
    status: "",
  }), SOURCE_COMMIT);
  for (const mutation of [
    { branch: "feature", head: SOURCE_COMMIT, published: SOURCE_COMMIT, status: "" },
    { branch: "main", head: "b".repeat(40), published: SOURCE_COMMIT, status: "" },
    { branch: "main", head: SOURCE_COMMIT, published: SOURCE_COMMIT, status: "?? file" },
    {
      branch: "main",
      head: SOURCE_COMMIT,
      originUrl: "https://github.com/example/treeswap.git",
      published: SOURCE_COMMIT,
      status: "",
    },
  ]) {
    assert.throws(() => validateBitObservationSourceProvenance({
      originUrl: "https://github.com/bobofbuilding/treeswap.git",
      ...mutation,
    }), /exact clean commit published/);
  }
});

test("observation CLI rejects ambiguous duplicate control flags before any RPC", () => {
  const result = spawnSync(process.execPath, [
    "scripts/observe-bit-deployment.mjs",
    "--block",
    "1",
    "--block",
    "2",
  ], { cwd: process.cwd(), encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Usage:/);
});

test("comparison CLI binds bounded inputs and writes one private non-overwriting report", async () => {
  const observedAt = new Date();
  const left = await observe(fixtureRpc().rpcCall, { observedAt });
  const right = await observe(fixtureRpc().rpcCall, {
    observedAt,
    providerLabel: "provider-b",
    providerIdentity: PROVIDER_B,
  });
  const directory = await mkdtemp(join(tmpdir(), "treeswap-bit-comparison-"));
  try {
    const leftPath = join(directory, "left.json");
    const rightPath = join(directory, "right.json");
    const reportPath = join(directory, "report.json");
    await Promise.all([
      writeFile(leftPath, `${JSON.stringify(left)}\n`, { mode: 0o600 }),
      writeFile(rightPath, `${JSON.stringify(right)}\n`, { mode: 0o600 }),
    ]);
    const env = await fakePublishedGit(directory);
    execFileSync(process.execPath, [
      "scripts/compare-bit-observations.mjs",
      leftPath,
      rightPath,
      "--out",
      reportPath,
    ], { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    assert.equal(report.eligible, true);
    assert.equal(report.fundingAuthorization, false);
    assert.equal((await stat(reportPath)).mode & 0o777, 0o600);

    const overwrite = spawnSync(process.execPath, [
      "scripts/compare-bit-observations.mjs",
      leftPath,
      rightPath,
      "--out",
      reportPath,
    ], { cwd: process.cwd(), encoding: "utf8", env });
    assert.notEqual(overwrite.status, 0);

    const ambiguousOutput = spawnSync(process.execPath, [
      "scripts/compare-bit-observations.mjs",
      leftPath,
      rightPath,
      "--out",
      join(directory, "one.json"),
      "--out",
      join(directory, "two.json"),
    ], { cwd: process.cwd(), encoding: "utf8", env });
    assert.notEqual(ambiguousOutput.status, 0);
    assert.match(ambiguousOutput.stderr, /Usage:/);

    const linkPath = join(directory, "linked.json");
    await symlink(leftPath, linkPath);
    const linked = spawnSync(process.execPath, [
      "scripts/compare-bit-observations.mjs",
      linkPath,
      rightPath,
    ], { cwd: process.cwd(), encoding: "utf8", env });
    assert.notEqual(linked.status, 0);
    assert.match(linked.stderr, /bounded non-symlink/);

    const staleReportPath = join(directory, "stale-report.json");
    const stale = spawnSync(process.execPath, [
      "scripts/compare-bit-observations.mjs",
      leftPath,
      rightPath,
      "--out",
      staleReportPath,
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...env,
        TREESWAP_TEST_HEAD: "b".repeat(40),
        TREESWAP_TEST_PUBLISHED: "b".repeat(40),
      },
    });
    assert.notEqual(stale.status, 0);
    assert.match(stale.stderr, /requires observations from the exact clean commit published/);
    await assert.rejects(() => stat(staleReportPath), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects the wrong chain, missing code, empty implementation, and malformed finality", async () => {
  await assert.rejects(() => observe(fixtureRpc({ chainId: "0xaa36a7" }).rpcCall), /mainnet/);

  const noCode = fixtureRpc().rpcCall;
  await assert.rejects(
    () => observe(async (method, params) => method === "eth_getCode" ? "0x" : noCode(method, params)),
    /no deployed bytecode/,
  );

  const emptySlot = fixtureRpc().rpcCall;
  await assert.rejects(
    () => observe(async (method, params) => method === "eth_getStorageAt" ? `0x${"0".repeat(64)}` : emptySlot(method, params)),
    /slot is empty/,
  );

  const noFinality = fixtureRpc().rpcCall;
  await assert.rejects(
    () => observe(async (method, params) => method === "eth_getBlockByNumber" ? null : noFinality(method, params)),
    /finalized block hash/,
  );
});

test("marks an unsafe token state without discarding the evidence", async () => {
  const observation = await observe(fixtureRpc({ paused: true, decimals: 8, symbol: "CHANGED" }).rpcCall);
  assert.equal(observation.safety.eligible, false);
  assert.match(observation.safety.reasons.join("; "), /symbol changed|decimals changed|paused/);
  assert.deepEqual(assessBitDeploymentObservation(observation), observation.safety);
});

test("JSON-RPC client does not place its credential-bearing URL in errors", async () => {
  const secretUrl = "https://rpc.example/secret-key";
  const rpcCall = createJsonRpcClient(secretUrl, async () => ({ ok: false, status: 401 }));
  await assert.rejects(
    () => rpcCall("eth_chainId", []),
    (error) => error.message === "Ethereum RPC returned HTTP 401 for eth_chainId" && !error.message.includes(secretUrl),
  );
});

test("JSON-RPC client permits plaintext only for a local fork", () => {
  assert.throws(() => createJsonRpcClient("http://rpc.example/secret"), /must use HTTPS/);
  assert.equal(typeof createJsonRpcClient("http://127.0.0.1:8545"), "function");
});

test("JSON-RPC client enforces a bounded transport timeout", async () => {
  let signal;
  let redirect;
  const rpcCall = createJsonRpcClient("https://rpc.example/secret", async (_url, options) => {
    signal = options.signal;
    redirect = options.redirect;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1" }), {
      headers: { "content-type": "application/json" },
    });
  }, { timeoutMs: 25 });
  assert.equal(await rpcCall("eth_chainId", []), "0x1");
  assert.equal(signal instanceof AbortSignal, true);
  assert.equal(signal.aborted, false);
  assert.equal(redirect, "error");
  assert.throws(() => createJsonRpcClient("https://rpc.example/secret", globalThis.fetch, { timeoutMs: 0 }), /outside policy/);
});

test("JSON-RPC client bounds and validates the complete response envelope", async () => {
  const request = (payload, responseOptions = {}, clientOptions = {}) => createJsonRpcClient(
    "https://rpc.example/secret",
    async () => new Response(
      typeof payload === "string" ? payload : JSON.stringify(payload),
      responseOptions,
    ),
    clientOptions,
  )("eth_chainId", []);

  await assert.rejects(
    () => request({ jsonrpc: "2.0", id: 2, result: "0x1" }, {
      headers: { "content-type": "application/json" },
    }),
    /response mismatch/,
  );
  await assert.rejects(
    () => request({ jsonrpc: "2.0", id: 1, result: "0x1", error: null }, {
      headers: { "content-type": "application/json" },
    }),
    /invalid result envelope/,
  );
  await assert.rejects(
    () => request({ jsonrpc: "2.0", id: 1, result: "0x1" }, {
      headers: { "content-type": "text/plain" },
    }),
    /non-JSON response/,
  );
  await assert.rejects(
    () => request("x".repeat(65), {
      headers: { "content-type": "application/json" },
    }, { maximumResponseBytes: 64 }),
    /size limit/,
  );
  await assert.rejects(
    () => createJsonRpcClient(
      "https://rpc.example/secret",
      async () => ({
        ok: true,
        redirected: true,
        headers: { get: () => null },
        text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1" }),
      }),
    )("eth_chainId", []),
    /redirected/,
  );
  assert.throws(
    () => createJsonRpcClient("https://rpc.example/secret", globalThis.fetch, {
      maximumResponseBytes: BIT_RPC_MAXIMUM_RESPONSE_BYTES + 1,
    }),
    /response-size limit is outside policy/,
  );
});
