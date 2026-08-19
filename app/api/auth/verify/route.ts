import { and, eq, gt, isNull } from "drizzle-orm";
import { cookies } from "next/headers";
import { SiweMessage } from "siwe";
import { getDb } from "@/db";
import { siweNonces } from "@/db/schema";
import { validateSiweMessageFields } from "@/lib/siwe-policy.mjs";
import {
  createSession,
  noStoreJson,
  REQUIRED_CHAIN_ID,
  requestIdentity,
  safeErrorMessage,
  sameOrigin,
  SESSION_COOKIE,
  SESSION_DURATION_SECONDS,
} from "@/lib/siwe-server";

type VerifyBody = { message?: string; signature?: string };

export async function POST(request: Request) {
  if (!sameOrigin(request)) return noStoreJson({ error: "Cross-origin sign-in rejected." }, { status: 403 });

  try {
    const body = (await request.json()) as VerifyBody;
    if (
      typeof body.message !== "string" ||
      body.message.length > 4_096 ||
      typeof body.signature !== "string" ||
      !/^0x[0-9a-fA-F]{130}$/.test(body.signature)
    ) {
      return noStoreJson({ error: "Invalid SIWE message or signature." }, { status: 400 });
    }

    const identity = requestIdentity(request);
    const message = new SiweMessage(body.message);
    const db = getDb();
    const now = new Date();
    const [nonceRecord] = await db
      .select()
      .from(siweNonces)
      .where(
        and(
          eq(siweNonces.nonce, message.nonce),
          isNull(siweNonces.consumedAt),
          gt(siweNonces.expiresAt, now.toISOString()),
        ),
      )
      .limit(1);

    if (!nonceRecord) return noStoreJson({ error: "This sign-in request expired or was already used." }, { status: 401 });
    const fieldPolicy = validateSiweMessageFields({ message, nonceRecord, identity, now: now.toISOString() });
    if (!fieldPolicy.valid || message.chainId !== REQUIRED_CHAIN_ID) {
      return noStoreJson({ error: "The SIWE message does not match this sign-in request." }, { status: 401 });
    }

    const verification = await message.verify({
      signature: body.signature,
      domain: nonceRecord.domain,
      nonce: nonceRecord.nonce,
      time: now.toISOString(),
    });
    if (!verification.success) return noStoreJson({ error: "Wallet signature verification failed." }, { status: 401 });

    const consumed = await db
      .update(siweNonces)
      .set({ consumedAt: now.toISOString() })
      .where(and(eq(siweNonces.nonce, nonceRecord.nonce), isNull(siweNonces.consumedAt)))
      .returning({ nonce: siweNonces.nonce });
    if (consumed.length !== 1) return noStoreJson({ error: "This sign-in request was already used." }, { status: 401 });

    const token = await createSession(message.address, message.chainId);
    const cookieStore = await cookies();
    cookieStore.set(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: true,
      sameSite: "strict",
      path: "/",
      maxAge: SESSION_DURATION_SECONDS,
    });

    return noStoreJson({
      session: {
        walletAddress: message.address.toLowerCase(),
        chainId: message.chainId,
        expiresAt: new Date(Date.now() + SESSION_DURATION_SECONDS * 1_000).toISOString(),
        notifications: null,
      },
    });
  } catch (error) {
    return noStoreJson({ error: safeErrorMessage(error) }, { status: 400 });
  }
}
