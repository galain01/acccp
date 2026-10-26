import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Synthetic in-memory PostgreSQL; never loads app environment or a remote DB.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/document-submission-postgres.integration.mjs"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
  resolve: { alias: { "@": fileURLToPath(new URL("../", import.meta.url)) } },
});
