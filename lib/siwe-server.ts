import { and, eq, gt } from "drizzle-orm";
import type { ReadonlyRequestCookies } from "next/dist/server/web/spec-extension/adapters/request-cookies";
import { getDb } from "@/db";
import { authSessions, notificationPreferences } from "@/db/schema";
import { isAllowedTreeSwapOrigin } from "@/lib/siwe-policy.mjs";

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
  const origin = request.headers.get("Origin");
  return origin === new URL(request.url).origin;
}

export async function createSession(walletAddress: string, chainId: number): Promise<string> {
  const token = randomHex(32);
  const tokenHash = await sha256Hex(token);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_DURATION_SECONDS * 1_000);

  await getDb().delete(authSessions).where(eq(authSessions.walletAddress, walletAddress.toLowerCase()));
  await getDb().insert(authSessions).values({
    tokenHash,
    walletAddress: walletAddress.toLowerCase(),
    chainId,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  });

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
  const [session] = await db
    .select()
    .from(authSessions)
    .where(
      and(
        eq(authSessions.tokenHash, await sha256Hex(token)),
        gt(authSessions.expiresAt, new Date().toISOString()),
      ),
    )
    .limit(1);

  if (!session) return null;

  const [preferences] = await db
    .select()
    .from(notificationPreferences)
    .where(eq(notificationPreferences.walletAddress, session.walletAddress))
    .limit(1);

  return {
    walletAddress: session.walletAddress,
    chainId: session.chainId,
    expiresAt: session.expiresAt,
    notifications: preferences
      ? {
          email: preferences.email,
          invoiceEmails: preferences.invoiceEmails,
          receiptEmails: preferences.receiptEmails,
          verificationStatus: preferences.verificationStatus,
        }
      : null,
  };
}

export function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unexpected error";
  if (
    message.includes("D1 binding") ||
    message.includes("no such table") ||
    message.includes("notification_preferences") ||
    message.includes("siwe_nonces") ||
    message.includes("auth_sessions")
  ) {
    return "Account storage is not ready on this deployment.";
  }
  return "The account request could not be completed.";
}
