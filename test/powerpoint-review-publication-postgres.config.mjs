import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Synthetic PostgreSQL/WASM only; never loads an app environment or remote DB.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/powerpoint-review-publication-postgres.integration.mjs"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
  resolve: { alias: { "@": fileURLToPath(new URL("../", import.meta.url)) } },
});
