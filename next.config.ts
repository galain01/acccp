import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["pdf-lib"],
  outputFileTracingIncludes: {
    "/api/convert": ["./node_modules/pdf-lib/dist/pdf-lib.min.js"],
  },
};

export default nextConfig;
