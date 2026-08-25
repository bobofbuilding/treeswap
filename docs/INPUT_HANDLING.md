# Untrusted text boundary

Status: enforced in the prototype and RFQ library.

Invoice descriptions, memos, solver labels, relay names, token metadata, rejection details, and wallet/provider errors are data. They are never commands and never authorize a transaction.

TreeSwap applies two different rules:

- Signed or digest-bound identifiers are accepted only in their exact canonical form. They are never silently rewritten because two different byte strings must not collapse into one signed identity.
- Human-facing labels are normalized, stripped of invisible and bidirectional control characters, collapsed to one line, and capped before display or logging. React renders them as text. Code must not use arbitrary HTML rendering for these fields.

Audit records are serialized as bounded JSON objects so a newline cannot forge another record. The trusted event label is immutable: caller fields with the same or a normalized-colliding name are skipped, enumerable accessors are never invoked, and a prototype-named key is retained as an ordinary own JSON field instead of changing or disappearing into the record prototype. Production log sinks must preserve the JSON structure and restrict access because escaping does not make sensitive data public-safe.

The site sends a restrictive content security policy, denies framing and object embedding, disables unnecessary browser permissions, and prevents MIME sniffing. Next.js requires inline bootstrap data, so the current script policy permits inline scripts; removing that allowance with per-response nonces is a defense-in-depth improvement, not a substitute for the text-only boundary.
