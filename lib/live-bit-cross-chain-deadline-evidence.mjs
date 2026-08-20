import { coordinatorCommitmentDigest } from "./coordinator-store.mjs";
import { buildCrossChainDeadlineEvidence } from "./cross-chain-deadline-evidence.mjs";

const EVIDENCE_SCHEMA = "treeswap.live-bit-cross-chain-deadline-evidence.v1";
const SCOPE = "pinned-live-bit-fork-local-lnd-no-funding-authorization";
const ADDRESS = /^0x[0-9a-f]{40}$/;
const HASH = /^0x[0-9a-f]{64}$/;

const REQUIRED_TOKEN = Object.freeze({
  boundary: "pinned-live-bit-proxy-fork",
  sourceChainId: "1",
  forkBlockNumber: "25788856",
  forkBlockHash: "0xf327faf6fee57fdf66e5973d19364e662da009ba266ab32899e242a2b22aef89",
  proxyAddress: "0x57a447e4d5e18a9423408c365963a73f08b9d18c",
  proxyCodeHash: "0xf5648c6316e00873ef8427290251866b3675668407ecf526bf3f467578ff9adc",
  implementationAddress: "0xa27b118c0770939295f052ae1b003366e5ef806f",
  implementationCodeHash: "0x506816a3d5cf9e4f486659231f21540e9985d7fbc8438dbb385accd2e532b120",
  implementationSlot: "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
  symbol: "BIT",
  decimals: "18",
  paused: false,
});

function exactObject(value, keys, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${name} fields are not exact`);
  }
  return value;
}

function exactSource(source) {
  exactObject(source, ["branch", "clean", "commit", "published"], "source");
  if (source.branch !== "main" || source.clean !== true || source.published !== true) {
    throw new Error("live-BIT deadline evidence requires clean published main");
  }
  const commit = String(source.commit ?? "").toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new TypeError("source commit is invalid");
  return Object.freeze({ branch: "main", commit, clean: true, published: true });
}

function exactHash(value, name) {
  const result = String(value ?? "").toLowerCase();
  if (!HASH.test(result) || result === `0x${"00".repeat(32)}`) throw new TypeError(`${name} must be a nonzero bytes32`);
  return result;
}

function exactAddress(value, name) {
  const result = String(value ?? "").toLowerCase();
  if (!ADDRESS.test(result) || result === `0x${"00".repeat(20)}`) throw new TypeError(`${name} must be a nonzero address`);
  return result;
}

function exactToken(token) {
  exactObject(token, [
    "boundary",
    "decimals",
    "forkBlockHash",
    "forkBlockNumber",
    "implementationAddress",
    "implementationCodeHash",
    "implementationSlot",
    "paused",
    "proxyAddress",
    "proxyCodeHash",
    "sourceChainId",
    "symbol",
  ], "token");
  const normalized = Object.freeze({
    boundary: String(token.boundary),
    sourceChainId: String(token.sourceChainId),
    forkBlockNumber: String(token.forkBlockNumber),
    forkBlockHash: exactHash(token.forkBlockHash, "token.forkBlockHash"),
    proxyAddress: exactAddress(token.proxyAddress, "token.proxyAddress"),
    proxyCodeHash: exactHash(token.proxyCodeHash, "token.proxyCodeHash"),
    implementationAddress: exactAddress(token.implementationAddress, "token.implementationAddress"),
    implementationCodeHash: exactHash(token.implementationCodeHash, "token.implementationCodeHash"),
    implementationSlot: exactHash(token.implementationSlot, "token.implementationSlot"),
    symbol: String(token.symbol),
    decimals: String(token.decimals),
    paused: token.paused,
  });
  for (const [key, required] of Object.entries(REQUIRED_TOKEN)) {
    if (normalized[key] !== required) throw new Error(`token.${key} does not match the pinned live-BIT snapshot`);
  }
  return normalized;
}

export function buildLiveBitCrossChainDeadlineEvidence(input) {
  exactObject(input, ["observation", "source", "token"], "input");
  const source = exactSource(input.source);
  const token = exactToken(input.token);
  const deadlineEvidence = buildCrossChainDeadlineEvidence(input.observation);
  const evidence = Object.freeze({
    schema: EVIDENCE_SCHEMA,
    status: "passed",
    scope: SCOPE,
    source,
    token,
    deadlineEvidence,
    limitations: Object.freeze({
      publicTestnetIncluded: false,
      independentProvidersIncluded: false,
      productionInfrastructureIncluded: false,
      localForkProvider: true,
      simulatedEvmFinality: true,
      fundingAuthorization: false,
    }),
  });
  return Object.freeze({
    ...evidence,
    evidenceDigest: coordinatorCommitmentDigest(evidence),
  });
}

export const liveBitCrossChainDeadlinePolicy = REQUIRED_TOKEN;

export const liveBitCrossChainDeadlineSchemas = Object.freeze({
  evidence: EVIDENCE_SCHEMA,
  scope: SCOPE,
});
