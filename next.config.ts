import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  typescript: {
    tsconfigPath: "tsconfig.vercel.json",
  },
  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;
