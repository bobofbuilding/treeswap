import {
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign as signMessage,
  verify as verifyMessage,
} from "node:crypto";
import { getAddress, verifyTypedData } from "ethers";
import { isPrivateLndHostname } from "./lnd-rest-client.mjs";
import {
  buildSolverDaemonEvidenceApproval,
  solverDaemonEvidencePolicyDigest,
  verifySolverDaemonEvidence,
} from "./solver-daemon-evidence.mjs";

export const SOLVER_DAEMON_EVIDENCE_REQUEST_SCHEMA =
  "treeswap.solver-daemon-evidence-request.v1";
export const SOLVER_DAEMON_EVIDENCE_RESPONSE_SCHEMA =
  "treeswap.solver-daemon-evidence-response.v1";

const BYTES32 = /^0x[0-9a-f]{64}$/;
const NONZERO_BYTES32 = /^0x(?!0{64}$)[0-9a-f]{64}$/;
const KEY_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const UINT = /^(?:0|[1-9][0-9]*)$/;
const KINDS = new Set([
  "RESERVATION",
  "LIGHTNING_DISPATCH",
  "EVM_CLAIM_DISPATCH",
  "TERMINAL_COMPLETED",
  "TERMINAL_REFUNDED",
]);
const DIRECTIONS = new Set(["lightning-to-bit", "bit-to-lightning"]);
const APPROVER_ROLES = Object.freeze(["lightningOperator", "securityReviewer"]);
const MAX_REQUEST_LIFETIME_SECONDS = 30;
const MAX_RESPONSE_BYTES = 131_072;
const VERIFIED_CONTROL_SETS = new WeakSet();

function exactKeys(value, expected, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${name} fields are not exact`);
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function integer(value, name, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new TypeError(`${name} must be a non-negative safe integer at or below ${maximum}`);
  }
  return value;
}

function uint(value, name, { nonzero = false } = {}) {
  const raw = String(value ?? "");
  if (!UINT.test(raw)) throw new TypeError(`${name} must be a canonical unsigned decimal string`);
  const parsed = BigInt(raw);
  if (parsed > (1n << 256n) - 1n || (nonzero && parsed === 0n)) {
    throw new RangeError(`${name} is outside its range`);
  }
  return raw;
}

function bytes32(value, name, { nonzero = false } = {}) {
  const raw = String(value ?? "");
  if (!(nonzero ? NONZERO_BYTES32 : BYTES32).test(raw)) {
    throw new TypeError(`${name} must be ${nonzero ? "nonzero " : ""}lowercase bytes32`);
  }
  return raw;
}

function keyId(value, name) {
  const raw = String(value ?? "");
  if (!KEY_ID.test(raw)) throw new TypeError(`${name} is invalid`);
  return raw;
}

function address(value, name) {
  try {
    const normalized = getAddress(value).toLowerCase();
    if (normalized === "0x0000000000000000000000000000000000000000") throw new Error();
    return normalized;
  } catch {
    throw new TypeError(`${name} must be a nonzero Ethereum address`);
  }
}

function kind(value) {
  const raw = String(value ?? "");
  if (!KINDS.has(raw)) throw new RangeError("solver evidence request kind is unsupported");
  return raw;
}

function direction(value) {
  const raw = String(value ?? "");
  if (!DIRECTIONS.has(raw)) throw new RangeError("solver evidence request direction is unsupported");
  return raw;
}

function privateEd25519Key(value, name) {
  let key;
  try {
    key = value?.type === "private" ? value : createPrivateKey(value);
  } catch {
    throw new TypeError(`${name} is invalid`);
  }
  if (key.asymmetricKeyType !== "ed25519") throw new TypeError(`${name} must be Ed25519`);
  return key;
}

function publicEd25519Key(value, name) {
  let key;
  try {
    key = value?.type === "public" ? value : createPublicKey(value);
  } catch {
    throw new TypeError(`${name} is invalid`);
  }
  if (key.asymmetricKeyType !== "ed25519") throw new TypeError(`${name} must be Ed25519`);
  return key;
}

function signature(value, name) {
  const raw = String(value ?? "");
  const decoded = Buffer.from(raw, "base64");
  if (decoded.length !== 64 || decoded.toString("base64") !== raw) {
    throw new TypeError(`${name} is invalid`);
  }
  return decoded;
}

function canonicalize(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError("solver evidence message contains an unsafe number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("solver evidence message contains a non-plain object");
    }
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalize(value[key])}`
    )).join(",")}}`;
  }
  throw new TypeError("solver evidence message contains an unsupported value");
}

function requestMessage(payload) {
  return Buffer.from(`TreeSwap solver daemon evidence request v1\n${canonicalize(payload)}\n`, "utf8");
}

function normalizePolicyBinding(raw) {
  exactKeys(raw, [
    "chainId", "direction", "evidencePolicyDigest", "releaseRecordDigest", "settlementContract",
    "settlementContractCodeHash", "solver",
  ], "solver evidence policy binding");
  return Object.freeze({
    releaseRecordDigest: bytes32(raw.releaseRecordDigest, "request releaseRecordDigest", { nonzero: true }),
    evidencePolicyDigest: bytes32(raw.evidencePolicyDigest, "request evidencePolicyDigest", { nonzero: true }),
    chainId: uint(raw.chainId, "request chainId", { nonzero: true }),
    settlementContract: address(raw.settlementContract, "request settlementContract"),
    settlementContractCodeHash: bytes32(
      raw.settlementContractCodeHash,
      "request settlementContractCodeHash",
      { nonzero: true },
    ),
    solver: address(raw.solver, "request solver"),
    direction: direction(raw.direction),
  });
}

function normalizeReservationBinding(raw) {
  if (raw === null) return null;
  exactKeys(raw, [
    "reservationBlockHash", "reservationBlockNumber", "reservationId", "reservationTxHash",
  ], "solver evidence reservation binding");
  return Object.freeze({
    reservationId: bytes32(raw.reservationId, "request reservationId", { nonzero: true }),
    reservationTxHash: bytes32(raw.reservationTxHash, "request reservationTxHash", { nonzero: true }),
    reservationBlockNumber: integer(raw.reservationBlockNumber, "request reservationBlockNumber"),
    reservationBlockHash: bytes32(raw.reservationBlockHash, "request reservationBlockHash", { nonzero: true }),
  });
}

function normalizeSettlementBinding(raw) {
  exactKeys(raw, ["intentDigest", "reservation", "settlementId"], "solver evidence settlement binding");
  return Object.freeze({
    settlementId: bytes32(raw.settlementId, "request settlementId", { nonzero: true }),
    intentDigest: bytes32(raw.intentDigest, "request intentDigest", { nonzero: true }),
    reservation: normalizeReservationBinding(raw.reservation),
  });
}

function normalizeActionBinding(raw) {
  if (raw === null) return null;
  exactKeys(raw, [
    "actionId", "evmRefundAt", "lightningActionDeadline", "packetResponseDigest", "quoteExpiresAt",
  ], "solver evidence action binding");
  const action = Object.freeze({
    actionId: bytes32(raw.actionId, "request actionId", { nonzero: true }),
    packetResponseDigest: bytes32(raw.packetResponseDigest, "request packetResponseDigest", { nonzero: true }),
    quoteExpiresAt: integer(raw.quoteExpiresAt, "request quoteExpiresAt"),
    lightningActionDeadline: integer(raw.lightningActionDeadline, "request lightningActionDeadline"),
    evmRefundAt: integer(raw.evmRefundAt, "request evmRefundAt"),
  });
  if (action.quoteExpiresAt === 0 || action.lightningActionDeadline === 0 || action.evmRefundAt === 0
      || action.lightningActionDeadline >= action.evmRefundAt) {
    throw new Error("solver evidence request action deadlines are incomplete or unsafe");
  }
  return action;
}

function normalizeRequestPayload(raw) {
  exactKeys(raw, [
    "action", "expiresAt", "kind", "policy", "requestId", "requestedAt", "requesterKeyId",
    "schema", "settlement", "terminalState",
  ], "solver evidence request payload");
  if (raw.schema !== SOLVER_DAEMON_EVIDENCE_REQUEST_SCHEMA) {
    throw new TypeError("solver evidence request schema is unsupported");
  }
  const requestKind = kind(raw.kind);
  const requestedAt = integer(raw.requestedAt, "solver evidence requestedAt");
  const expiresAt = integer(raw.expiresAt, "solver evidence request expiresAt");
  if (expiresAt <= requestedAt || expiresAt - requestedAt > MAX_REQUEST_LIFETIME_SECONDS) {
    throw new RangeError("solver evidence request lifetime is outside policy");
  }
  const policy = normalizePolicyBinding(raw.policy);
  const settlement = normalizeSettlementBinding(raw.settlement);
  const action = normalizeActionBinding(raw.action);
  const isDispatch = requestKind === "LIGHTNING_DISPATCH" || requestKind === "EVM_CLAIM_DISPATCH";
  const isTerminal = requestKind === "TERMINAL_COMPLETED" || requestKind === "TERMINAL_REFUNDED";
  if (isDispatch !== (action !== null)) {
    throw new Error("solver evidence dispatch request action binding is inconsistent");
  }
  if (requestKind === "RESERVATION" && settlement.reservation !== null) {
    throw new Error("reservation discovery request cannot preselect an observed reservation");
  }
  if (requestKind !== "RESERVATION" && settlement.reservation === null) {
    throw new Error("solver evidence request requires the observed reservation");
  }
  const expectedTerminal = requestKind === "TERMINAL_COMPLETED"
    ? "COMPLETED"
    : requestKind === "TERMINAL_REFUNDED" ? "REFUNDED" : "NONE";
  if (String(raw.terminalState ?? "") !== expectedTerminal || isTerminal !== (expectedTerminal !== "NONE")) {
    throw new Error("solver evidence request terminal state is inconsistent");
  }
  return Object.freeze({
    schema: SOLVER_DAEMON_EVIDENCE_REQUEST_SCHEMA,
    requestId: bytes32(raw.requestId, "solver evidence requestId", { nonzero: true }),
    requesterKeyId: keyId(raw.requesterKeyId, "solver evidence requesterKeyId"),
    kind: requestKind,
    policy,
    settlement,
    action,
    terminalState: expectedTerminal,
    requestedAt,
    expiresAt,
  });
}

function policyBinding(rawPolicy) {
  const policy = deepFreeze(structuredClone(rawPolicy));
  const evidencePolicyDigest = solverDaemonEvidencePolicyDigest(policy);
  return Object.freeze({
    releaseRecordDigest: policy.releaseRecordDigest,
    evidencePolicyDigest,
    chainId: policy.chainId,
    settlementContract: policy.settlementContract,
    settlementContractCodeHash: policy.settlementContractCodeHash,
    solver: policy.solver,
    direction: policy.direction,
  });
}

function reservationBinding(settlement) {
  if (settlement?.reservationId === null || settlement?.reservationId === undefined) return null;
  return {
    reservationId: settlement.reservationId,
    reservationTxHash: settlement.reservationTxHash,
    reservationBlockNumber: settlement.reservationBlockNumber,
    reservationBlockHash: settlement.reservationBlockHash,
  };
}

export function buildSolverDaemonEvidenceRequest({
  kind: requestedKind,
  policy,
  settlement,
  action = null,
  packet = null,
  packetResponseDigest = null,
  terminalState = "NONE",
  requestId,
  requesterKeyId,
  requestedAt,
  expiresAt,
}) {
  const requestKind = kind(requestedKind);
  const isDispatch = requestKind === "LIGHTNING_DISPATCH" || requestKind === "EVM_CLAIM_DISPATCH";
  if (isDispatch && (!action || !packet || packetResponseDigest === null)) {
    throw new Error("solver evidence dispatch request requires its action and private packet");
  }
  const boundPolicy = policyBinding(policy);
  if (direction(settlement?.direction) !== boundPolicy.direction) {
    throw new Error("solver evidence request settlement direction is outside its policy");
  }
  return normalizeRequestPayload({
    schema: SOLVER_DAEMON_EVIDENCE_REQUEST_SCHEMA,
    requestId,
    requesterKeyId,
    kind: requestKind,
    policy: boundPolicy,
    settlement: {
      settlementId: settlement?.settlementId,
      intentDigest: settlement?.intentDigest,
      reservation: reservationBinding(settlement),
    },
    action: isDispatch ? {
      actionId: action.actionId,
      packetResponseDigest,
      quoteExpiresAt: packet.quoteExpiresAt,
      lightningActionDeadline: packet.lightningActionDeadline,
      evmRefundAt: packet.evmRefundAt,
    } : null,
    terminalState,
    requestedAt,
    expiresAt,
  });
}

export function signSolverDaemonEvidenceRequest(payload, privateKey) {
  const normalized = normalizeRequestPayload(payload);
  const key = privateEd25519Key(privateKey, "solver evidence requester private key");
  return Object.freeze({
    payload: normalized,
    signature: signMessage(null, requestMessage(normalized), key).toString("base64"),
  });
}

export function verifySolverDaemonEvidenceRequest({
  envelope,
  requesterPublicKey,
  expectedRequesterKeyId,
  now,
  maxClockSkewSeconds = 5,
}) {
  exactKeys(envelope, ["payload", "signature"], "solver evidence request envelope");
  const payload = normalizeRequestPayload(envelope.payload);
  const key = publicEd25519Key(requesterPublicKey, "solver evidence requester public key");
  const observedAt = integer(now, "solver evidence request verification time");
  const skew = integer(maxClockSkewSeconds, "solver evidence request clock skew", 60);
  if (payload.requesterKeyId !== keyId(expectedRequesterKeyId, "expected solver evidence requesterKeyId")
      || payload.requestedAt > observedAt + skew || payload.expiresAt <= observedAt) {
    throw new Error("solver evidence request is outside its authority window");
  }
  if (!verifyMessage(
    null,
    requestMessage(payload),
    key,
    signature(envelope.signature, "solver evidence request signature"),
  )) {
    throw new Error("solver evidence request signature is invalid");
  }
  return payload;
}

function assertRecordMatchesRequest(record, request) {
  const policy = request.policy;
  const settlement = request.settlement;
  for (const [field, expected] of Object.entries({
    kind: request.kind,
    releaseRecordDigest: policy.releaseRecordDigest,
    evidencePolicyDigest: policy.evidencePolicyDigest,
    chainId: policy.chainId,
    settlementContract: policy.settlementContract,
    settlementContractCodeHash: policy.settlementContractCodeHash,
    solver: policy.solver,
    direction: policy.direction,
    settlementId: settlement.settlementId,
    intentDigest: settlement.intentDigest,
    terminalState: request.terminalState,
  })) {
    const actual = field === "settlementContract" || field === "solver"
      ? address(record?.[field], `solver evidence record ${field}`)
      : String(record?.[field] ?? "");
    if (actual !== expected) throw new Error(`solver evidence response changed ${field}`);
  }
  if (settlement.reservation !== null) {
    for (const [field, expected] of Object.entries(settlement.reservation)) {
      if (record?.[field] !== expected) throw new Error(`solver evidence response changed ${field}`);
    }
  }
  if (request.action !== null) {
    for (const [field, expected] of Object.entries(request.action)) {
      if (record?.[field] !== expected) throw new Error(`solver evidence response changed ${field}`);
    }
  }
}

function approvalSigner(policy, role) {
  if (!APPROVER_ROLES.includes(role)) throw new Error("solver evidence response approval role is invalid");
  return address(policy.approvers?.[role], `solver evidence policy ${role}`);
}

export async function buildSolverDaemonEvidenceRouteResponse({
  requestEnvelope,
  requesterPublicKey,
  expectedRequesterKeyId,
  consumeRequest,
  record,
  policy,
  approval,
  now,
}) {
  const request = verifySolverDaemonEvidenceRequest({
    envelope: requestEnvelope,
    requesterPublicKey,
    expectedRequesterKeyId,
    now,
  });
  assertRecordMatchesRequest(record, request);
  exactKeys(approval, ["role", "signature", "signer"], "solver evidence route approval");
  const expectedSigner = approvalSigner(policy, approval.role);
  if (address(approval.signer, "solver evidence route signer") !== expectedSigner) {
    throw new Error("solver evidence route signer is not active");
  }
  const signingPayload = buildSolverDaemonEvidenceApproval({ record, policy });
  let recovered;
  try {
    recovered = verifyTypedData(
      signingPayload.domain,
      signingPayload.types,
      signingPayload.message,
      String(approval.signature ?? ""),
    ).toLowerCase();
  } catch {
    throw new Error("solver evidence route signature is invalid");
  }
  if (recovered !== expectedSigner) throw new Error("solver evidence route signature is invalid");
  if (typeof consumeRequest !== "function") {
    throw new TypeError("solver evidence route requires a durable request replay consumer");
  }
  const consumed = await consumeRequest(Object.freeze({
    requesterKeyId: request.requesterKeyId,
    requestId: request.requestId,
    expiresAt: request.expiresAt,
  }));
  if (consumed !== true) throw new Error("solver evidence request was already consumed");
  return deepFreeze({
    schema: SOLVER_DAEMON_EVIDENCE_RESPONSE_SCHEMA,
    requestEnvelope: structuredClone(requestEnvelope),
    record: structuredClone(record),
    approval: structuredClone(approval),
  });
}

function privateRouteUrl(origin) {
  let url;
  try {
    url = new URL(String(origin ?? ""));
  } catch {
    throw new Error("solver evidence route must use an isolated private HTTPS origin on port 443");
  }
  if (url.protocol !== "https:" || (url.port && url.port !== "443")
      || url.username || url.password || url.search || url.hash
      || (url.pathname !== "/" && url.pathname !== "") || !isPrivateLndHostname(url.hostname)) {
    throw new Error("solver evidence route must use an isolated private HTTPS origin on port 443");
  }
  return new URL("/v1/solver-daemon-evidence", url);
}

async function boundedJson(response, signal) {
  const type = String(response?.headers?.get?.("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
  if (type !== "application/json") throw new Error("solver evidence response content type is invalid");
  const cacheControl = String(response.headers.get("cache-control") ?? "").toLowerCase();
  if (!cacheControl.split(",").some((directive) => directive.trim() === "no-store")) {
    throw new Error("solver evidence response must disable storage");
  }
  const declaredHeader = response.headers.get("content-length");
  if (declaredHeader !== null && !/^[0-9]+$/.test(declaredHeader)) {
    throw new Error("solver evidence response content length is invalid");
  }
  const declared = Number(declaredHeader ?? 0);
  if (declared > MAX_RESPONSE_BYTES) throw new Error("solver evidence response is too large");
  if (!response.body) throw new Error("solver evidence route returned an empty response");
  const reader = response.body.getReader();
  const cancelOnAbort = () => { void reader.cancel().catch(() => {}); };
  if (signal.aborted) cancelOnAbort();
  else signal.addEventListener("abort", cancelOnAbort, { once: true });
  const chunks = [];
  let received = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("solver evidence response is too large");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    signal.removeEventListener("abort", cancelOnAbort);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("solver evidence route returned malformed JSON");
  }
}

function normalizeRouteResponse(raw, expectedRequestEnvelope, role) {
  exactKeys(raw, ["approval", "record", "requestEnvelope", "schema"], "solver evidence route response");
  if (raw.schema !== SOLVER_DAEMON_EVIDENCE_RESPONSE_SCHEMA) {
    throw new Error("solver evidence route response schema is unsupported");
  }
  exactKeys(raw.requestEnvelope, ["payload", "signature"], "solver evidence response request envelope");
  signature(raw.requestEnvelope.signature, "solver evidence response request signature");
  if (canonicalize(raw.requestEnvelope) !== canonicalize(expectedRequestEnvelope)) {
    throw new Error("solver evidence route response changed the request");
  }
  exactKeys(raw.approval, ["role", "signature", "signer"], "solver evidence response approval");
  if (raw.approval.role !== role) throw new Error("solver evidence route returned the wrong approver role");
  assertRecordMatchesRequest(raw.record, expectedRequestEnvelope.payload);
  return raw;
}

async function fetchRoute({ endpoint, role, requestEnvelope, requestImpl, signal, deadline }) {
  let response;
  try {
    response = await Promise.race([
      requestImpl(endpoint, {
        method: "POST",
        redirect: "error",
        headers: {
          accept: "application/json",
          "cache-control": "no-store",
          "content-type": "application/json",
        },
        body: JSON.stringify(requestEnvelope),
        signal,
      }),
      deadline,
    ]);
  } catch {
    throw new Error("solver evidence route transport failed");
  }
  if (response?.redirected === true || response?.status !== 200) {
    throw new Error("solver evidence route rejected the request");
  }
  return normalizeRouteResponse(await Promise.race([
    boundedJson(response, signal),
    deadline,
  ]), requestEnvelope, role);
}

function freshRequestId(randomBytesImpl) {
  const source = randomBytesImpl(32);
  if (!Buffer.isBuffer(source) && !(source instanceof Uint8Array)) {
    throw new Error("solver evidence request randomness source is invalid");
  }
  const value = Buffer.from(source);
  if (value.length !== 32) throw new Error("solver evidence request randomness source returned the wrong size");
  return `0x${value.toString("hex")}`;
}

export function createSolverDaemonEvidenceControls({
  policy: rawPolicy,
  routes,
  requesterPrivateKey,
  requesterKeyId,
  requestImpl = fetch,
  nowSeconds = () => Math.floor(Date.now() / 1_000),
  randomBytesImpl = randomBytes,
  requestTtlSeconds = 15,
  timeoutMs = 5_000,
}) {
  exactKeys(routes, APPROVER_ROLES, "solver evidence routes");
  const endpoints = Object.freeze(Object.fromEntries(APPROVER_ROLES.map((role) => [
    role,
    privateRouteUrl(routes[role]),
  ])));
  if (new Set(Object.values(endpoints).map((endpoint) => endpoint.origin)).size !== APPROVER_ROLES.length) {
    throw new Error("solver evidence approver routes must use distinct private origins");
  }
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    throw new Error("solver evidence TLS certificate verification is disabled");
  }
  const policy = deepFreeze(structuredClone(rawPolicy));
  solverDaemonEvidencePolicyDigest(policy);
  for (const role of APPROVER_ROLES) approvalSigner(policy, role);
  const privateKey = privateEd25519Key(requesterPrivateKey, "solver evidence requester private key");
  const activeRequesterKeyId = keyId(requesterKeyId, "solver evidence requesterKeyId");
  if (typeof requestImpl !== "function" || typeof nowSeconds !== "function" || typeof randomBytesImpl !== "function") {
    throw new TypeError("solver evidence client dependencies are invalid");
  }
  const ttl = integer(requestTtlSeconds, "solver evidence request lifetime", MAX_REQUEST_LIFETIME_SECONDS);
  if (ttl === 0) throw new RangeError("solver evidence request lifetime must be nonzero");
  const timeout = integer(timeoutMs, "solver evidence route timeout", 30_000);
  if (timeout === 0) throw new RangeError("solver evidence route timeout must be nonzero");

  async function requestEvidence(input) {
    if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
      throw new Error("solver evidence TLS certificate verification is disabled");
    }
    const requestedAt = integer(nowSeconds(), "solver evidence request time");
    const request = buildSolverDaemonEvidenceRequest({
      ...input,
      policy,
      requestId: freshRequestId(randomBytesImpl),
      requesterKeyId: activeRequesterKeyId,
      requestedAt,
      expiresAt: requestedAt + ttl,
    });
    const requestEnvelope = signSolverDaemonEvidenceRequest(request, privateKey);
    const controller = new AbortController();
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("solver evidence routes timed out"));
      }, timeout);
    });
    try {
      const responses = await Promise.all(APPROVER_ROLES.map((role) => fetchRoute({
        endpoint: endpoints[role],
        role,
        requestEnvelope,
        requestImpl,
        signal: controller.signal,
        deadline,
      })));
      if (canonicalize(responses[0].record) !== canonicalize(responses[1].record)) {
        throw new Error("solver evidence approver routes disagreed on the record");
      }
      const now = integer(nowSeconds(), "solver evidence response time");
      if (request.expiresAt <= now) throw new Error("solver evidence request expired before verification");
      return verifySolverDaemonEvidence({
        record: responses[0].record,
        policy,
        approvals: responses.map((response) => response.approval),
        now,
      });
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  const controls = Object.freeze({
    observeReservation: ({ settlement }) => requestEvidence({
      kind: "RESERVATION",
      settlement,
      terminalState: "NONE",
    }),
    authorizeLightning: ({ settlement, action, packet, packetResponseDigest }) => requestEvidence({
      kind: "LIGHTNING_DISPATCH",
      settlement,
      action,
      packet,
      packetResponseDigest,
      terminalState: "NONE",
    }),
    authorizeEvmClaim: ({ settlement, action, packet, packetResponseDigest }) => requestEvidence({
      kind: "EVM_CLAIM_DISPATCH",
      settlement,
      action,
      packet,
      packetResponseDigest,
      terminalState: "NONE",
    }),
    verifyAssets: ({ settlement, expectedTerminal }) => requestEvidence({
      kind: expectedTerminal === "COMPLETED" ? "TERMINAL_COMPLETED"
        : expectedTerminal === "REFUNDED" ? "TERMINAL_REFUNDED"
          : (() => { throw new RangeError("solver evidence terminal state is unsupported"); })(),
      settlement,
      terminalState: expectedTerminal,
    }),
  });
  VERIFIED_CONTROL_SETS.add(controls);
  return controls;
}

export function isSolverDaemonEvidenceControls(value) {
  return Boolean(value && VERIFIED_CONTROL_SETS.has(value));
}
