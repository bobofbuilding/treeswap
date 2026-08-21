import { lt } from "drizzle-orm";
import { getDb, requireAccountStorage } from "@/db";
import { siweNonces } from "@/db/schema";
import {
  noStoreJson,
  randomHex,
  requestIdentity,
  safeErrorMessage,
  SIWE_MESSAGE_TTL_SECONDS,
} from "@/lib/siwe-server";

export async function GET(request: Request) {
  try {
    const { domain, origin } = requestIdentity(request);
    await requireAccountStorage();
    const db = getDb();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + SIWE_MESSAGE_TTL_SECONDS * 1_000);
    const nonce = randomHex(16);

    await db.delete(siweNonces).where(lt(siweNonces.expiresAt, now.toISOString()));
    await db.insert(siweNonces).values({
      nonce,
      domain,
      uri: origin,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    });

    return noStoreJson({ nonce, domain, uri: origin, expiresAt: expiresAt.toISOString() });
  } catch (error) {
    return noStoreJson({ error: safeErrorMessage(error) }, { status: 503 });
  }
}
