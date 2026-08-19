import type { NextConfig } from "next";

const isVercel = process.env.VERCEL === "1";

const nextConfig: NextConfig = {
  typescript: {
    tsconfigPath: "tsconfig.vercel.json",
  },
  turbopack: {
    root: process.cwd(),
    ...(isVercel
      ? {
          resolveAlias: {
            "cloudflare:workers": "./lib/cloudflare-workers-stub.mjs",
          },
        }
      : {}),
  },
};

export default nextConfig;
