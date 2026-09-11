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

const fixture = vi.hoisted(() => ({
  db: null,
  execute: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({
  verifyRoleOrRedirect: vi.fn().mockResolvedValue({ user: { role: "admin" } }),
}));
vi.mock("@/lib/db", () => ({
  db: new Proxy(
    {},
    {
      get(_target, property) {
        if (property === "execute") return fixture.execute;
        if (!fixture.db) throw new Error("In-memory fixture not initialized.");
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

import * as schema from "@/lib/db/schema";
import { getMetricsHistory } from "@/lib/actions/metrics-history";
import { getCostSummary, listRecentJobs } from "@/lib/actions/admin-metrics";
import { purgeDocumentIfEligible } from "@/lib/document-retention";

let pg;
let ownerId;
let sessionId;
let migratedLegacyCost;
const range = { from: "2026-09-01", to: "2026-09-03" };
const sol = "gpt-5.6-sol-2026-07-09";

beforeAll(async () => {
  // Hold the published-rate verification date fixed; keep real I/O timers.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-10T12:00:00Z"));
  const runtime = process.env.PGLITE_RUNTIME_DIR;
  if (!runtime)
    throw new Error(
      "Set PGLITE_RUNTIME_DIR to the isolated PostgreSQL/WASM scratch runtime."
    );
  const runtimeRequire = createRequire(resolve(runtime, "package.json"));
  const { PGlite } = runtimeRequire("@electric-sql/pglite");
  const { drizzle } = runtimeRequire("drizzle-orm/pglite");
  pg = new PGlite("memory://");
  fixture.db = drizzle(pg, { schema });
  // Adapt only the transport's result envelope to Postgres.js's array contract.
  fixture.execute.mockImplementation(
    async (query) => (await fixture.db.execute(query)).rows
  );

  const require = createRequire(import.meta.url);
  const { generateDrizzleJson, generateMigration } = require("drizzle-kit/api");
  const snapshot = JSON.parse(
    await readFile(
      new URL("../drizzle/meta/0007_snapshot.json", import.meta.url),
      "utf8"
    )
  );
  snapshot.views = {};
  for (const table of Object.values(snapshot.tables)) table.indexes = {};
  // Actual baseline tables/FKs/checks, excluding unrelated introspection indexes/views.
  for (const statement of await generateMigration(
    generateDrizzleJson({}),
    snapshot
  ))
    await pg.exec(statement);
  for (const file of [
    "0008_fourteen_day_retention.sql",
    "0009_retained_metrics.sql",
    "0010_dashboard_job_metrics.sql",
  ])
    await pg.exec(
      await readFile(new URL(`../drizzle/${file}`, import.meta.url), "utf8")
    );
  await pg.exec(`INSERT INTO retained_job_stats
    (day,model,job_count,total_tokens,page_count_sum,page_measured_job_count)
    VALUES ('2026-09-01','migration-fixture',3,100,0,0)`);
  await pg.exec(
    await readFile(
      new URL("../drizzle/0011_average_job_cost.sql", import.meta.url),
      "utf8"
    )
  );
  migratedLegacyCost = (
    await pg.query(`SELECT job_cost_usd,
    cost_measured_job_count::int,cost_estimated_job_count::int
    FROM retained_job_stats WHERE model='migration-fixture'`)
  ).rows[0];
});

afterAll(async () => {
  if (pg) await pg.close();
  vi.useRealTimers();
});

beforeEach(async () => {
  await pg.exec(`TRUNCATE users, retained_job_metrics, retained_model_metrics, retained_job_stats, retained_job_duration_metrics CASCADE;
    SET TIME ZONE 'UTC';`);
  fixture.execute.mockClear();
  fixture.remove.mockReset().mockResolvedValue(undefined);
  ownerId = randomUUID();
  sessionId = randomUUID();
  await pg.query(
    "INSERT INTO users (id, email, display_name, role) VALUES ($1, 'fixture@osu.edu', 'Synthetic admin', 'admin')",
    [ownerId]
  );
  await pg.query(
    "INSERT INTO sessions (id, owner_user_id, title) VALUES ($1, $2, 'Synthetic fixture')",
    [sessionId, ownerId]
  );
});

async function job({
  day = "2026-09-01T12:00:00Z",
  model = sol,
  status = "completed",
  duration = null,
  pages = null,
} = {}) {
  const id = randomUUID();
  const jobId = randomUUID();
  await pg.query(
    `INSERT INTO documents (id, session_id, uploaded_by_user_id, original_filename, mime_type, file_size_bytes, created_at)
    VALUES ($1, $2, $3, 'synthetic-private.pdf', 'application/pdf', 1, clock_timestamp() - interval '20 days')`,
    [id, sessionId, ownerId]
  );
  await pg.query(
    `INSERT INTO conversion_jobs (id, document_id, requested_by_user_id, status, provider, model_name, created_at, processing_duration_ms, page_count)
    VALUES ($1, $2, $3, $4, 'synthetic', $5, $6, $7, $8)`,
    [jobId, id, ownerId, status, model, day, duration, pages]
  );
  return { id, jobId };
}

async function call(
  jobId,
  {
    day = "2026-09-01T12:01:00Z",
    model = sol,
    prompt = 100,
    completion = 10,
    cost = "0.01",
    source = "gateway",
    cached = null,
    written = null,
    stage = "convert",
  } = {}
) {
  await pg.query(
    `INSERT INTO model_calls (job_id, stage, model, prompt_tokens, completion_tokens, cost_usd, cost_source, cached_prompt_tokens, cache_creation_prompt_tokens, created_at)
    VALUES ($1, $10, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      jobId,
      model,
      prompt,
      completion,
      cost,
      source,
      cached,
      written,
      day,
      stage,
    ]
  );
}

async function retainedTiming(day, model, duration, weight) {
  await pg.query(
    "INSERT INTO retained_job_metrics (day, status, job_count) VALUES ($1, 'completed', $2) ON CONFLICT (day, status) DO UPDATE SET job_count = retained_job_metrics.job_count + excluded.job_count",
    [day, weight]
  );
  await pg.query(
    "INSERT INTO retained_job_stats (day, model, job_count, total_tokens, page_count_sum, page_measured_job_count) VALUES ($1, $2, $3, 0, 0, 0) ON CONFLICT (day, model) DO UPDATE SET job_count = retained_job_stats.job_count + excluded.job_count",
    [day, model, weight]
  );
  await pg.query(
    "INSERT INTO retained_job_duration_metrics (day, model, duration_ms, job_count) VALUES ($1, $2, $3, $4)",
    [day, model, duration, weight]
  );
}

describe("actual PostgreSQL metrics history", () => {
  it("migrates existing retained cohorts as unmeasured instead of zero-cost jobs", () => {
    expect(migratedLegacyCost).toEqual({
      job_cost_usd: null,
      cost_measured_job_count: 0,
      cost_estimated_job_count: 0,
    });
  });

  it("executes an empty history as one statement with null cost/timing", async () => {
    const history = await getMetricsHistory(range);
    expect(history.daily).toEqual([]);
    expect(history.models).toEqual([]);
    expect(history.summary).toMatchObject({
      jobCount: 0,
      totalTokens: 0,
      costUsd: null,
      jobCostUsd: null,
      costMeasuredJobCount: 0,
      costEstimatedJobCount: 0,
      medianDurationMs: null,
      timedJobCount: 0,
    });
    expect(fixture.execute).toHaveBeenCalledTimes(1);
  });

  it("computes exact odd/even weighted medians rather than averaging daily medians", async () => {
    await retainedTiming("2026-09-01", "model-a", 100, 3);
    await retainedTiming("2026-09-02", "model-a", 1000, 2);
    const odd = await getMetricsHistory(range);
    expect(odd.daily.map((row) => row.medianDurationMs)).toEqual([100, 1000]);
    expect(odd.summary).toMatchObject({
      medianDurationMs: 100,
      minDurationMs: 100,
      maxDurationMs: 1000,
      timedJobCount: 5,
    });
    await retainedTiming("2026-09-03", "model-b", 2000, 1);
    const even = await getMetricsHistory(range);
    expect(even.summary).toMatchObject({
      medianDurationMs: 550,
      minDurationMs: 100,
      maxDurationMs: 2000,
      timedJobCount: 6,
    });
    expect(
      even.models.find((row) => row.model === "model-a").medianDurationMs
    ).toBe(100);
    expect(
      even.models.find((row) => row.model === "model-b").medianDurationMs
    ).toBe(2000);
  });

  it("uses frequency weights without expanding a million retained durations", async () => {
    await retainedTiming("2026-09-01", "synthetic-model", 0, 1_000_000);
    await retainedTiming("2026-09-01", "synthetic-model", 1001, 1_000_000);
    const history = await getMetricsHistory(range);
    expect(history.summary).toMatchObject({
      medianDurationMs: 500.5,
      minDurationMs: 0,
      maxDurationMs: 1001,
      timedJobCount: 2_000_000,
    });
  });

  it("keeps UTC boundaries inclusive and distinguishes job cohorts from call-day usage", async () => {
    await pg.exec("SET TIME ZONE 'America/Los_Angeles'");
    const record = await job({
      day: "2026-09-01T23:59:59Z",
      duration: 300,
      pages: 2,
    });
    await call(record.jobId, {
      day: "2026-09-02T00:00:00Z",
      prompt: 20,
      completion: 10,
    });
    await call(record.jobId, {
      day: "2026-09-03T00:00:00Z",
      prompt: 15,
      completion: 5,
    });
    const second = await getMetricsHistory({
      from: "2026-09-02",
      to: "2026-09-02",
    });
    expect(second.daily).toHaveLength(1);
    expect(second.daily[0]).toMatchObject({
      day: "2026-09-02",
      jobCount: 0,
      totalTokens: 30,
      jobTokens: 0,
      jobCostUsd: null,
      costMeasuredJobCount: 0,
      timedJobCount: 0,
    });
    const first = await getMetricsHistory({
      from: "2026-09-01",
      to: "2026-09-01",
    });
    expect(first.summary).toMatchObject({
      jobCount: 1,
      totalTokens: 0,
      jobTokens: 50,
      jobCostUsd: 0.02,
      costMeasuredJobCount: 1,
      pageCountSum: 2,
      medianDurationMs: 300,
    });
  });

  it("preserves old missing measurement/price coverage while pricing each eligible live call", async () => {
    await pg.query(
      "INSERT INTO retained_job_metrics (day, status, job_count) VALUES ('2026-09-01', 'completed', 5)"
    );
    await pg.query(
      "INSERT INTO retained_model_metrics (day, model, stage, call_count, prompt_tokens, completion_tokens, cost_usd) VALUES ('2026-09-01', 'legacy-model', 'convert', 4, 180, 20, '0.3')"
    );
    const known = await job();
    await call(known.jobId, {
      prompt: 1000,
      completion: 100,
      cost: null,
      source: null,
      cached: 200,
      written: 300,
    });
    const unknown = await job({ model: "unknown-pricing", status: "failed" });
    await call(unknown.jobId, {
      model: "unknown-pricing",
      prompt: 5,
      completion: 2,
      cost: null,
      source: null,
    });
    const history = await getMetricsHistory(range);
    expect(history.summary).toMatchObject({
      jobCount: 7,
      successCount: 6,
      failedCount: 1,
      statsJobCount: 2,
      totalTokens: 1307,
      estimatedCallCount: 1,
      unpricedCallCount: 1,
      unknownCostCoverage: true,
      timedJobCount: 0,
      medianDurationMs: null,
      costMeasuredJobCount: 1,
      costEstimatedJobCount: 1,
    });
    expect(history.summary.costUsd).toBeCloseTo(0.30558, 12);
    expect(history.summary.jobCostUsd).toBeCloseTo(0.00558, 12);
    expect(
      history.models.find((row) => row.model === "legacy-model")
    ).toMatchObject({
      jobCount: 0,
      statsJobCount: 0,
      unknownCostCoverage: true,
      jobCostUsd: null,
      costMeasuredJobCount: 0,
    });
  });

  it("keeps every history field unchanged across actual archive/cascade and repeat purge", async () => {
    const success = await job({ duration: 100, pages: 3 });
    await call(success.jobId, {
      prompt: 1000,
      completion: 100,
      cost: null,
      source: null,
      cached: 200,
      written: 300,
    });
    await call(success.jobId, {
      day: "2026-09-02T01:00:00Z",
      prompt: 10,
      completion: 5,
      cost: "0.01",
    });
    const failure = await job({
      model: "unknown-pricing",
      day: "2026-09-02T12:00:00Z",
      status: "failed",
      duration: 900,
      pages: 2,
    });
    await call(failure.jobId, {
      day: "2026-09-02T12:01:00Z",
      model: "unknown-pricing",
      prompt: 20,
      completion: 10,
      cost: null,
      source: null,
    });
    const before = await getMetricsHistory(range);
    expect(before.summary).toMatchObject({
      jobCount: 2,
      statsJobCount: 2,
      timedJobCount: 1,
      medianDurationMs: 100,
      pageCountSum: 5,
      estimatedCallCount: 1,
      unpricedCallCount: 1,
      costMeasuredJobCount: 1,
      costEstimatedJobCount: 1,
    });
    expect(before.summary.jobCostUsd).toBeCloseTo(0.01558, 12);
    expect(await purgeDocumentIfEligible(success.id)).toBe("purged");
    expect(await purgeDocumentIfEligible(failure.id)).toBe("purged");
    const after = await getMetricsHistory(range);
    expect(after).toEqual(before);
    expect(await purgeDocumentIfEligible(success.id)).toBe("retained");
    expect(await getMetricsHistory(range)).toEqual(before);
    expect(
      (await pg.query("SELECT count(*)::int AS count FROM conversion_jobs"))
        .rows[0].count
    ).toBe(0);
    expect(JSON.stringify(after)).not.toMatch(
      /synthetic-private|fixture@osu|Synthetic fixture/
    );
  });

  it("includes conversion, audit and failed retries in their job cohort while spend follows each call day", async () => {
    const retried = await job({ model: "final-model" });
    await pg.query("UPDATE conversion_jobs SET attempt_count=3 WHERE id=$1", [
      retried.jobId,
    ]);
    for (const [day, model, stage, cost] of [
      ["2026-09-01", "first-model", "convert", "0.10"],
      ["2026-09-01", "audit-model", "validate", "0.02"],
      ["2026-09-02", "first-model", "convert", "0.03"],
      ["2026-09-03", "final-model", "convert", "0.04"],
      ["2026-09-03", "audit-model", "validate", "0.01"],
    ])
      await call(retried.jobId, {
        day: `${day}T12:00:00Z`,
        model,
        stage,
        cost,
      });
    const failed = await job({ status: "failed", model: "failed-model" });
    await call(failed.jobId, {
      day: "2026-09-03T12:00:00Z",
      model: "failed-model",
      cost: "0.06",
    });
    // This job's call falls inside the selected day, but the job itself does not.
    const outside = await job({
      day: "2026-08-31T23:59:59Z",
      model: "outside-model",
    });
    await call(outside.jobId, { model: "outside-model", cost: "0.50" });

    const firstDay = { from: "2026-09-01", to: "2026-09-01" };
    const read = async () => ({
      first: await getMetricsHistory(firstDay),
      full: await getMetricsHistory(range),
      spend: await getCostSummary(30),
    });
    const before = await read();
    expect(before.first.summary).toMatchObject({
      jobCount: 2,
      failedCount: 1,
      jobCostUsd: 0.26,
      costMeasuredJobCount: 2,
      costEstimatedJobCount: 0,
      costUsd: 0.62,
    });
    expect(
      before.first.summary.jobCostUsd /
        before.first.summary.costMeasuredJobCount
    ).toBe(0.13);
    expect(
      before.full.daily.map(({ day, costUsd, jobCostUsd }) => ({
        day,
        costUsd,
        jobCostUsd,
      }))
    ).toEqual([
      { day: "2026-09-01", costUsd: 0.62, jobCostUsd: 0.26 },
      { day: "2026-09-02", costUsd: 0.03, jobCostUsd: null },
      { day: "2026-09-03", costUsd: 0.11, jobCostUsd: null },
    ]);
    expect(before.full.summary.costUsd).toBe(0.76);
    expect(before.spend).toMatchObject({
      windowCostUsd: 0.76,
      allTimeCostUsd: 0.76,
    });
    expect(
      before.full.models.find(({ model }) => model === "first-model")
    ).toMatchObject({
      costUsd: 0.13,
      jobCount: 0,
      jobCostUsd: null,
    });
    expect(
      before.full.models.find(({ model }) => model === "audit-model").costUsd
    ).toBe(0.03);
    expect(
      before.full.models.find(({ model }) => model === "final-model")
    ).toMatchObject({
      costUsd: 0.04,
      jobCostUsd: 0.2,
      costMeasuredJobCount: 1,
    });
    await pg.query(
      "UPDATE documents SET created_at=clock_timestamp() WHERE id=$1",
      [retried.id]
    );
    const recent = await listRecentJobs();
    expect(recent.rows).toHaveLength(1);
    expect(recent.rows[0]).toMatchObject({
      jobId: retried.jobId,
      attemptCount: 3,
      costUsd: 0.2,
      estimatedCallCount: 0,
      unpricedCallCount: 0,
    });
    await pg.query(
      "UPDATE documents SET created_at=clock_timestamp() - interval '20 days' WHERE id=$1",
      [retried.id]
    );
    for (const record of [retried, failed, outside])
      expect(await purgeDocumentIfEligible(record.id)).toBe("purged");
    expect(await read()).toEqual(before);
    expect((await listRecentJobs()).rows).toEqual([]);
  });

  it("averages only fully priced jobs, retaining explicit zero prices and estimated coverage through purge", async () => {
    const known = await job();
    await call(known.jobId, { cost: "0.10" });
    await call(known.jobId, { stage: "validate", cost: "0.20" });
    const estimated = await job({ status: "failed" });
    await call(estimated.jobId, { cost: "0.40", source: "model-info" });
    await call(estimated.jobId, { stage: "validate", cost: "0.50" });
    const mixed = await job();
    await call(mixed.jobId, { cost: "0.70" });
    await call(mixed.jobId, {
      stage: "validate",
      model: "unpriced",
      cost: null,
      source: null,
    });
    const unpriced = await job();
    await call(unpriced.jobId, { model: "unpriced", cost: null, source: null });
    const noCalls = await job({ status: "failed" });
    const free = await job();
    await call(free.jobId, { cost: "0", prompt: 0, completion: 0 });
    const before = await getMetricsHistory(range);
    expect(before.summary).toMatchObject({
      jobCount: 6,
      costUsd: 1.9,
      jobCostUsd: 1.2,
      costMeasuredJobCount: 3,
      costEstimatedJobCount: 1,
      unpricedCallCount: 2,
    });
    expect(
      before.summary.jobCostUsd / before.summary.costMeasuredJobCount
    ).toBeCloseTo(0.4, 12);
    for (const record of [known, estimated, mixed, unpriced, noCalls, free]) {
      expect(await purgeDocumentIfEligible(record.id)).toBe("purged");
      expect(await getMetricsHistory(range)).toEqual(before);
    }
    expect(await purgeDocumentIfEligible(estimated.id)).toBe("retained");
    expect(await getMetricsHistory(range)).toEqual(before);
  });

  it("keeps all-unpriced and no-call cohorts unknown rather than reporting free jobs", async () => {
    const unknown = await job();
    await call(unknown.jobId, { model: "unpriced", cost: null, source: null });
    const noCalls = await job();
    const before = await getMetricsHistory(range);
    expect(before.summary).toMatchObject({
      jobCount: 2,
      jobCostUsd: null,
      costMeasuredJobCount: 0,
      costEstimatedJobCount: 0,
    });
    for (const record of [unknown, noCalls])
      expect(await purgeDocumentIfEligible(record.id)).toBe("purged");
    expect(await getMetricsHistory(range)).toEqual(before);
  });

  it("adds new measured subsets to legacy cohorts without inventing old costs", async () => {
    await retainedTiming("2026-09-01", sol, 500, 4);
    const legacy = await getMetricsHistory(range);
    expect(legacy.summary).toMatchObject({
      jobCount: 4,
      jobCostUsd: null,
      costMeasuredJobCount: 0,
    });
    const known = await job();
    await call(known.jobId, { cost: "0.25", source: "model-info" });
    const free = await job();
    await call(free.jobId, { cost: "0" });
    const unpriced = await job();
    await call(unpriced.jobId, { model: "unpriced", cost: null, source: null });
    const before = await getMetricsHistory(range);
    expect(before.summary).toMatchObject({
      jobCount: 7,
      jobCostUsd: 0.25,
      costMeasuredJobCount: 2,
      costEstimatedJobCount: 1,
    });
    for (const record of [unpriced, known, free]) {
      expect(await purgeDocumentIfEligible(record.id)).toBe("purged");
      expect(await getMetricsHistory(range)).toEqual(before);
    }
    const retained = (
      await pg.query(`SELECT job_count::int,job_cost_usd,
      cost_measured_job_count::int,cost_estimated_job_count::int FROM retained_job_stats`)
    ).rows;
    expect(retained).toEqual([
      {
        job_count: 7,
        job_cost_usd: "0.25",
        cost_measured_job_count: 2,
        cost_estimated_job_count: 1,
      },
    ]);
  });

  it("includes older retained history only for an unbounded lower range", async () => {
    await retainedTiming("2020-01-01", "old-model", 5000, 1);
    await retainedTiming("2026-09-03", "current-model", 100, 1);
    await retainedTiming("2026-09-04", "after-range", 9999, 1);
    expect((await getMetricsHistory(range)).summary.jobCount).toBe(1);
    const history = await getMetricsHistory({ from: null, to: "2026-09-03" });
    expect(history.summary).toMatchObject({
      jobCount: 2,
      medianDurationMs: 2550,
    });
    expect(history.daily.map((row) => row.day)).toEqual([
      "2020-01-01",
      "2026-09-03",
    ]);
  });
});
