import {
  afterAll,
  afterEach,
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
vi.mock("@/lib/auth", () => ({
  verifyRoleOrRedirect: vi
    .fn()
    .mockResolvedValue({ user: { id: "synthetic-admin", role: "admin" } }),
}));
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
import {
  getCostSummary,
  getJobStatusSummary,
  getTokenUsage,
} from "@/lib/actions/admin-metrics";
import {
  effectiveModelCallCostSql,
  estimatedModelCallSql,
} from "@/lib/model-cost-sql";

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

async function combinedMetrics() {
  const jobs =
    await pg.query(`SELECT status, sum(job_count)::int AS job_count FROM (
    SELECT status, count(*) AS job_count FROM conversion_jobs GROUP BY status
    UNION ALL SELECT status, job_count FROM retained_job_metrics
    ) counts GROUP BY status ORDER BY status`);
  const calls = await pg.query(`SELECT day::text, model, stage,
    sum(call_count)::int AS call_count, sum(prompt_tokens)::int AS prompt_tokens,
    sum(completion_tokens)::int AS completion_tokens, sum(cost_usd)::text AS cost_usd
    FROM (
      SELECT (created_at AT TIME ZONE 'UTC')::date AS day, model, stage,
        count(*) AS call_count, sum(prompt_tokens) AS prompt_tokens,
        sum(completion_tokens) AS completion_tokens, sum(cost_usd) AS cost_usd
      FROM model_calls GROUP BY 1, 2, 3
      UNION ALL SELECT day, model, stage, call_count, prompt_tokens,
        completion_tokens, cost_usd FROM retained_model_metrics
    ) calls GROUP BY day, model, stage ORDER BY day, model, stage`);
  return { jobs: jobs.rows, calls: calls.rows };
}

async function archivedMetrics() {
  const jobs = await pg.query(
    "SELECT * FROM retained_job_metrics ORDER BY day, status"
  );
  const calls = await pg.query(
    "SELECT * FROM retained_model_metrics ORDER BY day, model, stage"
  );
  return { jobs: jobs.rows, calls: calls.rows };
}

async function archivedJobStats() {
  const stats = await pg.query(
    "SELECT * FROM retained_job_stats ORDER BY day,model"
  );
  const durations = await pg.query(
    "SELECT * FROM retained_job_duration_metrics ORDER BY day,model,duration_ms"
  );
  return { stats: stats.rows, durations: durations.rows };
}

async function combinedJobStats() {
  const stats =
    await pg.query(`SELECT day::text,model,sum(job_count)::int AS job_count,
    sum(total_tokens)::int AS total_tokens,sum(page_count_sum)::int AS page_count_sum,
    sum(page_measured_job_count)::int AS page_measured_job_count FROM (
    SELECT (j.created_at AT TIME ZONE 'UTC')::date AS day,
      coalesce(nullif(btrim(j.model_name),''),'unknown') AS model,1 AS job_count,
      (SELECT coalesce(sum(c.prompt_tokens::bigint+c.completion_tokens),0) FROM model_calls c WHERE c.job_id=j.id) AS total_tokens,
      coalesce(j.page_count,0) AS page_count_sum,CASE WHEN j.page_count IS NULL THEN 0 ELSE 1 END AS page_measured_job_count
    FROM conversion_jobs j
    UNION ALL SELECT day,model,job_count,total_tokens,page_count_sum,page_measured_job_count FROM retained_job_stats
    ) metrics GROUP BY day,model ORDER BY day,model`);
  const durations =
    await pg.query(`SELECT day::text,model,duration_ms::text,sum(job_count)::int AS job_count FROM (
    SELECT (created_at AT TIME ZONE 'UTC')::date AS day,
      coalesce(nullif(btrim(model_name),''),'unknown') AS model,processing_duration_ms AS duration_ms,1 AS job_count
    FROM conversion_jobs WHERE status IN ('completed','needs_review') AND processing_duration_ms IS NOT NULL
    UNION ALL SELECT day,model,duration_ms,job_count FROM retained_job_duration_metrics
    ) metrics GROUP BY day,model,duration_ms ORDER BY day,model,duration_ms`);
  return { stats: stats.rows, durations: durations.rows };
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
  await pg.exec(
    await readFile(
      new URL("../drizzle/0009_retained_metrics.sql", import.meta.url),
      "utf8"
    )
  );
  await pg.exec(
    await readFile(
      new URL("../drizzle/0010_dashboard_job_metrics.sql", import.meta.url),
      "utf8"
    )
  );
});

afterAll(async () => {
  if (pg) await pg.close();
});
afterEach(() => {
  vi.useRealTimers();
});

beforeEach(async () => {
  await pg.exec(
    "TRUNCATE users, retained_job_metrics, retained_model_metrics, retained_job_stats, retained_job_duration_metrics CASCADE"
  );
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
  it("preserves latest-attempt pages, all-attempt tokens and exact duration frequencies by original job cohort", async () => {
    const measured = await seedDocument(360);
    const sameDuration = await seedDocument(360);
    const failed = await seedDocument(360);
    const unknownDuration = await seedDocument(360);
    const fresh = await seedDocument(1);
    for (const [doc, status, duration, pages, model] of [
      [measured, "completed", 1500, 8, " synthetic-model "],
      [sameDuration, "needs_review", 1500, 4, "synthetic-model"],
      [failed, "failed", 900, null, "synthetic-model"],
      [unknownDuration, "completed", null, null, null],
      [fresh, "completed", 3500, 6, "different-model"],
    ]) {
      await pg.query(
        `UPDATE conversion_jobs SET created_at='2026-08-01T00:30:00Z',
        started_at='2026-09-01T00:00:00Z',completed_at='2026-09-01T00:01:00Z',
        status=$1,processing_duration_ms=$2,page_count=$3,model_name=$4,attempt_count=3 WHERE id=$5`,
        [status, duration, pages, model, doc.jobId]
      );
    }
    await pg.query(
      `INSERT INTO model_calls(job_id,stage,model,prompt_tokens,completion_tokens)
      VALUES ($1,'convert','earlier-model',100,20),($1,'validate','synthetic-model',10,5)`,
      [measured.jobId]
    );
    const before = await combinedJobStats();
    expect(before.stats.find((row) => row.model === "synthetic-model")).toEqual(
      {
        day: "2026-08-01",
        model: "synthetic-model",
        job_count: 3,
        total_tokens: 141,
        page_count_sum: 12,
        page_measured_job_count: 2,
      }
    );
    expect(before.durations).toEqual([
      {
        day: "2026-08-01",
        model: "different-model",
        duration_ms: "3500",
        job_count: 1,
      },
      {
        day: "2026-08-01",
        model: "synthetic-model",
        duration_ms: "1500",
        job_count: 2,
      },
    ]);
    await pg.exec("SET TIME ZONE 'America/Los_Angeles'");
    try {
      expect(await purgeExpiredDocuments()).toMatchObject({
        purged: 4,
        failed: 0,
      });
    } finally {
      await pg.exec("SET TIME ZONE 'UTC'");
    }
    expect(await combinedJobStats()).toEqual(before);
    const archived = await archivedJobStats();
    expect(
      archived.stats.reduce((total, row) => total + Number(row.job_count), 0)
    ).toBe(4);
    expect(
      archived.durations.map((row) => [
        Number(row.duration_ms),
        Number(row.job_count),
      ])
    ).toEqual([[1500, 2]]);
    expect(await purgeExpiredDocuments()).toMatchObject({ purged: 0 });
    expect(await archivedJobStats()).toEqual(archived);
    expect(await combinedJobStats()).toEqual(before);
  });

  it("does not invent job-stat history or measurements for documents with no job", async () => {
    const doc = randomUUID();
    await pg.query(
      `INSERT INTO documents(id,session_id,uploaded_by_user_id,original_filename,mime_type,file_size_bytes,created_at)
      VALUES ($1,$2,$3,'synthetic.pdf','application/pdf',1,clock_timestamp()-interval '360 hours')`,
      [doc, sessionId, ownerId]
    );
    expect(await purgeDocumentIfEligible(doc)).toBe("purged");
    expect(await archivedJobStats()).toEqual({ stats: [], durations: [] });
    expect(await archivedMetrics()).toEqual({ jobs: [], calls: [] });
  });

  it("freezes effective Sol costs and coverage without changing stored call costs or inventing unknown-model prices", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-10T12:00:00Z"));
    const doc = await seedDocument(360);
    await pg.query("DELETE FROM model_calls WHERE job_id=$1", [doc.jobId]);
    // Ordinary cache mix: .00344 + .00004 + .0002 + .004 = .00768.
    // Long-context mix: 279600*.000008 + 300*.0000008 + 100*.00001 + 1000*.00003 = 2.26804.
    await pg.query(
      `INSERT INTO model_calls(job_id,stage,model,prompt_tokens,completion_tokens,cost_usd,cost_source,cached_prompt_tokens,cache_creation_prompt_tokens)
      VALUES ($1,'convert','gpt-5.6-sol-2026-07-09',1000,200,NULL,NULL,100,40),
      ($1,'convert','gpt-5.6-sol-2026-07-09',280000,1000,NULL,NULL,300,100),
      ($1,'convert','gpt-5.6-sol-2026-07-09',1,1,0,'gateway',NULL,NULL),
      ($1,'validate','gpt-5.6-sol-2026-07-09',1,1,0.05,'model-info',NULL,NULL),
      ($1,'convert','unpriced-model',1,1,NULL,NULL,NULL,NULL),
      ($1,'validate','gpt-5.6-sol-2026-07-09',1,1,NULL,NULL,5,0)`,
      [doc.jobId]
    );
    const live = await fixture.db
      .select({
        model: schema.modelCalls.model,
        stage: schema.modelCalls.stage,
        cost: effectiveModelCallCostSql(),
        estimated: estimatedModelCallSql(),
      })
      .from(schema.modelCalls);
    expect(
      live.map((row) => (row.cost === null ? null : Number(row.cost)))
    ).toEqual([0.00768, 2.26804, 0, 0.05, null, null]);
    expect(live.map((row) => row.estimated)).toEqual([
      true,
      true,
      false,
      true,
      false,
      false,
    ]);
    const untouched = await pg.query(
      "SELECT count(*)::int AS unknown FROM model_calls WHERE cost_usd IS NULL"
    );
    expect(untouched.rows[0].unknown).toBe(4);
    expect(await purgeDocumentIfEligible(doc.id)).toBe("purged");
    const calls = (await archivedMetrics()).calls;
    const convert = calls.find(
      (row) => row.model === "gpt-5.6-sol-2026-07-09" && row.stage === "convert"
    );
    expect(Number(convert.cost_usd)).toBe(2.27572);
    expect(
      [
        convert.call_count,
        convert.priced_call_count,
        convert.estimated_call_count,
        convert.unpriced_call_count,
      ].map(Number)
    ).toEqual([3, 3, 2, 0]);
    const validate = calls.find(
      (row) =>
        row.model === "gpt-5.6-sol-2026-07-09" && row.stage === "validate"
    );
    expect(Number(validate.cost_usd)).toBe(0.05);
    expect(
      [
        validate.call_count,
        validate.priced_call_count,
        validate.estimated_call_count,
        validate.unpriced_call_count,
      ].map(Number)
    ).toEqual([2, 1, 1, 1]);
    const unknown = calls.find((row) => row.model === "unpriced-model");
    expect(unknown.cost_usd).toBeNull();
    expect(
      [
        unknown.priced_call_count,
        unknown.estimated_call_count,
        unknown.unpriced_call_count,
      ].map(Number)
    ).toEqual([0, 0, 1]);
  });

  it("handles schema-valid giant cache counts and preserves finite costs above the old numeric limit", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-10T12:00:00Z"));
    const doc = await seedDocument(360);
    await pg.query("DELETE FROM model_calls WHERE job_id=$1", [doc.jobId]);
    await pg.query(
      `INSERT INTO model_calls(job_id,stage,model,prompt_tokens,completion_tokens,cost_usd,cost_source,cached_prompt_tokens,cache_creation_prompt_tokens)
      VALUES ($1,'convert','gpt-5.6-sol-2026-07-09',2000000000,1,NULL,NULL,1500000000,1500000000),
      ($1,'validate','gpt-5.6-sol-2026-07-09',1,1,1234567.890123456789,'gateway',NULL,NULL)`,
      [doc.jobId]
    );
    const live = await fixture.db
      .select({
        cost: effectiveModelCallCostSql(),
        estimated: estimatedModelCallSql(),
      })
      .from(schema.modelCalls);
    expect(live[0]).toEqual({ cost: null, estimated: false });
    expect(live[1]).toEqual({ cost: "1234567.890123456789", estimated: false });
    expect(await purgeDocumentIfEligible(doc.id)).toBe("purged");
    const calls = (await archivedMetrics()).calls;
    expect(calls.find((row) => row.stage === "convert").cost_usd).toBeNull();
    expect(
      Number(calls.find((row) => row.stage === "convert").unpriced_call_count)
    ).toBe(1);
    expect(calls.find((row) => row.stage === "validate").cost_usd).toBe(
      "1234567.890123456789"
    );
    expect(
      Number(calls.find((row) => row.stage === "validate").priced_call_count)
    ).toBe(1);
  });

  it("keeps pre-migration pricing coverage unknown when newer calls join a legacy group", async () => {
    const doc = await seedDocument(360);
    await pg.query(`INSERT INTO retained_model_metrics(day,model,stage,call_count,prompt_tokens,completion_tokens,cost_usd)
      VALUES ((now() AT TIME ZONE 'UTC')::date,'synthetic-model','convert',2,10,20,0.5)`);
    expect(await purgeDocumentIfEligible(doc.id)).toBe("purged");
    const row = (await archivedMetrics()).calls[0];
    expect(Number(row.call_count)).toBe(3);
    expect(Number(row.cost_usd)).toBe(0.501);
    expect([
      row.priced_call_count,
      row.estimated_call_count,
      row.unpriced_call_count,
    ]).toEqual([null, null, null]);
  });

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
        await tx.insert(schema.jobEvents).values({
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

  it("preserves final job status and every model call across automatic and repeated manual cleanup", async () => {
    const automatic = await seedDocument(360);
    const manual = await seedDocument(1);
    const fresh = await seedDocument(1);
    await pg.query(
      "UPDATE conversion_jobs SET status = 'failed', attempt_count = 3 WHERE id = $1",
      [automatic.jobId]
    );
    await pg.query(
      "UPDATE conversion_jobs SET status = 'needs_review' WHERE id = $1",
      [manual.jobId]
    );
    await pg.query(
      `INSERT INTO model_calls
      (job_id, stage, model, prompt_tokens, completion_tokens, cost_usd)
      VALUES ($1, 'validate', 'synthetic-model', 100, 23, '0.123456'),
        ($1, 'convert', 'synthetic-model', 10, 7, NULL)`,
      [automatic.jobId]
    );
    const before = await combinedMetrics();

    expect(await purgeDocumentIfEligible(automatic.id)).toBe("purged");
    expect(await combinedMetrics()).toEqual(before);
    await deleteOwnedDocument(manual.id, ownerId);
    const archived = await archivedMetrics();
    expect(await combinedMetrics()).toEqual(before);
    expect(
      archived.jobs.map((row) => [row.status, Number(row.job_count)])
    ).toEqual([
      ["needs_review", 1],
      ["failed", 1],
    ]);
    expect(
      archived.calls.reduce((sum, row) => sum + Number(row.call_count), 0)
    ).toBe(4);

    await deleteOwnedDocument(manual.id, ownerId);
    expect(await purgeDocumentIfEligible(automatic.id)).toBe("retained");
    expect(await purgeExpiredDocuments()).toMatchObject({
      purged: 0,
      failed: 0,
    });
    expect(await archivedMetrics()).toEqual(archived);
    expect(await combinedMetrics()).toEqual(before);
    expect((await linkedCounts(fresh.id, fresh.jobId)).documents).toBe(1);
  });

  it("does not archive metrics until failed storage cleanup succeeds", async () => {
    const doc = await seedDocument(1);
    const before = await combinedMetrics();
    fixture.remove.mockRejectedValueOnce(
      new Error("Synthetic storage failure")
    );
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await deleteOwnedDocument(doc.id, ownerId);
    } finally {
      log.mockRestore();
    }
    expect(await archivedMetrics()).toEqual({ jobs: [], calls: [] });
    expect(await archivedJobStats()).toEqual({ stats: [], durations: [] });
    expect(await combinedMetrics()).toEqual(before);

    expect(await purgeDocumentIfEligible(doc.id)).toBe("purged");
    const archived = await archivedMetrics();
    expect(await combinedMetrics()).toEqual(before);
    expect(await purgeDocumentIfEligible(doc.id)).toBe("retained");
    expect(await archivedMetrics()).toEqual(archived);
  });

  it("rolls back both metric inserts if database deletion fails, then counts a retry only once", async () => {
    const doc = await seedDocument(360);
    await pg.query(
      "UPDATE conversion_jobs SET processing_duration_ms=1234,page_count=7 WHERE id=$1",
      [doc.jobId]
    );
    const before = await combinedMetrics();
    await pg.exec(`CREATE FUNCTION retention_test_fail_delete() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic deletion failure'; END $$;
      CREATE TRIGGER retention_test_fail_delete BEFORE DELETE ON documents
      FOR EACH ROW EXECUTE FUNCTION retention_test_fail_delete();`);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await purgeDocumentIfEligible(doc.id)).toBe("failed");
      expect(blobs.size).toBe(0);
      expect(await archivedMetrics()).toEqual({ jobs: [], calls: [] });
      expect(await archivedJobStats()).toEqual({ stats: [], durations: [] });
      expect(await combinedMetrics()).toEqual(before);
      expect((await linkedCounts(doc.id, doc.jobId)).documents).toBe(1);
    } finally {
      log.mockRestore();
      await pg.exec(
        "DROP TRIGGER retention_test_fail_delete ON documents; DROP FUNCTION retention_test_fail_delete();"
      );
    }
    expect(await purgeDocumentIfEligible(doc.id)).toBe("purged");
    const archived = await archivedMetrics();
    expect((await archivedJobStats()).durations).toHaveLength(1);
    expect(await combinedMetrics()).toEqual(before);
    expect(await purgeDocumentIfEligible(doc.id)).toBe("retained");
    expect(await archivedMetrics()).toEqual(archived);
  });

  it("preserves unknown costs and exact partial sums when groups accumulate", async () => {
    const unknownA = await seedDocument(360);
    const unknownB = await seedDocument(360);
    const known = await seedDocument(360);
    const laterUnknown = await seedDocument(360);
    await pg.query(
      "UPDATE model_calls SET cost_usd = NULL WHERE job_id = ANY($1::uuid[])",
      [[unknownA.jobId, unknownB.jobId, laterUnknown.jobId]]
    );
    await pg.query(
      "UPDATE model_calls SET cost_usd = '0.123456' WHERE job_id = $1",
      [known.jobId]
    );
    const before = await combinedMetrics();
    expect(await purgeDocumentIfEligible(unknownA.id)).toBe("purged");
    expect(await purgeDocumentIfEligible(unknownB.id)).toBe("purged");
    expect((await archivedMetrics()).calls[0].cost_usd).toBeNull();
    expect(await purgeDocumentIfEligible(known.id)).toBe("purged");
    expect((await archivedMetrics()).calls[0].cost_usd).toBe("0.123456");
    expect(await purgeDocumentIfEligible(laterUnknown.id)).toBe("purged");
    expect((await archivedMetrics()).calls[0].cost_usd).toBe("0.123456");
    expect(await combinedMetrics()).toEqual(before);
  });

  it("groups by UTC day and retains no document, user, storage, or content identifiers", async () => {
    const doc = await seedDocument(360);
    await pg.query(
      "UPDATE conversion_jobs SET created_at = '2026-01-01T00:30:00Z' WHERE id = $1",
      [doc.jobId]
    );
    await pg.query(
      "UPDATE model_calls SET created_at = '2026-01-01T00:30:00Z' WHERE job_id = $1",
      [doc.jobId]
    );
    await pg.exec("SET TIME ZONE 'America/Los_Angeles'");
    try {
      expect(await purgeDocumentIfEligible(doc.id)).toBe("purged");
    } finally {
      await pg.exec("SET TIME ZONE 'UTC'");
    }
    const archived = await archivedMetrics();
    expect(archived.jobs[0].day.toISOString().slice(0, 10)).toBe("2026-01-01");
    expect(archived.calls[0].day.toISOString().slice(0, 10)).toBe("2026-01-01");
    const columns =
      await pg.query(`SELECT table_name, column_name, data_type FROM information_schema.columns
      WHERE table_name IN ('retained_job_metrics', 'retained_model_metrics', 'retained_job_stats', 'retained_job_duration_metrics') ORDER BY table_name, ordinal_position`);
    expect(
      columns.rows
        .filter((row) => row.table_name === "retained_job_metrics")
        .map((row) => row.column_name)
    ).toEqual(["day", "status", "job_count"]);
    expect(
      columns.rows
        .filter((row) => row.table_name === "retained_model_metrics")
        .map((row) => row.column_name)
    ).toEqual([
      "day",
      "model",
      "stage",
      "call_count",
      "prompt_tokens",
      "completion_tokens",
      "cost_usd",
      "priced_call_count",
      "estimated_call_count",
      "unpriced_call_count",
    ]);
    expect(
      columns.rows
        .filter((row) => row.table_name === "retained_job_stats")
        .map((row) => row.column_name)
    ).toEqual([
      "day",
      "model",
      "job_count",
      "total_tokens",
      "page_count_sum",
      "page_measured_job_count",
    ]);
    expect(
      columns.rows
        .filter((row) => row.table_name === "retained_job_duration_metrics")
        .map((row) => row.column_name)
    ).toEqual(["day", "model", "duration_ms", "job_count"]);
    expect(
      columns.rows.some((row) =>
        ["uuid", "jsonb", "timestamp with time zone"].includes(row.data_type)
      )
    ).toBe(false);
    const serialized = JSON.stringify({
      ...archived,
      ...(await archivedJobStats()),
    });
    for (const privateValue of [
      doc.id,
      doc.jobId,
      ownerId,
      sessionId,
      "synthetic.docx",
      "synthetic@example.test",
      "synthetic private content",
      "Synthetic source excerpt",
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
  });

  it("keeps the actual admin totals and 1/7/30-day windows unchanged across purge", async () => {
    const cases = [
      {
        age: 1,
        daysAgo: 0,
        justBefore: false,
        tokens: 5,
        cost: "0.1",
        status: "completed",
      },
      {
        age: 360,
        daysAgo: 6,
        justBefore: false,
        tokens: 7,
        cost: "0.2",
        status: "needs_review",
      },
      {
        age: 360,
        daysAgo: 6,
        justBefore: true,
        tokens: 11,
        cost: "0.4",
        status: "failed",
      },
      {
        age: 360,
        daysAgo: 29,
        justBefore: false,
        tokens: 13,
        cost: "0.8",
        status: "completed",
      },
      {
        age: 360,
        daysAgo: 29,
        justBefore: true,
        tokens: 17,
        cost: "1.6",
        status: "failed",
      },
    ];
    for (const item of cases) {
      const doc = await seedDocument(item.age);
      await pg.query("UPDATE conversion_jobs SET status = $1 WHERE id = $2", [
        item.status,
        doc.jobId,
      ]);
      await pg.query(
        `UPDATE model_calls SET prompt_tokens = $1, completion_tokens = 0, cost_usd = $2,
        created_at = ((now() AT TIME ZONE 'UTC')::date - $3::integer)::timestamp AT TIME ZONE 'UTC'
          - CASE WHEN $4 THEN interval '1 microsecond' ELSE interval '0 seconds' END
        WHERE job_id = $5`,
        [item.tokens, item.cost, item.daysAgo, item.justBefore, doc.jobId]
      );
    }
    const readAdmin = async () => ({
      status: await getJobStatusSummary(),
      tokens: await Promise.all([1, 7, 30].map((days) => getTokenUsage(days))),
      costs: await Promise.all([1, 7, 30].map((days) => getCostSummary(days))),
    });
    const before = await readAdmin();
    expect(before).toMatchObject({
      status: {
        total: 5,
        success: { count: 3, pct: 60 },
        error: { count: 2, pct: 40 },
      },
      tokens: [
        { days: 1, totalTokens: 5 },
        { days: 7, totalTokens: 12 },
        { days: 30, totalTokens: 36 },
      ],
      costs: [
        { days: 1, windowCostUsd: 0.1, allTimeCostUsd: 3.1 },
        { days: 7, windowCostUsd: 0.3, allTimeCostUsd: 3.1 },
        { days: 30, windowCostUsd: 1.5, allTimeCostUsd: 3.1 },
      ],
    });
    expect(await purgeExpiredDocuments()).toMatchObject({
      purged: 4,
      failed: 0,
    });
    expect(await readAdmin()).toEqual(before);
    expect(await purgeExpiredDocuments()).toMatchObject({ purged: 0 });
    expect(await readAdmin()).toEqual(before);
  });
});
