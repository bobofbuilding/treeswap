# Governance and deployment boundary

Status: immutable contracts and a fail-closed deployment policy are implemented. No production roles or contracts have been deployed.

TreeSwap’s two asset escrows have no administrator, proxy, fee setter, treasury setter, or pause function. Their token, payment-hash registry, safety gate, fee collector, reference limits, volume limits, and absolute fee caps are constructor immutables. The payment-hash registry accepts exactly two escrow consumers and is then irreversibly sealed.

Only the open gate has safety roles. Its controller and guardian must be different deployed contract wallets. Reopening always waits at least 24 hours, every opening expires within at most seven days, and every scheduling, opening, and halt emits an event. The guardian or controller may immediately block new exposure; neither can block a solver withdrawal, user refund, or valid claim already in progress.

Before deployment approval, a manifest must prove:

- distinct 2-of-3-or-stronger contract wallets for controller, guardian, and fee collection;
- exact escrow, gate, registry, BIT proxy, and BIT implementation code hashes;
- a sealed registry with exactly the two reviewed escrows;
- immutable non-proxy escrows, matching fee collector and gate, and fees no higher than 5%;
- a reviewed source commit and independent-review digest; and
- a closed gate with a delay and maximum-open window inside policy.

Live deployment remains blocked until those addresses, owners, thresholds, hashes, and review evidence exist and a watcher alerts on every role or gate event.
