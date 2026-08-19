import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { getDb } from "@/db";
import { notificationPreferences } from "@/db/schema";
import { isValidNotificationEmail, normalizeNotificationEmail } from "@/lib/account.mjs";
import { NOTIFICATION_DELIVERY_ENABLED, pendingEmailExpiresAt } from "@/lib/notification-policy.mjs";
import {
  getCurrentSession,
  noStoreJson,
  safeErrorMessage,
  sameOrigin,
} from "@/lib/siwe-server";

type NotificationBody = {
  email?: string;
  invoiceEmails?: boolean;
  receiptEmails?: boolean;
};

export async function PUT(request: Request) {
  if (!sameOrigin(request)) return noStoreJson({ error: "Cross-origin preference update rejected." }, { status: 403 });

  try {
    const session = await getCurrentSession(await cookies());
    if (!session) return noStoreJson({ error: "Sign in with Ethereum first." }, { status: 401 });

    const body = (await request.json()) as NotificationBody;
    const email = normalizeNotificationEmail(body.email);
    const invoiceEmails = body.invoiceEmails === true;
    const receiptEmails = body.receiptEmails === true;

    if (!isValidNotificationEmail(email)) {
      return noStoreJson({ error: "Enter a valid email address." }, { status: 400 });
    }
    if (!invoiceEmails && !receiptEmails) {
      return noStoreJson({ error: "Choose invoices, transaction receipts, or both." }, { status: 400 });
    }

    const now = new Date().toISOString();
    const retentionExpiresAt = pendingEmailExpiresAt(now);
    const [preferences] = await getDb()
      .insert(notificationPreferences)
      .values({
        walletAddress: session.walletAddress,
        email,
        invoiceEmails,
        receiptEmails,
        verificationStatus: "pending",
        verifiedAt: null,
        updatedAt: now,
        retentionExpiresAt,
      })
      .onConflictDoUpdate({
        target: notificationPreferences.walletAddress,
        set: {
          email,
          invoiceEmails,
          receiptEmails,
          verificationStatus: "pending",
          verifiedAt: null,
          updatedAt: now,
          retentionExpiresAt,
        },
      })
      .returning();

    return noStoreJson({
      notifications: {
        email: preferences.email,
        invoiceEmails: preferences.invoiceEmails,
        receiptEmails: preferences.receiptEmails,
        verificationStatus: preferences.verificationStatus,
        retentionExpiresAt: preferences.retentionExpiresAt,
        deliveryEnabled: NOTIFICATION_DELIVERY_ENABLED,
      },
    });
  } catch (error) {
    return noStoreJson({ error: safeErrorMessage(error) }, { status: 503 });
  }
}

export async function DELETE(request: Request) {
  if (!sameOrigin(request)) return noStoreJson({ error: "Cross-origin preference update rejected." }, { status: 403 });

  try {
    const session = await getCurrentSession(await cookies());
    if (!session) return noStoreJson({ error: "Sign in with Ethereum first." }, { status: 401 });

    await getDb()
      .delete(notificationPreferences)
      .where(eq(notificationPreferences.walletAddress, session.walletAddress));
    return noStoreJson({ notifications: null });
  } catch (error) {
    return noStoreJson({ error: safeErrorMessage(error) }, { status: 503 });
  }
}
