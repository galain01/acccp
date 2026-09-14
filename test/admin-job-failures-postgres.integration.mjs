import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const fixture = vi.hoisted(() => ({ db: null }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({
  verifyRoleOrRedirect: vi.fn().mockResolvedValue({ user: { role: "admin" } }),
}));
vi.mock("@/lib/db", () => ({
  db: new Proxy(
    {},
    {
      get(_target, property) {
        const value = fixture.db[property];
        return typeof value === "function" ? value.bind(fixture.db) : value;
      },
    }
  ),
}));
vi.mock("@/lib/storage", () => ({
  removeObjects: vi.fn(),
  sourceDocxKey: vi.fn(),
  sourcePdfKey: vi.fn(),
  htmlOutputKey: vi.fn(),
}));
import { listRecentJobs } from "@/lib/actions/admin-metrics";
let pg;
let owner, document, job;
const diagnostic = {
  version: 1,
  stage: "audit",
  code: "provider_rate_limit",
  attemptNumber: 2,
  httpStatus: 429,
};

beforeAll(async () => {
  const runtime = process.env.PGLITE_RUNTIME_DIR;
  if (!runtime)
    throw new Error(
      "Set PGLITE_RUNTIME_DIR to the isolated PostgreSQL/WASM scratch runtime."
    );
  const require = createRequire(resolve(runtime, "package.json"));
  const { PGlite } = require("@electric-sql/pglite");
  const { drizzle } = require("drizzle-orm/pglite");
  pg = new PGlite("memory://");
  fixture.db = drizzle(pg);
  // The exact columns/primary-key grouping used by listRecentJobs, without any
  // application connection or stored document content.
  await pg.exec(`
    create table users (id uuid primary key, email text not null);
    create table documents (id uuid primary key, original_filename text not null, created_at timestamptz not null, deleted_at timestamptz);
    create table conversion_jobs (id uuid primary key, document_id uuid not null, requested_by_user_id uuid not null, status text not null, model_name text, page_count integer, processing_duration_ms bigint, attempt_count integer not null, created_at timestamptz not null, started_at timestamptz);
    create table model_calls (id uuid primary key, job_id uuid not null, model text not null, prompt_tokens integer not null, completion_tokens integer not null, cost_usd numeric, cost_source text, cached_prompt_tokens integer, cache_creation_prompt_tokens integer);
    create table job_events (id uuid primary key, job_id uuid not null, event_type text not null, message text, metadata jsonb, created_at timestamptz not null);
  `);
});
afterAll(async () => {
  if (pg) await pg.close();
});
beforeEach(async () => {
  await pg.exec(
    "truncate users, documents, conversion_jobs, model_calls, job_events"
  );
  owner = randomUUID();
  document = randomUUID();
  job = randomUUID();
  await pg.query("insert into users values ($1, 'synthetic@osu.edu')", [owner]);
  await pg.query(
    "insert into documents values ($1, 'Synthetic.pdf', clock_timestamp() - interval '1 day', null)",
    [document]
  );
  await pg.query(
    "insert into conversion_jobs values ($1, $2, $3, 'failed', null, 3, null, 2, clock_timestamp() - interval '1 day', clock_timestamp() - interval '5 seconds')",
    [job, document, owner]
  );
});
async function event(value, age = 1, type = "conversion_failed") {
  await pg.query(
    "insert into job_events values ($1, $2, $3, 'SYNTHETIC_PRIVATE_TEXT', $4, clock_timestamp() - $5::interval)",
    [randomUUID(), job, type, JSON.stringify(value), `${age} seconds`]
  );
}

describe("bounded admin failure event SQL", () => {
  it("selects the current attempt's latest failure without multiplying call totals", async () => {
    await event({ diagnostic: { ...diagnostic, attemptNumber: 1 } }, 10);
    await event({ diagnostic }, 1);
    await event(
      { diagnostic: { ...diagnostic, code: "provider_auth" } },
      0,
      "conversion_completed"
    );
    for (let i = 0; i < 2; i++)
      await pg.query(
        "insert into model_calls values ($1, $2, 'synthetic-model', 10, 5, 0.01, 'gateway', null, null)",
        [randomUUID(), job]
      );
    const result = await listRecentJobs();
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].failure.diagnostic).toEqual(diagnostic);
    expect(result.rows[0].totalTokens).toBe(30);
    expect(result.rows[0].costUsd).toBe(0.02);
    expect(JSON.stringify(result)).not.toContain("SYNTHETIC_PRIVATE_TEXT");
  });

  it("does not reuse prior attempts or show details after success", async () => {
    await event({ diagnostic: { ...diagnostic, attemptNumber: 1 } }, 10);
    expect((await listRecentJobs()).rows[0].failure.diagnostic).toBeNull();
    await event({ diagnostic });
    await pg.query(
      "update conversion_jobs set status='completed' where id=$1",
      [job]
    );
    expect((await listRecentJobs()).rows[0].failure).toBeNull();
  });

  it("bounds oversized latest metadata and does not fall back to an earlier reason", async () => {
    await event({ diagnostic }, 2);
    await event(
      {
        diagnostic: {
          ...diagnostic,
          raw: "SYNTHETIC_PRIVATE_TEXT".repeat(500),
        },
      },
      0
    );
    const result = await listRecentJobs();
    expect(result.rows[0].failure).toEqual({
      diagnostic: null,
      occurredAt: null,
    });
    expect(JSON.stringify(result)).not.toContain("SYNTHETIC_PRIVATE_TEXT");
  });

  it.each(["expired", "deleted"])(
    "excludes %s documents and their failure details at SQL read time",
    async (state) => {
      await event({ diagnostic });
      if (state === "expired")
        await pg.query(
          "update documents set created_at=clock_timestamp() - interval '336 hours' where id=$1",
          [document]
        );
      else
        await pg.query(
          "update documents set deleted_at=clock_timestamp() where id=$1",
          [document]
        );
      const result = await listRecentJobs();
      expect(result.rows).toEqual([]);
      expect(result.totalCount).toBe(0);
    }
  );
});
