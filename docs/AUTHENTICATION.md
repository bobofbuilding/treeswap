# Authentication boundary

Status: EOA Sign-In with Ethereum is implemented for account metadata only. It never authorizes a swap or direct payment.

TreeSwap accepts SIWE only on its two published HTTPS origins and explicit localhost development. Each message uses the EIP-4361 plaintext format, an unpredictable 128-bit server nonce, Ethereum mainnet, the exact origin URI and domain, an exact no-transaction statement, and the nonce's exact ten-minute expiry. Optional scheme, request ID, not-before, and resource fields are rejected rather than interpreted.

The nonce is atomically consumed once. Domain, URI, nonce, chain, statement, issuance, and expiry mutations fail; messages issued before the challenge, materially in the future, already expired, or longer than ten minutes fail. The client rechecks wallet address and chain after signing.

Sessions use a new random 256-bit bearer token stored only as a SHA-256 hash on the server. Creating one invalidates prior sessions for that wallet. The cookie is `HttpOnly`, `Secure`, `SameSite=Strict`, has no `Domain`, uses the `__Host-` prefix, and expires after 24 hours. State-changing routes require an exact request origin, responses are not cacheable, and sign-out deletes the server record.

Contract-wallet SIWE remains unsupported until chain-aware EIP-1271 verification and invalidation monitoring exist. Production account storage must be durable, access-controlled, monitored, and tested for atomic nonce consumption before the account feature is treated as available.
