# Optional email boundary

Status: outbound delivery is hard-disabled. Pending addresses become ineligible after 24 hours and are purged when account storage is next accessed.

Email is not part of SIWE, an RFQ, a signed quote, an escrow, or a direct payment. It is a separate optional record keyed to an authenticated wallet and can be deleted immediately by that wallet. Invoice and receipt choices are independent.

Every attached or changed address is unverified and receives an exact 24-hour deletion deadline. Expired pending records are purged before account data is returned; this access-triggered purge is not a background deletion guarantee. No provider, template, send queue, or send path exists in this build, and the delivery policy denies sending even if callers claim that every other control passed.

Enabling delivery requires a reviewed code change plus all of these controls at once: proof that the user owns the email address, enforced unsubscribe, per-wallet and per-address rate limits, minimal retention and deletion jobs, access auditing, and authenticated sender configuration. Failure of any one check denies delivery. Until then, the UI promises no message and the email feature is not a dependency for swapping or direct sends.
