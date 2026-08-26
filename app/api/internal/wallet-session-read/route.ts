import { env } from "cloudflare:workers";
import {
  contractIntentWalletSessionRouteUnavailableResponse,
  createContractIntentWalletSessionRouteFromEnvironment,
} from "@/lib/contract-intent-wallet-session-route.mjs";

export const dynamic = "force-dynamic";

type WalletSessionRoute = Readonly<{
  handle(request: Request): Promise<Response>;
}>;

const lifecycle = new AbortController();
let service: WalletSessionRoute | null = null;
let initializationRejected = false;

function runtimeService(): WalletSessionRoute | null {
  if (initializationRejected) return null;
  if (service !== null) return service;
  try {
    service = createContractIntentWalletSessionRouteFromEnvironment({
      database: env.DB,
      environment: env as unknown as Record<string, unknown>,
      signal: lifecycle.signal,
    });
    return service;
  } catch {
    initializationRejected = true;
    return null;
  }
}

export async function POST(request: Request): Promise<Response> {
  const route = runtimeService();
  if (route === null) return contractIntentWalletSessionRouteUnavailableResponse();
  try {
    return await route.handle(request);
  } catch {
    return contractIntentWalletSessionRouteUnavailableResponse();
  }
}
