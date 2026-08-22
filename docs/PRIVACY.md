# Privacy boundary

Status: enforced in the privacy harness and the local authenticated multipath RFQ protocol. The public wire carries only the blind pricing request and blind offers; selected-solver encrypted disclosure is specified and locally guarded but not deployed. The prototype has no public intent relay or swap-history database.

TreeSwap uses two stages:

1. An unlinkable pricing request contains only a random pricing identifier, direction, exact output amount and unit, chain, user caps, capacity epoch, and short expiry. It contains no wallet address, payment hash, invoice digest, invoice, payee, route hints, email, or signature.
2. Competing solvers return blind price/capacity offers that contain none of those private fields. After the user chooses one solver, only that solver receives the private settlement identifier and addresses over an authenticated, encrypted, peer-bound channel. BIT → Lightning also discloses the user's fixed hash, digest, and invoice; Lightning → BIT keeps those fields empty until the selected solver creates its hold invoice. Its full executable quote must match the selected blind economic and capability terms. The public pricing identifier and private settlement identifier must differ.

The exact amount remains visible to competing solvers because it is necessary to produce an executable price. Final onchain settlement links the recipient, amount, timing, and eventually the Lightning preimage; TreeSwap cannot promise cross-network anonymity. Users should assume a selected solver can correlate both legs.

Raw invoices and private settlement packets are deleted within one hour of a terminal outcome. Unselected quotes and public pricing requests expire within ten minutes. Pending email is deleted within 24 hours and minimal receipts within 30 days unless a shorter legal or user-requested deletion applies. Preimages, macaroons, route hints, and full invoices are excluded from logs. The public-testnet [adoption policy](./ADOPTION_POLICY.md) binds the pricing, packet, and receipt ceilings, disables email delivery, forbids raw-invoice and preimage logging, and explicitly discloses selected-solver and onchain linkage. A production coordinator must enforce these deadlines in its storage layer and prove deletion before enabling swaps.
