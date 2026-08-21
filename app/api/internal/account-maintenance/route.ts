import { env } from "cloudflare:workers";
import { cookies } from "next/headers";
import { requireAccountStorage } from "@/db";
import {
  isExactAccountMaintenanceOrigin,
  purgeExpiredAccountRecords,
} from "@/lib/account-maintenance.mjs";
import { getCurrentSession, noStoreJson, safeErrorMessage } from "@/lib/siwe-server";

export async function POST(request: Request) {
  if (!isExactAccountMaintenanceOrigin(request.url, request.headers.get("Origin"))) {
    return noStoreJson({ error: "Account maintenance origin rejected." }, { status: 403 });
  }

  try {
    await requireAccountStorage();
    if (!await getCurrentSession(await cookies())) {
      return noStoreJson({ error: "Sign in with Ethereum first." }, { status: 401 });
    }
    return noStoreJson(await purgeExpiredAccountRecords(env.DB, new Date()));
  } catch (error) {
    return noStoreJson({ error: safeErrorMessage(error) }, { status: 503 });
  }
}
