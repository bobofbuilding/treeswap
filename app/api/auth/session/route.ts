import { cookies } from "next/headers";
import { getAccountCapability } from "@/db";
import {
  deleteSession,
  getCurrentSession,
  noStoreJson,
  safeErrorMessage,
  sameOrigin,
  SESSION_COOKIE,
} from "@/lib/siwe-server";

export async function GET() {
  try {
    const account = await getAccountCapability();
    if (!account.enabled) return noStoreJson({ account, session: null });
    const session = await getCurrentSession(await cookies());
    return noStoreJson({ account, session });
  } catch (error) {
    return noStoreJson({ error: safeErrorMessage(error), session: null }, { status: 503 });
  }
}

export async function DELETE(request: Request) {
  if (!sameOrigin(request)) return noStoreJson({ error: "Cross-origin sign-out rejected." }, { status: 403 });

  try {
    const account = await getAccountCapability();
    const cookieStore = await cookies();
    if (account.enabled) await deleteSession(cookieStore.get(SESSION_COOKIE)?.value);
    cookieStore.delete(SESSION_COOKIE);
    return noStoreJson({ account, session: null });
  } catch (error) {
    return noStoreJson({ error: safeErrorMessage(error) }, { status: 503 });
  }
}
