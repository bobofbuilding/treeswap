# BIT/WBTC market reference

Status: repository verifier and fail-closed price-source identity checks implemented, including the upgradeable BIT boundary. No canonical BIT/WBTC pool exists yet, so this source is unavailable and cannot authorize a funded quote.

## Product priority

TreeSwap remains a Lightning ↔ BIT intent bridge. A future BIT/WBTC pool is a market-observation venue that helps solvers price BIT in bitcoin terms; it is not the bridge settlement path, a protocol-owned redemption promise, or a replacement for competing signed solver quotes.

The launch order is deliberately narrow:

1. keep the current `1 BIT = 100 sats` value labeled as a non-binding reference;
2. deploy and observe the BIT/WBTC pool without granting it quote authority;
3. allow the pool to contribute one request-sized price signal only after the complete policy below passes; and
4. keep funded public execution closed until at least three genuinely independent executable BIT price venues/control domains agree.

Two RPC providers reading the same pool prove observation agreement, not two prices. The WBTC/BTC conversion feed is a peg guard inside the same derived signal, not another BIT venue.

## Derived price

`lib/bit-wbtc-market-reference.mjs` uses integer arithmetic only. It first requires both providers to observe the policy-pinned BIT proxy runtime, EIP-1967 implementation slot, implementation address and runtime, `BIT` symbol, 18 decimals, and unpaused state at the same finalized block. It separately requires the canonical policy-pinned WBTC runtime and a live `WBTC` / 8-decimal / unpaused state. It then reconstructs the Uniswap v3 arithmetic-mean tick from the configured TWAP interval, converts the tick into WBTC atomic units per whole BIT, and checks a direction-specific executable probe for exactly the requested BIT amount against that TWAP. The original signal is usable only for the same request direction, BIT wei, and Lightning sats.

The final reference is:

`msats per BIT = probe WBTC atomic per BIT × WBTC/BTC answer × 1,000 ÷ 10^8`

WBTC atomic units have the same `10^-8` scale as bitcoin satoshis. The separately pinned WBTC/BTC feed accounts for peg drift; if it is stale, incomplete, upgraded without review, or outside the signed peg band, the source fails closed. Chainlink currently lists an [Ethereum WBTC/BTC feed](https://data.chain.link/feeds/ethereum/mainnet/wbtc-btc), but the exact proxy, underlying aggregator, code hashes, decimals, freshness policy, and independently reproduced observation must be pinned at rollout rather than copied from this document.

## Mandatory source checks

One pool signal is eligible only when all of these hold:

- the policy, provider observation, and exact request use the supported versioned schemas; unknown or unversioned formats fail closed before signature or price evaluation;
- the chain, canonical BIT proxy runtime, EIP-1967 implementation slot/address/runtime, `BIT` / `18` / `false` token state, canonical WBTC runtime and `WBTC` / `8` / `false` state, canonical Uniswap v3 factory/runtime, factory-returned pool, token ordering, fee tier, pool runtime and initialization transaction/time, quoter, and quoter runtime match a signed policy;
- two or more separately governed provider organizations are pinned by signer and organization in the policy, EIP-712-sign the exact observation, and agree on the same recent finalized block and every raw pool, probe, and feed field;
- finality lag and finalized-block age are inside policy;
- the pool has at least seven days of history, the configured observation cardinality, the minimum harmonic-mean active liquidity, and a minimum wide-range-liquidity measurement whose exact reviewed methodology digest is pinned;
- the TWAP window is at least thirty minutes;
- spot/TWAP and request-sized probe/TWAP deviations remain inside policy;
- the exact direction and requested BIT amount are covered by the executable probe; Lightning → BIT is an exact-output BIT buy and BIT → Lightning is an exact-input BIT sale, so an oversized, undersized, one-leg, or reversed quoter result is not accepted. The probe's actual WBTC/BTC notional remains visible even when a favorable exact-output quote is below the TreeSwap Lightning amount; the request-bound risk gate separately compares the TreeSwap quote against the independent median;
- the WBTC/BTC feed proxy and underlying aggregator both match reviewed addresses and code hashes, its round is complete and fresh, and its peg remains inside policy; and
- the evidence digest binds the complete policy, request, common observation, provider set, venue, control domain, derived values, and explicit `fundingAuthorization: false` scope.
- the risk gate receives the original module-private verified signal in the same process; a copied or serialized lookalike cannot claim pool provenance.

Uniswap v3 stores historical price and liquidity accumulators for on-demand TWAP queries, but a TWAP is not automatically safe for a young or shallow pool. Uniswap's own proof-of-stake analysis identifies wide-range liquidity as the best current manipulation-cost mitigation. See the [Uniswap v3 whitepaper](https://blog.uniswap.org/whitepaper-v3.pdf) and [Uniswap's PoS oracle analysis](https://blog.uniswap.org/uniswap-v3-oracles).

## Solver and risk-gate behavior

The pool-derived result is one `bit-wbtc-twap-probe` signal. The general risk gate requires its original module-private provenance to match the exact current direction, net BIT amount, and Lightning amount, then binds that request into risk-attestation v2. Every eligible price signal also binds its validity, source-policy digest, evidence digest, venue ID, control-domain ID, and executable depth. The source-policy digest must be explicitly allowlisted by the signed release risk policy. Duplicate sources, venues, or control domains do not count toward the minimum source total.

The complete price-candidate set is capped at 64 before verification work. Exact repeats collapse to one observation, while conflicting fresh observations that reuse any source, venue, control domain, or operator organization are quarantined symmetrically and halt authorization. The caller cannot choose a pool or venue price by placing its preferred signed observation first. Surviving independent signals are ordered canonically before the median and spread are computed.

Other venues cannot enter as arbitrary coordinator JSON. Each must produce a short-lived EIP-712-signed observation through the executable-venue verifier, and only its original same-process verified signal is eligible. This prevents two invented sources from joining the real pool signal to manufacture a three-source quorum.

Solvers still choose their own exact amount and fee and compete to fill the user's intent. TreeSwap uses the market signals only as a circuit breaker and quote-band input. The actual swap's implied sats-per-net-BIT price must remain within the signed market-deviation ceiling around the independent median, so the fixed reference band and live market band cannot be exploited at opposite extremes. BIT → Lightning keeps the higher base fee because it consumes scarce outbound Lightning capacity.

TreeSwap never silently falls back from an unavailable or unsafe market source to the 100-sat reference. Bootstrap testing may use operator-owned inventory under the separately signed tiny testnet caps, but the missing pool or missing independent venues keeps public funded execution closed.

Any BIT pause, proxy-runtime change, implementation-slot change, implementation-runtime change, symbol change, or decimal change invalidates the pool policy and closes this source. Any WBTC runtime, symbol, decimal, or pause-state change also closes the source. A new token boundary may contribute only after a new reviewed policy digest is signed and explicitly allowlisted by a later release.

## Pool rollout gate

Before this source can become live, operators must publish and independently review:

1. the exact BIT proxy and implementation boundary, pool creation transaction, factory-derived address, token ordering, fee tier, runtime hash, initialization price, and LP ownership/control disclosures;
2. observation-cardinality expansion and at least seven continuous days of finalized observations;
3. active and wide-range liquidity measurements plus manipulation-cost analysis relative to the maximum TreeSwap inventory at risk;
4. request-sized probes for both bridge directions through two independent authenticated providers;
5. exact WBTC token runtime and live `WBTC` / `8` / `false` state, WBTC/BTC feed proxy, underlying aggregator, code hashes, heartbeat/freshness, and depeg or pause response;
6. the other independent executable BIT price venues needed to reach the risk policy's minimum; and
7. alert drills showing that pool, feed, finality, liquidity, deviation, provider, or source-independence failure closes new quotes while existing exits remain available.

The reviewed pool policy—including its provider signer roster, pool initialization time, code hashes, freshness limits, and liquidity thresholds—must be committed by the signed `riskPolicyDigest` in the release record before it can contribute a signal.

Pool liquidity and bridge inventory must use separate accounting and authority. No LP deposit may automatically become TreeSwap solver inventory, and no bridge release may silently change the pool policy or its minimum-liquidity thresholds.
