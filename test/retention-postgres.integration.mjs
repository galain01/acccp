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
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { eq, sql } from "drizzle-orm";

const fixture = vi.hoisted(() => ({ db: null, remove: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({
  db: new Proxy(
    {},
    {
      get(_target, property) {
        if (!fixture.db)
          throw new Error("In-memory fixture is not initialized.");
        const value = fixture.db[property];
        return typeof value === "function" ? value.bind(fixture.db) : value;
      },
    }
  ),
}));
vi.mock("@/lib/storage", () => ({
  removeObjects: fixture.remove,
  sourceDocxKey: (session, document) => `${session}/${document}/source.docx`,
  sourcePdfKey: (session, document) => `${session}/${document}/source.pdf`,
  htmlOutputKey: (session, document) => `${session}/${document}/output.html`,
}));

import {
  deleteOwnedDocument,
  DocumentUnavailableError,
  purgeDocumentIfEligible,
  purgeExpiredDocuments,
  retainedDocumentCondition,
  withRetainedDocument,
} from "@/lib/document-retention";
import * as schema from "@/lib/db/schema";

let pg;
let ownerId;
let sessionId;
let migration;
const blobs = new Map();

async function seedDocument(ageHours, deleted = false) {
  const id = randomUUID();
  const jobId = randomUUID();
  await pg.query(
    `INSERT INTO documents
    (id, session_id, uploaded_by_user_id, original_filename, mime_type,
      file_size_bytes, created_at, deleted_at)
    VALUES ($1, $2, $3, 'synthetic.docx', 'application/test', 1,
      clock_timestamp() - ($4 * interval '1 hour'),
      CASE WHEN $5 THEN clock_timestamp() ELSE NULL END)`,
    [id, sessionId, ownerId, ageHours, deleted]
  );
  await pg.query(
    `INSERT INTO conversion_jobs
    (id, document_id, requested_by_user_id, status, provider)
    VALUES ($1, $2, $3, 'completed', 'synthetic')`,
    [jobId, id, ownerId]
  );
  for (const [type, name] of [
    ["source_docx", "source.docx"],
    ["source_pdf", "source.pdf"],
    ["html_output", "output.html"],
    ["validation_report", "legacy-report.json"],
  ]) {
    const key = `${sessionId}/${id}/${name}`;
    blobs.set(key, "synthetic private content");
    await pg.query(
      `INSERT INTO artifacts
      (job_id, artifact_type, filename, mime_type, storage_key, preview_snippet)
      VALUES ($1, $2, $3, 'application/test', $4, 'synthetic preview')`,
      [jobId, type, name, key]
    );
  }
  await pg.query(
    `INSERT INTO validation_findings (job_id, severity, title, message)
    VALUES ($1, 'warning', 'Synthetic finding', 'Synthetic source excerpt')`,
    [jobId]
  );
  await pg.query(
    `INSERT INTO job_events (job_id, event_type, message, metadata)
    VALUES ($1, 'conversion_completed', 'Synthetic filename', '{"synthetic":"excerpt"}')`,
    [jobId]
  );
  await pg.query(
    `INSERT INTO model_calls
    (job_id, stage, model, prompt_tokens, completion_tokens, cost_usd)
    VALUES ($1, 'convert', 'synthetic-model', 1, 1, '0.001')`,
    [jobId]
  );
  return { id, jobId };
}

async function linkedCounts(id, jobId) {
  const result = {};
  for (const [table, column, value] of [
    ["documents", "id", id],
    ["conversion_jobs", "id", jobId],
    ["artifacts", "job_id", jobId],
    ["validation_findings", "job_id", jobId],
    ["job_events", "job_id", jobId],
    ["model_calls", "job_id", jobId],
  ]) {
    const { rows } = await pg.query(
      `SELECT count(*)::int AS total FROM ${table} WHERE ${column} = $1`,
      [value]
    );
    result[table] = rows[0].total;
  }
  return result;
}

beforeAll(async () => {
  const runtime = process.env.PGLITE_RUNTIME_DIR;
  if (!runtime)
    throw new Error(
      "Set PGLITE_RUNTIME_DIR to a scratch directory containing @electric-sql/pglite."
    );
  const runtimeRequire = createRequire(resolve(runtime, "package.json"));
  const { PGlite } = runtimeRequire("@electric-sql/pglite");
  const { drizzle } = runtimeRequire("drizzle-orm/pglite");
  // No DATABASE_URL, network endpoint, data directory, or production env is read.
  pg = new PGlite("memory://");
  fixture.db = drizzle(pg, { schema });

  const require = createRequire(import.meta.url);
  const { generateDrizzleJson, generateMigration } = require("drizzle-kit/api");
  const snapshot = JSON.parse(
    await readFile(
      new URL("../drizzle/meta/0007_snapshot.json", import.meta.url),
      "utf8"
    )
  );
  // The baseline is introspected rather than an executable initial migration.
  // Keep its actual columns, checks, defaults, enums and foreign keys. Omit
  // unrelated views/indexes, including legacy introspection opclass mistakes.
  snapshot.views = {};
  for (const table of Object.values(snapshot.tables)) table.indexes = {};
  const baseline = await generateMigration(generateDrizzleJson({}), snapshot);
  for (const statement of baseline) await pg.exec(statement);
  migration = await readFile(
    new URL("../drizzle/0008_fourteen_day_retention.sql", import.meta.url),
    "utf8"
  );
});

afterAll(async () => {
  if (pg) await pg.close();
});

beforeEach(async () => {
  await pg.exec("TRUNCATE users CASCADE");
  blobs.clear();
  fixture.remove.mockReset();
  fixture.remove.mockImplementation(async (keys) => {
    for (const key of keys) blobs.delete(key);
  });
  ownerId = randomUUID();
  sessionId = randomUUID();
  await pg.query(
    "INSERT INTO users (id, email, display_name) VALUES ($1, 'synthetic@example.test', 'Synthetic Owner')",
    [ownerId]
  );
  await pg.query(
    "INSERT INTO sessions (id, owner_user_id, title) VALUES ($1, $2, 'Synthetic session')",
    [sessionId, ownerId]
  );
});

describe("retention against in-memory PostgreSQL", () => {
  it("backfills from the original date, is repeatable, and sets 14-day defaults", async () => {
    await seedDocument(360);
    await seedDocument(24);
    await pg.exec(migration);
    await pg.exec(migration);
    const { rows } = await pg.query(`SELECT
      bool_and(j.expires_at = d.created_at + interval '336 hours') AS jobs_correct,
      bool_and(a.expires_at = d.created_at + interval '336 hours') AS artifacts_correct,
      bool_or(j.expires_at < clock_timestamp()) AS old_stays_expired
      FROM documents d JOIN conversion_jobs j ON j.document_id = d.id
      JOIN artifacts a ON a.job_id = j.id`);
    expect(rows[0]).toEqual({
      jobs_correct: true,
      artifacts_correct: true,
      old_stays_expired: true,
    });
    const fresh = await seedDocument(0);
    const defaults = await pg.query(
      `SELECT
      abs(extract(epoch FROM (j.expires_at - j.created_at)) - 1209600) < 1 AS job_default,
      bool_and(abs(extract(epoch FROM (a.expires_at - a.created_at)) - 1209600) < 1) AS artifact_default
      FROM conversion_jobs j JOIN artifacts a ON a.job_id = j.id
      WHERE j.id = $1 GROUP BY j.id`,
      [fresh.jobId]
    );
    expect(defaults.rows[0]).toEqual({
      job_default: true,
      artifact_default: true,
    });
  });

  it("hides exact-boundary and deleted documents, then cascades every content-bearing child", async () => {
    const old = await seedDocument(360);
    const boundary = await seedDocument(336);
    const fresh = await seedDocument(312);
    const deleted = await seedDocument(1, true);
    await pg.exec(migration);
    const visible = await fixture.db
      .select({ id: schema.documents.id })
      .from(schema.documents)
      .where(retainedDocumentCondition());
    expect(visible.map((row) => row.id)).toEqual([fresh.id]);
    expect(await purgeExpiredDocuments()).toMatchObject({
      eligible: 3,
      purged: 3,
      failed: 0,
      hasMore: false,
    });
    for (const doc of [old, boundary, deleted]) {
      expect(Object.values(await linkedCounts(doc.id, doc.jobId))).toEqual([
        0, 0, 0, 0, 0, 0,
      ]);
      expect([...blobs.keys()].some((key) => key.includes(doc.id))).toBe(false);
    }
    expect(await linkedCounts(fresh.id, fresh.jobId)).toEqual({
      documents: 1,
      conversion_jobs: 1,
      artifacts: 4,
      validation_findings: 1,
      job_events: 1,
      model_calls: 1,
    });
    const kept = await pg.query(
      "SELECT (SELECT count(*)::int FROM users) AS users, (SELECT count(*)::int FROM sessions) AS sessions"
    );
    expect(kept.rows[0]).toEqual({ users: 1, sessions: 1 });
  });

  it("preserves a committed tombstone and discovery rows after partial storage failure, then retries", async () => {
    const doc = await seedDocument(1);
    fixture.remove.mockImplementationOnce(async (keys) => {
      blobs.delete(keys[0]);
      throw new Error("Synthetic storage failure");
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await deleteOwnedDocument(doc.id, ownerId);
    } finally {
      log.mockRestore();
    }
    const tombstone = await pg.query(
      "SELECT deleted_at IS NOT NULL AS deleted FROM documents WHERE id = $1",
      [doc.id]
    );
    expect(tombstone.rows[0].deleted).toBe(true);
    expect(await linkedCounts(doc.id, doc.jobId)).toEqual({
      documents: 1,
      conversion_jobs: 1,
      artifacts: 4,
      validation_findings: 1,
      job_events: 1,
      model_calls: 1,
    });
    expect(await purgeDocumentIfEligible(doc.id)).toBe("purged");
    expect(Object.values(await linkedCounts(doc.id, doc.jobId))).toEqual([
      0, 0, 0, 0, 0, 0,
    ]);
    expect(blobs.size).toBe(0);
  });

  it("rejects the wrong owner and expired callbacks without accessing storage", async () => {
    const fresh = await seedDocument(1);
    const old = await seedDocument(360);
    await deleteOwnedDocument(fresh.id, randomUUID());
    expect(fixture.remove).not.toHaveBeenCalled();
    const callback = vi.fn();
    await expect(withRetainedDocument(old.id, callback)).rejects.toBeInstanceOf(
      DocumentUnavailableError
    );
    expect(callback).not.toHaveBeenCalled();
    expect((await linkedCounts(fresh.id, fresh.jobId)).documents).toBe(1);
  });

  it("rolls back content written by a callback that expires before commit", async () => {
    const doc = await seedDocument(1);
    await expect(
      withRetainedDocument(doc.id, async (tx) => {
        await tx
          .insert(schema.jobEvents)
          .values({
            jobId: doc.jobId,
            eventType: "late-write",
            message: "Must roll back",
          });
        await tx
          .update(schema.documents)
          .set({ createdAt: sql`clock_timestamp() - interval '336 hours'` })
          .where(eq(schema.documents.id, doc.id));
      })
    ).rejects.toBeInstanceOf(DocumentUnavailableError);
    const events = await pg.query(
      "SELECT count(*)::int AS total FROM job_events WHERE job_id = $1 AND event_type = 'late-write'",
      [doc.jobId]
    );
    expect(events.rows[0].total).toBe(0);
    expect(
      await fixture.db
        .select()
        .from(schema.documents)
        .where(retainedDocumentCondition())
    ).toHaveLength(1);
  });
});
