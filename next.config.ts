import type { NextConfig } from "next";

const isVercel = process.env.VERCEL === "1";
const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "style-src 'self' 'unsafe-inline' https://insights.bittrees.org",
  "script-src 'self' 'unsafe-inline' https://insights.bittrees.org",
  "connect-src 'self' https://insights.bittrees.org",
  "manifest-src 'self'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), geolocation=(), microphone=(), payment=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
];

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
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
