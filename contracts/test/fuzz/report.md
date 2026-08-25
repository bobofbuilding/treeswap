# Adversarial campaign report

Status: local campaign passing. This is development evidence, not an independent audit.

The Foundry suite contains 62 tests across the solver-funded vault, user-funded escrow, actual cross-direction registry integration, registry controls, and open gate. It includes 45 direction-specific escrow tests, a 1,000-case deposit/withdraw fuzz test, and six stateful invariants.

Each invariant ran 256 state-machine campaigns at depth 64, or 16,384 calls per property. The solver-vault handler interleaves deposits, withdrawals, reservations, claims, refunds, and signed-field mutation. The user-escrow handler interleaves opens, claims, refunds, and signed-field mutation. All six invariants passed. Expected rejected actions remain reverts in the solver-vault handler; mutated signed quotes are caught inside each handler and would fail the invariant if any were accepted.

The release stress rerun doubled this to 512 campaigns at depth 128, or 65,536 calls per property. All six properties passed again, including 11,000 solver-vault and 16,442 user-escrow signed-field mutation attempts in each corresponding state-machine sequence.

The campaign now covers:

- exact token liabilities in both directions;
- solver ownership of all withdrawable inventory;
- user-deposit conservation across claim, refund, and locked states;
- every signed field in both EIP-712 quote structures;
- cross-chain, cross-contract, cross-direction, nonce, and payment-hash replay;
- EOA and ERC-1271 signature failures;
- beneficiary-bound mempool relays;
- fee, price, per-swap, and epoch caps;
- exact claim/refund boundaries and pause-safe exits;
- fee-on-transfer and unexpected balance deltas; and
- the sealed two-escrow payment-hash registry.

The local Node suite separately covers RFQ suppression/substitution boundaries, invoice mutation, adapter authority, finality revalidation, SIWE mutations and session scope, privacy projection, notification exclusion, direct-send mutation, integer rounding, and quote/admission abuse.

The pinned mainnet-fork BIT snapshot, pause/unpause, implementation-slot, exact transfer-delta, both-direction settlement, refund, false-return implementation with locked-liability recovery, and cross-direction hash-reuse campaigns now pass. The standalone runner also pins Ethereum mainnet and the exact canonical source-block hash before Forge. Remaining external campaigns are genuine public-testnet finality through independent providers, Bitcoin regtest timing and LND failure drills on operator nodes, live credential rotation, and independent contract/Lightning review.
