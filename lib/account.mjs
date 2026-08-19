const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const NONCE_PATTERN = /^[a-zA-Z0-9]{8,}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Creates the EIP-4361 message presented by the wallet.
 * Email preferences are deliberately excluded from the authentication signature.
 */
export function buildSiweMessage({ domain, address, uri, nonce, issuedAt, expiresAt }) {
  if (!domain || !ADDRESS_PATTERN.test(address) || !NONCE_PATTERN.test(nonce)) {
    throw new Error("Invalid SIWE challenge");
  }
  if (new URL(uri).host !== domain) throw new Error("SIWE domain mismatch");

  return `${domain} wants you to sign in with your Ethereum account:\n${address}\n\nSign in to TreeSwap. This does not authorize a transaction or move funds.\n\nURI: ${uri}\nVersion: 1\nChain ID: 1\nNonce: ${nonce}\nIssued At: ${issuedAt}\nExpiration Time: ${expiresAt}`;
}

export function normalizeNotificationEmail(value) {
  return String(value ?? "").trim().toLowerCase();
}

export function isValidNotificationEmail(value) {
  const email = normalizeNotificationEmail(value);
  return email.length <= 254 && EMAIL_PATTERN.test(email);
}
