export const SIWE_STATEMENT = "Sign in to TreeSwap. This does not authorize a transaction or move funds.";
export const SIWE_CHAIN_ID = 1;
export const SIWE_MAX_TTL_SECONDS = 10 * 60;
export const SIWE_CLOCK_SKEW_SECONDS = 30;
export const TREESWAP_PRODUCTION_ORIGINS = Object.freeze(new Set([
  "https://treeswap.vercel.app",
  "https://treeswap-lightning-bit.bobofbuilding.chatgpt.site",
]));

function dateMillis(value) {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : NaN;
}

export function isAllowedTreeSwapOrigin(origin) {
  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  const local = url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  return local || TREESWAP_PRODUCTION_ORIGINS.has(url.origin);
}

export function isExactRequestOrigin(requestUrl, originHeader) {
  try {
    const requestOrigin = new URL(requestUrl).origin;
    return isAllowedTreeSwapOrigin(requestOrigin) && originHeader === requestOrigin;
  } catch {
    return false;
  }
}

export function isActiveMainnetSession(session, now = new Date()) {
  const observedAt = now instanceof Date ? now.getTime() : Date.parse(String(now));
  const expiresAt = Date.parse(String(session?.expiresAt ?? ""));
  return (
    /^0x[0-9a-f]{40}$/.test(String(session?.walletAddress ?? ""))
    && Number(session?.chainId) === SIWE_CHAIN_ID
    && Number.isFinite(observedAt)
    && Number.isFinite(expiresAt)
    && expiresAt > observedAt
  );
}

export function ownsNotificationRecord(session, preferences) {
  return Boolean(
    session?.walletAddress
    && preferences?.walletAddress
    && String(session.walletAddress).toLowerCase() === String(preferences.walletAddress).toLowerCase(),
  );
}

export function validateSiweMessageFields({ message, nonceRecord, identity, now }) {
  const reasons = [];
  const nowMs = dateMillis(now);
  const createdMs = dateMillis(nonceRecord?.createdAt);
  const nonceExpiryMs = dateMillis(nonceRecord?.expiresAt);
  const issuedMs = dateMillis(message?.issuedAt);
  const messageExpiryMs = dateMillis(message?.expirationTime);

  if (!Number.isFinite(nowMs) || !Number.isFinite(createdMs) || !Number.isFinite(nonceExpiryMs)) {
    reasons.push("invalid server challenge time");
  }
  if (message?.domain !== nonceRecord?.domain || message?.domain !== identity?.domain) reasons.push("domain changed");
  if (message?.uri !== nonceRecord?.uri || message?.uri !== identity?.origin) reasons.push("URI changed");
  if (Number(message?.chainId) !== SIWE_CHAIN_ID) reasons.push("chain changed");
  if (message?.version !== "1") reasons.push("version changed");
  if (message?.nonce !== nonceRecord?.nonce) reasons.push("nonce changed");
  if (nonceRecord?.consumedAt) reasons.push("nonce already consumed");
  if (message?.statement !== SIWE_STATEMENT) reasons.push("statement changed");
  if (message?.scheme !== undefined) reasons.push("unexpected scheme");
  if (message?.requestId !== undefined) reasons.push("unexpected request identifier");
  if (message?.notBefore !== undefined) reasons.push("unexpected not-before time");
  if (Array.isArray(message?.resources) && message.resources.length > 0) reasons.push("unexpected resources");
  if (!Number.isFinite(issuedMs) || !Number.isFinite(messageExpiryMs)) reasons.push("invalid message time");
  if (message?.expirationTime !== nonceRecord?.expiresAt) reasons.push("expiration changed");
  if (Number.isFinite(nowMs) && Number.isFinite(nonceExpiryMs) && nonceExpiryMs <= nowMs) reasons.push("nonce expired");
  if (Number.isFinite(issuedMs) && Number.isFinite(createdMs) && issuedMs < createdMs) reasons.push("issued before challenge");
  if (Number.isFinite(issuedMs) && Number.isFinite(nowMs) && issuedMs > nowMs + SIWE_CLOCK_SKEW_SECONDS * 1_000) {
    reasons.push("issued in the future");
  }
  if (Number.isFinite(messageExpiryMs) && Number.isFinite(issuedMs)) {
    if (messageExpiryMs <= issuedMs) reasons.push("invalid message lifetime");
    if (messageExpiryMs - issuedMs > SIWE_MAX_TTL_SECONDS * 1_000) reasons.push("message lifetime is too long");
  }
  return Object.freeze({ valid: reasons.length === 0, reasons: Object.freeze(reasons) });
}
