import { cookies } from "next/headers";
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
    const session = await getCurrentSession(await cookies());
    return noStoreJson({ session });
  } catch (error) {
    return noStoreJson({ error: safeErrorMessage(error), session: null }, { status: 503 });
  }
}

export async function DELETE(request: Request) {
  if (!sameOrigin(request)) return noStoreJson({ error: "Cross-origin sign-out rejected." }, { status: 403 });

  try {
    const cookieStore = await cookies();
    await deleteSession(cookieStore.get(SESSION_COOKIE)?.value);
    cookieStore.delete(SESSION_COOKIE);
    return noStoreJson({ session: null });
  } catch (error) {
    return noStoreJson({ error: safeErrorMessage(error) }, { status: 503 });
  }
}
