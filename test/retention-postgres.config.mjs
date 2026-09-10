import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Optional, isolated PostgreSQL/WASM check. It never loads app env files.
// Install @electric-sql/pglite@0.5.8 and drizzle-orm@0.45.2 into a disposable directory outside this
// repo, set PGLITE_RUNTIME_DIR to that directory, then run:
// npx vitest run --config test/retention-postgres.config.mjs
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/retention-postgres.integration.mjs"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
  resolve: {
    alias: { "@": fileURLToPath(new URL("../", import.meta.url)) },
  },
});
