import { and, eq, gt, lte } from "drizzle-orm";
import type { ReadonlyRequestCookies } from "next/dist/server/web/spec-extension/adapters/request-cookies";
import { getDb } from "@/db";
import { authSessions, notificationPreferences } from "@/db/schema";
import {
  isActiveMainnetSession,
  isAllowedTreeSwapOrigin,
  isExactRequestOrigin,
  ownsNotificationRecord,
} from "@/lib/siwe-policy.mjs";

export const SESSION_COOKIE = "__Host-treeswap_session";
export const SESSION_DURATION_SECONDS = 24 * 60 * 60;
export const SIWE_MESSAGE_TTL_SECONDS = 10 * 60;
export const REQUIRED_CHAIN_ID = 1;

export type TreeSwapSession = {
  walletAddress: string;
  chainId: number;
  expiresAt: string;
  notifications: {
    email: string;
    invoiceEmails: boolean;
    receiptEmails: boolean;
    verificationStatus: "pending" | "verified";
    retentionExpiresAt: string;
  } | null;
};

export function randomHex(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function requestIdentity(request: Request): { domain: string; origin: string; secure: boolean } {
  const url = new URL(request.url);
  const secure = url.protocol === "https:";
  if (!isAllowedTreeSwapOrigin(url.origin)) throw new Error("SIWE origin is not allowed");

  return {
    domain: url.host,
    origin: url.origin,
    secure,
  };
}

export function noStoreJson(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Cache-Control", "no-store, max-age=0");
  headers.set("Pragma", "no-cache");
  return Response.json(body, { ...init, headers });
}

export function sameOrigin(request: Request): boolean {
  return isExactRequestOrigin(request.url, request.headers.get("Origin"));
}

export async function createSession(walletAddress: string, chainId: number): Promise<string> {
  const token = randomHex(32);
  const tokenHash = await sha256Hex(token);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_DURATION_SECONDS * 1_000);
  const normalizedWalletAddress = walletAddress.toLowerCase();
  const db = getDb();

  // D1 batches are transactional. Keeping invalidation and insertion in one
  // batch means concurrent sign-ins serialize and only the last session for a
  // wallet remains valid.
  await db.batch([
    db.delete(authSessions).where(eq(authSessions.walletAddress, normalizedWalletAddress)),
    db.insert(authSessions).values({
      tokenHash,
      walletAddress: normalizedWalletAddress,
      chainId,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    }),
  ]);

  return token;
}

export async function deleteSession(token: string | undefined): Promise<void> {
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return;
  await getDb().delete(authSessions).where(eq(authSessions.tokenHash, await sha256Hex(token)));
}

export async function getCurrentSession(cookies: ReadonlyRequestCookies): Promise<TreeSwapSession | null> {
  const token = cookies.get(SESSION_COOKIE)?.value;
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;

  const db = getDb();
  const observedAt = new Date();
  const observedAtIso = observedAt.toISOString();
  const [session] = await db
    .select()
    .from(authSessions)
    .where(
      and(
        eq(authSessions.tokenHash, await sha256Hex(token)),
        gt(authSessions.expiresAt, observedAtIso),
      ),
    )
    .limit(1);

  if (!session || !isActiveMainnetSession(session, observedAt)) return null;

  await db.delete(notificationPreferences).where(
    and(
      eq(notificationPreferences.walletAddress, session.walletAddress),
      lte(notificationPreferences.retentionExpiresAt, observedAtIso),
    ),
  );

  const [preferences] = await db
    .select()
    .from(notificationPreferences)
    .where(eq(notificationPreferences.walletAddress, session.walletAddress))
    .limit(1);

  return {
    walletAddress: session.walletAddress,
    chainId: session.chainId,
    expiresAt: session.expiresAt,
    notifications: preferences && ownsNotificationRecord(session, preferences)
      ? {
          email: preferences.email,
          invoiceEmails: preferences.invoiceEmails,
          receiptEmails: preferences.receiptEmails,
          verificationStatus: preferences.verificationStatus,
          retentionExpiresAt: preferences.retentionExpiresAt,
        }
      : null,
  };
}

export function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unexpected error";
  if (
    message.includes("D1 binding") ||
    message.includes("Account feature") ||
    message.includes("no such table") ||
    message.includes("notification_preferences") ||
    message.includes("siwe_nonces") ||
    message.includes("auth_sessions")
  ) {
    return "Accounts are unavailable on this deployment.";
  }
  return "The account request could not be completed.";
}
