import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["pdf-lib", "pdfjs-dist", "@napi-rs/canvas"],
  outputFileTracingIncludes: {
    "/api/convert": [
      "./node_modules/pdf-lib/dist/pdf-lib.min.js",
      "./lib/pdf-rendering-child.mjs",
      "./lib/pdf-image-alternatives.mjs",
      "./node_modules/pdfjs-dist/package.json",
      "./node_modules/pdfjs-dist/legacy/build/*.mjs",
      "./node_modules/pdfjs-dist/cmaps/**",
      "./node_modules/pdfjs-dist/standard_fonts/**",
      "./node_modules/pdfjs-dist/wasm/**",
      "./node_modules/@napi-rs/canvas/*.js",
      "./node_modules/@napi-rs/canvas/package.json",
      "./node_modules/@napi-rs/canvas-*/package.json",
      "./node_modules/@napi-rs/canvas-*/*.node",
    ],
  },
};

export default nextConfig;
