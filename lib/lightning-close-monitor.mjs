import { createHash } from "node:crypto";

export const LIGHTNING_CLOSE_EVIDENCE_SCHEMA = "treeswap.lightning-close-recovery-evidence.v1";
export const LIGHTNING_CLOSE_PRIVACY = "aggregate-only-no-identifiers-or-sensitive-material";

export const DEFAULT_LIGHTNING_CLOSE_POLICY = Object.freeze({
  maximumUneconomicAnchorSats: 330,
  maximumUneconomicAnchorCount: 4,
  maximumUneconomicAnchorTotalSats: 1_320,
  maximumUneconomicAnchorAgeBlocks: 1_008,
  maximumUneconomicAnchorBroadcastAttempts: 1_008,
  minimumUneconomicAnchorDeadlineBlocks: 144,
});

const UINT64_MAX = (1n << 64n) - 1n;
const ZERO_DIGEST = `0x${"00".repeat(32)}`;
const evaluatedEvidence = new WeakSet();

function exactKeys(value, expected, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${name} fields are not exact`);
  }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function digest(value) {
  return `0x${createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex")}`;
}

function integer(value, name, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new TypeError(`${name} must be a non-negative safe integer at or below ${maximum}`);
  }
  return value;
}

function lndInteger(value, name, maximum = Number.MAX_SAFE_INTEGER) {
  if (typeof value === "number") return integer(value, name, maximum);
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new TypeError(`${name} must be a canonical LND integer`);
  }
  const parsed = BigInt(value);
  if (parsed > BigInt(maximum)) throw new RangeError(`${name} exceeds its bound`);
  return Number(parsed);
}

function lndUint(value, name) {
  if (typeof value === "number") {
    integer(value, name);
    return BigInt(value);
  }
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new TypeError(`${name} must be a canonical LND unsigned integer`);
  }
  const parsed = BigInt(value);
  if (parsed > UINT64_MAX) throw new RangeError(`${name} exceeds uint64`);
  return parsed;
}

function normalizePolicy(raw) {
  exactKeys(raw, Object.keys(DEFAULT_LIGHTNING_CLOSE_POLICY), "Lightning close policy");
  const policy = Object.freeze({
    maximumUneconomicAnchorSats: integer(raw.maximumUneconomicAnchorSats, "maximum uneconomic anchor sats"),
    maximumUneconomicAnchorCount: integer(raw.maximumUneconomicAnchorCount, "maximum uneconomic anchor count"),
    maximumUneconomicAnchorTotalSats: integer(raw.maximumUneconomicAnchorTotalSats, "maximum uneconomic anchor total sats"),
    maximumUneconomicAnchorAgeBlocks: integer(raw.maximumUneconomicAnchorAgeBlocks, "maximum uneconomic anchor age"),
    maximumUneconomicAnchorBroadcastAttempts: integer(
      raw.maximumUneconomicAnchorBroadcastAttempts,
      "maximum uneconomic anchor broadcast attempts",
    ),
    minimumUneconomicAnchorDeadlineBlocks: integer(
      raw.minimumUneconomicAnchorDeadlineBlocks,
      "minimum uneconomic anchor deadline margin",
    ),
  });
  if (Object.values(policy).some((value) => value === 0)
      || policy.maximumUneconomicAnchorTotalSats < policy.maximumUneconomicAnchorSats) {
    throw new RangeError("Lightning close policy bounds must be positive and internally consistent");
  }
  return policy;
}

function objectArray(value, name) {
  if (!Array.isArray(value) || value.some((entry) => !entry || typeof entry !== "object" || Array.isArray(entry))) {
    throw new TypeError(`${name} must be an array of objects`);
  }
  return value;
}

function normalizePendingChannels(raw) {
  exactKeys(raw, [
    "pending_closing_channels",
    "pending_force_closing_channels",
    "pending_open_channels",
    "total_limbo_balance",
    "waiting_close_channels",
  ], "LND pending channels response");
  const pendingOpen = objectArray(raw.pending_open_channels, "pending open channels");
  const pendingCooperativeClose = objectArray(raw.pending_closing_channels, "pending cooperative closes");
  const pendingForceClose = objectArray(raw.pending_force_closing_channels, "pending force closes");
  const waitingClose = objectArray(raw.waiting_close_channels, "waiting closes");
  let pendingHtlcs = 0;
  let pendingHtlcSats = 0n;
  for (const channel of pendingForceClose) {
    const htlcs = objectArray(channel.pending_htlcs, "force-close pending HTLCs");
    pendingHtlcs += htlcs.length;
    for (const htlc of htlcs) pendingHtlcSats += lndUint(htlc.amount, "pending HTLC amount");
  }
  return Object.freeze({
    totalLimboSats: lndUint(raw.total_limbo_balance, "total limbo balance"),
    pendingOpenChannels: pendingOpen.length,
    pendingCooperativeCloseChannels: pendingCooperativeClose.length,
    pendingForceCloseChannels: pendingForceClose.length,
    waitingCloseChannels: waitingClose.length,
    pendingHtlcs,
    pendingHtlcSats,
  });
}

function normalizePendingSweeps(raw) {
  exactKeys(raw, ["pending_sweeps"], "LND pending sweeps response");
  return Object.freeze(objectArray(raw.pending_sweeps, "pending sweeps").map((sweep) => Object.freeze({
    witnessType: String(sweep.witness_type ?? ""),
    amountSats: lndUint(sweep.amount_sat, "pending sweep amount"),
    broadcastAttempts: lndInteger(sweep.broadcast_attempts, "pending sweep broadcast attempts"),
    immediate: sweep.immediate,
    force: sweep.force,
    budgetSats: lndUint(sweep.budget, "pending sweep budget"),
    deadlineHeight: lndInteger(sweep.deadline_height, "pending sweep deadline height"),
    maturityHeight: lndInteger(sweep.maturity_height, "pending sweep maturity height"),
  })));
}

function emptySummary() {
  return {
    totalLimboSats: 0n,
    pendingOpenChannels: 0,
    pendingCooperativeCloseChannels: 0,
    pendingForceCloseChannels: 0,
    waitingCloseChannels: 0,
    pendingHtlcs: 0,
    pendingHtlcSats: 0n,
    pendingSweeps: 0,
    pendingSweepSats: 0n,
    timeSensitiveHtlcSweeps: 0,
    nonAnchorSweeps: 0,
    uneconomicAnchorSweeps: 0,
    uneconomicAnchorSats: 0n,
    oldestUneconomicAnchorAgeBlocks: 0,
    soonestUneconomicAnchorDeadlineBlocks: 0,
  };
}

function secretFree(evidence) {
  const serialized = JSON.stringify(evidence);
  if (/(channel.?point|outpoint|txid|node.?pub|payment|invoice|macaroon|preimage)/i.test(serialized)) {
    throw new Error("Lightning close evidence contains identifying or payment data");
  }
}

function buildEvidence({ observedAt, blockHeight, policyDigest, summary, reasons }) {
  const reasonCodes = Object.freeze([...new Set(reasons)].sort());
  const body = Object.freeze({
    schema: LIGHTNING_CLOSE_EVIDENCE_SCHEMA,
    status: reasonCodes.length === 0 ? "healthy" : "unsafe",
    observedAt,
    blockHeight,
    policyDigest,
    totalLimboSats: summary.totalLimboSats.toString(),
    pendingOpenChannels: summary.pendingOpenChannels,
    pendingCooperativeCloseChannels: summary.pendingCooperativeCloseChannels,
    pendingForceCloseChannels: summary.pendingForceCloseChannels,
    waitingCloseChannels: summary.waitingCloseChannels,
    pendingHtlcs: summary.pendingHtlcs,
    pendingHtlcSats: summary.pendingHtlcSats.toString(),
    pendingSweeps: summary.pendingSweeps,
    pendingSweepSats: summary.pendingSweepSats.toString(),
    timeSensitiveHtlcSweeps: summary.timeSensitiveHtlcSweeps,
    nonAnchorSweeps: summary.nonAnchorSweeps,
    uneconomicAnchorSweeps: summary.uneconomicAnchorSweeps,
    uneconomicAnchorSats: summary.uneconomicAnchorSats.toString(),
    oldestUneconomicAnchorAgeBlocks: summary.oldestUneconomicAnchorAgeBlocks,
    soonestUneconomicAnchorDeadlineBlocks: summary.soonestUneconomicAnchorDeadlineBlocks,
    reasonCodes,
    privacy: LIGHTNING_CLOSE_PRIVACY,
  });
  secretFree(body);
  const evidence = Object.freeze({ ...body, evidenceDigest: digest(body) });
  evaluatedEvidence.add(evidence);
  return evidence;
}

export function evaluateLightningCloseRecovery({
  pendingChannels,
  pendingSweeps,
  blockHeight: rawBlockHeight,
  observedAt: rawObservedAt,
  policy: rawPolicy = DEFAULT_LIGHTNING_CLOSE_POLICY,
}) {
  const observedAt = integer(rawObservedAt, "Lightning close observation timestamp");
  const blockHeight = integer(rawBlockHeight, "Lightning close observation block height");
  const reasons = [];
  const summary = emptySummary();
  let policy;
  let policyDigest = ZERO_DIGEST;
  try {
    policy = normalizePolicy(rawPolicy);
    policyDigest = digest({ schema: "treeswap.lightning-close-policy.v1", ...policy });
  } catch {
    reasons.push("LIGHTNING_CLOSE_POLICY_INVALID");
  }

  try {
    Object.assign(summary, normalizePendingChannels(pendingChannels));
  } catch {
    reasons.push("PENDING_CHANNEL_RESPONSE_INVALID");
  }
  if (summary.pendingCooperativeCloseChannels > 0) reasons.push("PENDING_COOPERATIVE_CLOSE");
  if (summary.pendingForceCloseChannels > 0) reasons.push("PENDING_FORCE_CLOSE");
  if (summary.waitingCloseChannels > 0) reasons.push("WAITING_CLOSE_CONFIRMATION");
  if (summary.pendingHtlcs > 0) reasons.push("TIME_SENSITIVE_PENDING_HTLC");
  if (summary.totalLimboSats > 0n) reasons.push("NONZERO_LIMBO_BALANCE");

  let sweeps = null;
  try {
    sweeps = normalizePendingSweeps(pendingSweeps);
  } catch {
    reasons.push("PENDING_SWEEP_RESPONSE_INVALID");
  }
  if (sweeps) {
    summary.pendingSweeps = sweeps.length;
    let soonestAnchorDeadline = null;
    for (const sweep of sweeps) {
      summary.pendingSweepSats += sweep.amountSats;
      if (/HTLC/i.test(sweep.witnessType)) {
        summary.timeSensitiveHtlcSweeps += 1;
        reasons.push("TIME_SENSITIVE_HTLC_SWEEP");
        continue;
      }
      if (sweep.witnessType !== "COMMITMENT_ANCHOR") {
        summary.nonAnchorSweeps += 1;
        reasons.push("PENDING_NON_ANCHOR_SWEEP");
        if (sweep.maturityHeight === 0 || sweep.maturityHeight <= blockHeight
            || (sweep.deadlineHeight > 0 && sweep.deadlineHeight <= blockHeight)) {
          reasons.push("OVERDUE_NON_ANCHOR_SWEEP");
        }
        continue;
      }

      summary.uneconomicAnchorSweeps += 1;
      summary.uneconomicAnchorSats += sweep.amountSats;
      const age = sweep.maturityHeight > 0 && sweep.maturityHeight <= blockHeight
        ? blockHeight - sweep.maturityHeight
        : 0;
      const deadline = sweep.deadlineHeight > blockHeight ? sweep.deadlineHeight - blockHeight : 0;
      summary.oldestUneconomicAnchorAgeBlocks = Math.max(summary.oldestUneconomicAnchorAgeBlocks, age);
      soonestAnchorDeadline = soonestAnchorDeadline === null ? deadline : Math.min(soonestAnchorDeadline, deadline);

      if (!policy) continue;
      if (sweep.amountSats === 0n || sweep.amountSats > BigInt(policy.maximumUneconomicAnchorSats)
          || sweep.budgetSats === 0n || sweep.budgetSats > sweep.amountSats
          || sweep.immediate !== false || sweep.force !== false
          || sweep.maturityHeight === 0 || sweep.maturityHeight > blockHeight) {
        reasons.push("UNECONOMIC_ANCHOR_EXCEPTION_INVALID");
      }
      if (age > policy.maximumUneconomicAnchorAgeBlocks) reasons.push("UNECONOMIC_ANCHOR_AGE_EXCEEDED");
      if (sweep.broadcastAttempts > policy.maximumUneconomicAnchorBroadcastAttempts) {
        reasons.push("UNECONOMIC_ANCHOR_RETRY_LIMIT_EXCEEDED");
      }
      if (deadline < policy.minimumUneconomicAnchorDeadlineBlocks) {
        reasons.push("UNECONOMIC_ANCHOR_DEADLINE_TOO_CLOSE");
      }
    }
    summary.soonestUneconomicAnchorDeadlineBlocks = soonestAnchorDeadline ?? 0;
  }

  if (policy && (summary.uneconomicAnchorSweeps > policy.maximumUneconomicAnchorCount
      || summary.uneconomicAnchorSats > BigInt(policy.maximumUneconomicAnchorTotalSats))) {
    reasons.push("UNECONOMIC_ANCHOR_AGGREGATE_LIMIT_EXCEEDED");
  }
  return buildEvidence({ observedAt, blockHeight, policyDigest, summary, reasons });
}

export function lightningCloseSafetyObservation(evidence) {
  if (!evaluatedEvidence.has(evidence)) throw new TypeError("Lightning close evidence must come from the evaluator");
  return Object.freeze({
    kind: "lightning-node",
    status: evidence.status,
    observedAt: evidence.observedAt,
    evidenceDigest: evidence.evidenceDigest,
  });
}
