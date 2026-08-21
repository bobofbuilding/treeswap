export const ACCOUNT_SCHEMA_PROBE = [
  "SELECT",
  "sessions.token_hash, sessions.wallet_address, sessions.chain_id, sessions.expires_at, sessions.created_at,",
  "preferences.wallet_address, preferences.email, preferences.invoice_emails, preferences.receipt_emails,",
  "preferences.verification_status, preferences.verified_at, preferences.updated_at, preferences.retention_expires_at,",
  "nonces.nonce, nonces.domain, nonces.uri, nonces.expires_at, nonces.consumed_at, nonces.created_at",
  "FROM auth_sessions AS sessions",
  "CROSS JOIN notification_preferences AS preferences",
  "CROSS JOIN siwe_nonces AS nonces",
  "WHERE 0",
].join(" ");

function capability(enabled) {
  return Object.freeze({
    schema: "treeswap.account-capability.v1",
    enabled,
    durableStorage: enabled,
    emailDeliveryEnabled: false,
  });
}

export async function inspectAccountStorage(binding) {
  if (!binding || typeof binding.prepare !== "function") return capability(false);

  try {
    const statement = binding.prepare(ACCOUNT_SCHEMA_PROBE);
    if (!statement || typeof statement.all !== "function") return capability(false);
    const response = await statement.all();
    if (!response || !Array.isArray(response.results)) return capability(false);
    return capability(true);
  } catch {
    return capability(false);
  }
}

export function requireAccountCapability(value) {
  if (
    value?.schema !== "treeswap.account-capability.v1"
    || value.enabled !== true
    || value.durableStorage !== true
    || value.emailDeliveryEnabled !== false
  ) {
    throw new Error("Account feature is disabled on this deployment.");
  }
  return value;
}
