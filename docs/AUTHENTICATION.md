# Authentication boundary

Status: EOA Sign-In with Ethereum is implemented for account metadata only. It never authorizes a swap or direct payment. Each deployment enables the account surface only after its database binding proves that all nonce, session, and notification tables exist; missing, malformed, partial, or unavailable storage disables sign-in before a wallet signature is requested.

TreeSwap accepts SIWE only on its two published HTTPS origins and explicit localhost development. Each message uses the EIP-4361 plaintext format, an unpredictable 128-bit server nonce, Ethereum mainnet, the exact origin URI and domain, an exact no-transaction statement, and the nonce's exact ten-minute expiry. Optional scheme, request ID, not-before, and resource fields are rejected rather than interpreted.

The nonce is atomically consumed once. Domain, URI, nonce, chain, statement, issuance, and expiry mutations fail; messages issued before the challenge, materially in the future, already expired, or longer than ten minutes fail. The client rechecks wallet address and chain after signing.

Sessions use a new random 256-bit bearer token stored only as a SHA-256 hash on the server. Creating one invalidates prior sessions for that wallet. Invalidation and insertion are one transactional D1 batch, so concurrent sign-ins serialize to one surviving wallet session. The cookie is `HttpOnly`, `Secure`, `SameSite=Strict`, has no `Domain`, uses the `__Host-` prefix, and expires after 24 hours. State-changing routes require an exact request origin, responses are not cacheable, and sign-out deletes the server record.

Contract-wallet SIWE remains unsupported until chain-aware EIP-1271 verification and invalidation monitoring exist. The Cloudflare deployment uses its durable D1 binding and migrations. Deployments without an equivalent binding, including the Vercel presentation deployment, report the account capability as disabled and do not issue nonces.

The credentialed `npm run qualify:live-account` exercise is fixed to the owner-only Sites origin and exact clean published `main`. It creates an unfunded, in-memory EOA, then proves the deployed capability, one-use nonce, hardened cookie, persistence, prior-session invalidation, serialized concurrent rotation, cross-origin sign-out rejection, server-side sign-out, and absence of an email record. The retained JSON contains no wallet, nonce, message, signature, cookie, authorization token, email, or funding capability; it is written once with mode `0600`. See [Live account evidence](./LIVE_ACCOUNT_EVIDENCE.md).

Owner-only Sites version 10 passed that complete lifecycle at published source `c693c02b2f469701827608aa4161fd5afc664afe`. The retained record independently reconstructs to `0x3460e8aca79798e2dc4e54fbc44abb93f00b34153914ca5581d6af99ff414ead`.

This exercise does not prove D1 access is independently governed, continuous database monitoring, backup/restore, scheduled expired-record purge, or independent identity/privacy review. Those remain mandatory before account data is accepted in a funded release.
