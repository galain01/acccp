import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Isolated PostgreSQL/WASM only; no app environment files or network database.
// PGLITE_RUNTIME_DIR must contain @electric-sql/pglite and drizzle-orm.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/native-pdf-transport-postgres.integration.mjs"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
  resolve: {
    alias: { "@": fileURLToPath(new URL("../", import.meta.url)) },
  },
});
