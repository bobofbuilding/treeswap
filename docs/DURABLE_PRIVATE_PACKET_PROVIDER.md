# Durable private-packet provider

Status: a concrete fail-closed provider handler and packet-specific durable replay boundary are implemented and tested locally. They are not deployed and grant no funding authority.

## Purpose

The private-packet provider is the only service allowed to return the exact Lightning invoice, settlement preimage, or public EVM claim template required for one already-bound action. `lib/solver-private-packet-provider.mjs` accepts a signed short-lived request at the exact private HTTPS route, authenticates it, claims its request ID durably, reads the packet through a fixed reader object, validates every packet binding, consumes the claim, signs the response, and returns a non-cacheable bounded body.

The response never contains more authority than the request. A `SEND_PAYMENT` packet can contain only its exact invoice and bounded payment controls; a `SETTLE_INVOICE` packet can contain only the matching preimage; an `EVM_CLAIM` packet cannot contain a preimage or native-value transfer.

## Replay and failure ordering

The packet-specific store wraps the same strict SQLite replay implementation already used by the two independent daemon-evidence providers. It gives packet requests a separate uncopyable API, namespace, health schema, database instance, and deployment path. Production must give every packet provider its own persistent volume; sharing a file or volume with an evidence provider is unsupported.

The handler follows this order:

1. Verify the exact HTTPS origin, route, method, content type, content encoding, no-store request policy, body bound, clock, requester key, signature, and authority window.
2. Atomically claim the request ID before reading invoice or preimage material.
3. Read once through the original module-created packet reader under one hard request timeout.
4. Validate the packet and derive the response expiry as the minimum of request, quote, action, and configured response deadlines.
5. Atomically consume the exact requester key, request ID, full request digest, service time, and request expiry before signing.
6. Recheck time and withhold a response that expired during consumption or signing.

A concurrent duplicate, restart replay, copied claim, copied store or reader, storage failure, reader failure, timeout, abort, clock rollback, malformed packet, or expired response returns only the generic rejection body. A claimed request remains unavailable until expiry after an ambiguous provider failure; the requester must use a fresh signed request ID.

The replay database stores request identifiers, expiry, state, and clock high-water metadata. It does not store the packet, invoice, preimage, response, signature, intent, settlement, quote, or wallet address.

The official requester has separate production and test factories. Production
owns the fixed Node HTTPS transport, system clock, and cryptographic request-ID
source, accepts no dependency-injection fields, and rejects requester/provider
key reuse. Before dispatch it resolves the reviewed hostname once, requires
every answer to be private, pins one validated IP for the connection, and
preserves the hostname for TLS SNI and HTTP Host. The injected factory is
explicitly test-only and cannot enter either official operator runtime. This
protects request freshness, replay identity, and the repository DNS boundary;
it does not prove the deployed provider, DNS administration, TLS identity,
secret scope, network egress policy, or durable storage.

## Deployment gates

Local tests prove code behavior, not operator independence or durable operations. Before testnet value moves, deploy the reviewed handler with:

- an explicitly initialized private mode-`0600` database on a dedicated persistent volume;
- one replica and an external orchestrator fence until a distributed fence is reviewed;
- an independently reviewed packet reader and secret handle that cannot be reached by the web application;
- reviewed private DNS, certificate or service-mesh identity, trust-root control, encrypted transport, and egress policy;
- clock, volume, timeout, stale-claim, crash-loop, and health alerts that expose no packet contents;
- witnessed concurrent replay, volume loss, storage outage, clock rollback, process restart, host restart, backup/restore, timeout, abort, and certificate-rotation drills.

The current regtest coordinator smoke uses a process-local replay consumer and therefore is not durable-provider evidence. The provider tests use a real private SQLite file for restart persistence, but remain local repository evidence.
