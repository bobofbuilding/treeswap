import assert from "node:assert/strict";
import test from "node:test";
import {
  NOTIFICATION_DELIVERY_ENABLED,
  PENDING_EMAIL_RETENTION_SECONDS,
  authorizeNotificationDelivery,
  pendingEmailExpiresAt,
} from "../lib/notification-policy.mjs";

test("hard-disables delivery even if every future control is nominally present", () => {
  const decision = authorizeNotificationDelivery({
    preferences: { verificationStatus: "verified", verifiedAt: "2026-08-19T00:00:00.000Z", invoiceEmails: true, receiptEmails: true },
    controls: { unsubscribeEnforced: true, rateLimitPassed: true, retentionEnforced: true, accessAuditEnabled: true, senderAuthenticated: true },
  });
  assert.equal(NOTIFICATION_DELIVERY_ENABLED, false);
  assert.equal(decision.authorized, false);
  assert.match(decision.reasons.join("; "), /disabled in this build/);
});

test("requires every ownership, consent, abuse, retention, and audit control", () => {
  const decision = authorizeNotificationDelivery({ preferences: { verificationStatus: "pending" }, controls: {} });
  for (const expected of ["unverified", "consent", "unsubscribe", "rate limit", "retention", "access audit", "sender"]) {
    assert.match(decision.reasons.join("; "), new RegExp(expected));
  }
});

test("gives pending email an exact 24-hour deletion deadline", () => {
  const now = new Date("2026-08-19T08:00:00.000Z");
  assert.equal(PENDING_EMAIL_RETENTION_SECONDS, 86_400);
  assert.equal(pendingEmailExpiresAt(now), "2026-08-20T08:00:00.000Z");
  assert.throws(() => pendingEmailExpiresAt("not-a-date"), /invalid notification time/);
});
