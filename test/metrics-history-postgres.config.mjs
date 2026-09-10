import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Same optional scratch runtime as retention-postgres.config.mjs. No app env.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/metrics-history-postgres.integration.mjs"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
  resolve: { alias: { "@": fileURLToPath(new URL("../", import.meta.url)) } },
});
