import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Same isolated scratch dependency runtime as the existing retention SQL suite.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/admin-job-failures-postgres.integration.mjs"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
  resolve: { alias: { "@": fileURLToPath(new URL("../", import.meta.url)) } },
});
