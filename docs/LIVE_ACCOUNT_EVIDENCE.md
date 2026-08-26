# Live account evidence

Status: passed on owner-only Sites version 11 at published source `e23f5a6d635f1cc33930b24f1f1748f8c46eab9f`; no funding authority.

TreeSwap keeps the public Vercel presentation account-disabled. Its private Sites deployment is the only current live account surface and is restricted to the project owner while authentication controls are qualified.

## What the exercise proves

`npm run qualify:live-account` refuses to run unless the checkout is the exact clean, published `main` commit and the operator supplies the exact Sites deployment version plus a short-lived owner bypass credential. The destination origin is compiled into policy and cannot be replaced through an environment variable.

The runner uses a fresh unfunded EOA held only in memory. It then checks:

1. the exact account capability reports durable storage enabled and email delivery disabled;
2. D1 issues a 128-bit, origin-bound, ten-minute SIWE challenge;
3. one valid signature consumes that challenge and a replay fails;
4. the session cookie is host-only, `Secure`, `HttpOnly`, `SameSite=Strict`, scoped to `/`, and limited to 24 hours;
5. the session persists across requests and creates no notification record;
6. a replacement session invalidates the prior session;
7. two simultaneous replacements serialize to exactly one valid session;
8. a cross-origin sign-out fails without deleting the session; and
9. same-origin sign-out removes the server session.

The final sign-out leaves no active evidence-client session. Consumed challenge rows contain no wallet address or signature and remain subject to the normal expiry-purge path.

## Secret handling

Run only from a trusted operator shell:

```bash
TREESWAP_ACCOUNT_BYPASS_TOKEN=<short-lived-owner-token> \
TREESWAP_ACCOUNT_DEPLOYMENT_VERSION=<exact-version> \
npm run qualify:live-account
```

The authorization token is accepted only through the process environment, removed from that environment before requests begin, never printed, and never written to evidence. The output schema also excludes the temporary wallet, nonce, SIWE plaintext, signature, cookie, email, and raw response bodies. Evidence is non-overwriting under ignored `outputs/`, whose directory and file modes are forced to `0700` and `0600`.

## What it does not prove

Passing live evidence does not authorize swaps, deposits, public account access, email delivery, or real funds. It does not replace:

- independently reviewed D1 access and least-privilege operator policy;
- continuous failure, latency, and unauthorized-access monitoring;
- retained and restored backup evidence;
- scheduled deletion evidence for expired nonces, sessions, and notification records; or
- independent authentication and privacy review.

These remain release blockers in the [launch checklist](./LAUNCH_CHECKLIST.md).

The repository now defines the aggregate-only fail-closed monitor and dual-route escalation semantics in [Account storage monitoring](./ACCOUNT_STORAGE_MONITORING.md). That protocol does not supply the missing deployed collectors, schedule, platform audit integration, paging delivery, retained window, or independent review.

## Retained checkpoint

The version 11 run passed all 13 exact checks. Its ignored mode-`0600` record independently reconstructs to:

```text
0xb21f0a51522d966d6b58c916373ccc06c1bb059b6b1252aecaf996588c51ac00
```

The Sites control plane separately reported custom access with exactly one owner, no allowed groups, and no external visitors. That observation is operator evidence, not an independent access-policy attestation. The public Vercel presentation returned the exact disabled account capability and no session.

An earlier version 9 attempt produced no evidence because the observer conservatively treated Cloudflare's separately scoped edge cookie, combined into one HTTP header, as part of the TreeSwap cookie. The corrected observer isolates the TreeSwap cookie, retains cleanup material before attribute inspection, and has regression tests for both the combined-header behavior and failure cleanup. Bounded expired-record deletion is qualified separately in [Account maintenance evidence](./ACCOUNT_MAINTENANCE_EVIDENCE.md).
