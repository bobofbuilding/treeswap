export const NOTIFICATION_DELIVERY_ENABLED = false;
export const PENDING_EMAIL_RETENTION_SECONDS = 24 * 60 * 60;

export function pendingEmailExpiresAt(now = new Date()) {
  const observed = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(observed.getTime())) throw new TypeError("invalid notification time");
  return new Date(observed.getTime() + PENDING_EMAIL_RETENTION_SECONDS * 1_000).toISOString();
}

export function authorizeNotificationDelivery({ preferences, controls = {} }) {
  const reasons = [];
  if (NOTIFICATION_DELIVERY_ENABLED !== true) reasons.push("notification delivery is disabled in this build");
  if (preferences?.verificationStatus !== "verified" || !preferences?.verifiedAt) reasons.push("email ownership is unverified");
  if (preferences?.invoiceEmails !== true && preferences?.receiptEmails !== true) reasons.push("no notification consent is active");
  if (controls.unsubscribeEnforced !== true) reasons.push("unsubscribe enforcement is unavailable");
  if (controls.rateLimitPassed !== true) reasons.push("delivery rate limit is unavailable or exceeded");
  if (controls.retentionEnforced !== true) reasons.push("retention enforcement is unavailable");
  if (controls.accessAuditEnabled !== true) reasons.push("notification access audit is unavailable");
  if (controls.senderAuthenticated !== true) reasons.push("authenticated sender configuration is unavailable");
  return Object.freeze({ authorized: reasons.length === 0, reasons: Object.freeze(reasons) });
}
