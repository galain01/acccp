import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Isolated PostgreSQL/WASM only; no app environment or remote database.
// PGLITE_RUNTIME_DIR supplies the existing scratch PGlite/Drizzle runtime.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/conversion-publication-postgres.integration.mjs"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
  resolve: {
    alias: { "@": fileURLToPath(new URL("../", import.meta.url)) },
  },
});
