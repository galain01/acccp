import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./db/schema";
import * as relations from "./db/relations";
import { databaseConnectionOptions } from "./db/connection-options";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("Missing env var: DATABASE_URL");

// HMR re-evaluates this module on every edit, so without a global the old pool
// is orphaned rather than closed and dev eventually exhausts the connection limit.
const globalForDb = globalThis as unknown as {
  client?: ReturnType<typeof postgres>;
};

// prepare: false is required by Supabase's transaction-mode pooler.
const client =
  globalForDb.client ?? postgres(connectionString, databaseConnectionOptions());
if (process.env.NODE_ENV !== "production") globalForDb.client = client;

export const db = drizzle(client, { schema: { ...schema, ...relations } });
