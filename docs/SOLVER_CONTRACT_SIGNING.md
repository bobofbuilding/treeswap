# Solver contract signing

Status: an exact authenticated client, repository-only provider route, sealed solver signer, and private durable replay ledger are implemented and tested for Lightning → BIT and BIT → Lightning. No public listener, independently operated solver, reviewed production requester key, hardware-backed solver key, deployed volume, monitoring, or external review exists. The route cannot fund, dispatch, submit, or confirm a swap. Funded operation remains closed.

## Purpose and boundary

After a user selects a competing signed RFQ and authorizes its exact executable terms, TreeSwap derives the direction-specific escrow typed data. The selected solver must sign that exact EIP-712 contract intent before the user's wallet can open the escrow.

`lib/solver-contract-signing-transport.mjs` carries only that prepared contract intent to the selected solver's capability-bound HTTPS origin. It does not let the coordinator choose a different solver, change the quote, use the signature for another settlement, request an arbitrary digest, submit a wallet transaction, contact LND, or authorize funding.

The future BIT/WBTC pool is not involved. While absent it contributes no price evidence. If separately launched and reviewed, it may contribute one request-sized price-risk signal before solver selection; it cannot sign an intent, choose a solver, settle a swap, or satisfy price quorum by itself.

## Exact request

The client accepts only the original same-process prepared contract intent and original verified solver capability. It independently revalidates their shared direction, chain, escrow, runtime code hash, solver, typed-data digest, capability digest, selected offer, settlement, and expiry.

The request binds:

- one stable request ID derived from the settlement, offer, capability, contract-intent digest, and requester key;
- the complete normalized EIP-712 domain and message;
- the offchain user-authorization digest and distinct onchain contract-intent digest;
- the reviewed escrow runtime code hash;
- a maximum 30-second request lifetime; and
- the allowlisted Ed25519 requester identity and signature.

An ambiguous retry uses the original byte-identical request and original capability. A copied prepared artifact, copied capability, changed capability on retry, concurrent send, changed digest, extra field, accessor, malformed key, expiry, or response-authority substitution fails closed.

## Provider and key custody

`lib/solver-contract-signing-provider.mjs` exposes a strict non-listening `POST /v1/sign-contract-intent` handler. It verifies the canonical capability authority, exact origin and path, bounded identity JSON, requester signature, request lifetime, and typed-data digest before acquiring a durable signing lease.

The provider receives a sealed signer object, not raw EVM key bytes. The production key loader accepts only a bounded owner-controlled mode-`0600` regular file inside a mode-`0700` owner-controlled directory, rejects symlinks and read-time replacement, and retains the `SigningKey` only in module-private memory. The signer exports no private key and cannot dispatch a wallet or Lightning action. An injected-key signer is separately named test-only.

The provider's Ed25519 response key must equal the capability's endpoint key. The EVM key must recover to the capability's solver EOA. Key substitution rejects at construction, before a request can be served.

## Durable replay and recovery

The strict SQLite ledger is initialized explicitly with schema and clock metadata in one transaction. A private persistent deployment requires a mode-`0700` owner-controlled parent and mode-`0600` database. In-memory initialization is test-only.

Before signing, the provider atomically claims the unique request, contract-intent digest, and settlement. It commits the complete endpoint-signed response under `synchronous=FULL` before returning it. The same request replays the exact stored bytes after timeout, lost response, process restart, or client retry. A conflicting request, intent, or settlement cannot be re-signed. A claimed request whose lease expired enters conservative recovery; it never silently creates a second identity.

Startup and every transition run structural and SQLite integrity checks. A persisted clock high-water mark rejects time rollback. The database contains no EVM private key. The client still independently verifies the endpoint signature and recovers the exact EIP-712 solver signature, so a changed replay record cannot become contract authority.

## Local adversarial evidence

Both directions prove:

- mutation of the contract-intent digest rejects before signing;
- copied same-process artifacts and solver-key substitution reject;
- a response lost after provider commit is replayed after closing and reopening the database;
- the replay authorizes only the original prepared contract intent;
- the BIT → Lightning beneficiary remains the authenticated solver EOA;
- no key bytes are present in the durable database; and
- every wallet, Lightning, dispatch, and funding authority flag remains false.

## Remaining release gates

Before capped funded testnet use:

1. deploy the handler behind reviewed TLS at each capability-bound solver origin with no redirect or shared trust-domain shortcut;
2. use distinct production requester and endpoint keys, a hardware-backed or equivalently reviewed EVM signer, two-person custody, rotation, revocation, backup, and recovery procedures;
3. deploy the private replay volume and prove restart, host loss, backup/restore, full disk, clock rollback, lease expiry, ambiguous response, key rotation, and stale-capability behavior;
4. operate at least two genuinely independent solvers and retain exact request/response and aggregate monitoring evidence without logging private swap terms or keys;
5. independently review protocol, application-security, privacy, key-custody, and operations boundaries; and
6. complete strict user-wallet submission plus two-provider canonical finalized escrow reservation evidence before permitting the direction-correct Lightning action.

Passing this repository checkpoint does not open a solver endpoint, create a pool, move BIT, pay Lightning, activate the gate, or authorize funding.
