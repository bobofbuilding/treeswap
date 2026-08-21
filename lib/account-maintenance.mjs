export const ACCOUNT_MAINTENANCE_SCHEMA = "treeswap.account-maintenance.v1";
export const ACCOUNT_MAINTENANCE_ORIGIN = "https://treeswap-lightning-bit.bobofbuilding.chatgpt.site";
export const ACCOUNT_MAINTENANCE_BATCH_LIMIT = 100;

export const ACCOUNT_MAINTENANCE_SQL = Object.freeze({
  nonces: `DELETE FROM siwe_nonces
WHERE nonce IN (
  SELECT nonce FROM siwe_nonces
  WHERE expires_at <= ?
  ORDER BY expires_at ASC, nonce ASC
  LIMIT ?
)
RETURNING nonce`,
  sessions: `DELETE FROM auth_sessions
WHERE token_hash IN (
  SELECT token_hash FROM auth_sessions
  WHERE expires_at <= ?
  ORDER BY expires_at ASC, token_hash ASC
  LIMIT ?
)
RETURNING token_hash`,
  notifications: `DELETE FROM notification_preferences
WHERE wallet_address IN (
  SELECT wallet_address FROM notification_preferences
  WHERE retention_expires_at <= ?
  ORDER BY retention_expires_at ASC, wallet_address ASC
  LIMIT ?
)
RETURNING wallet_address`,
});

function exactTimestamp(value) {
  const raw = value instanceof Date ? value.toISOString() : String(value ?? "");
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== raw) {
    throw new TypeError("account maintenance requires a canonical UTC timestamp");
  }
  return raw;
}

function exactResultCount(value, name) {
  if (!value || typeof value !== "object" || value.success !== true || !Array.isArray(value.results)) {
    throw new Error(`account maintenance ${name} result is malformed`);
  }
  if (value.results.length > ACCOUNT_MAINTENANCE_BATCH_LIMIT) {
    throw new Error(`account maintenance ${name} exceeded its deletion bound`);
  }
  return value.results.length;
}

export function isExactAccountMaintenanceOrigin(requestUrl, originHeader) {
  try {
    return new URL(requestUrl).origin === ACCOUNT_MAINTENANCE_ORIGIN
      && originHeader === ACCOUNT_MAINTENANCE_ORIGIN;
  } catch {
    return false;
  }
}

export async function purgeExpiredAccountRecords(binding, observedAt = new Date()) {
  if (!binding || typeof binding.prepare !== "function" || typeof binding.batch !== "function") {
    throw new Error("account maintenance storage is unavailable");
  }
  const cutoff = exactTimestamp(observedAt);
  let results;
  try {
    const statements = Object.values(ACCOUNT_MAINTENANCE_SQL).map((sql) => {
      const prepared = binding.prepare(sql);
      if (!prepared || typeof prepared.bind !== "function") throw new Error("malformed prepared statement");
      return prepared.bind(cutoff, ACCOUNT_MAINTENANCE_BATCH_LIMIT);
    });
    results = await binding.batch(statements);
  } catch {
    throw new Error("account maintenance could not be completed");
  }
  if (!Array.isArray(results) || results.length !== 3) {
    throw new Error("account maintenance result set is malformed");
  }
  const deleted = Object.freeze({
    nonces: exactResultCount(results[0], "nonce"),
    sessions: exactResultCount(results[1], "session"),
    notifications: exactResultCount(results[2], "notification"),
  });
  return Object.freeze({
    schema: ACCOUNT_MAINTENANCE_SCHEMA,
    status: "completed",
    observedAt: cutoff,
    batchLimit: ACCOUNT_MAINTENANCE_BATCH_LIMIT,
    deleted,
    moreWorkPossible: Object.values(deleted).some((count) => count === ACCOUNT_MAINTENANCE_BATCH_LIMIT),
  });
}
