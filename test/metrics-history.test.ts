import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({ verifyRoleOrRedirect: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { execute: vi.fn() } }));

import { verifyRoleOrRedirect } from "@/lib/auth";
import { db } from "@/lib/db";
import { getMetricsHistory } from "@/lib/actions/metrics-history";
import {
  metricsHistoryQuery,
  validateMetricsHistoryRange,
} from "@/lib/admin-metrics-history";

describe("admin metrics history", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-10T23:59:59Z"));
    vi.mocked(db.execute).mockResolvedValue([] as never);
  });

  afterEach(() => vi.useRealTimers());

  it("authorizes admins before any query and does not expose data on auth failure", async () => {
    vi.mocked(verifyRoleOrRedirect).mockRejectedValueOnce(
      new Error("redirect")
    );
    await expect(
      getMetricsHistory({ from: null, to: "2026-09-10" })
    ).rejects.toThrow("redirect");
    expect(verifyRoleOrRedirect).toHaveBeenCalledWith(["admin"]);
    expect(db.execute).not.toHaveBeenCalled();
  });

  it.each([
    null,
    {},
    { from: null, to: "2026-9-10" },
    { from: null, to: "2026-02-30" },
    { from: null, to: "2025-02-29" },
    { from: null, to: "2026-09-11" },
    { from: null, to: "2026-09-10T00:00:00Z" },
    { from: "2026-09-10", to: "2026-09-09" },
    { from: "0000-01-01", to: "2026-09-10" },
    { from: "2026-09-01'; drop table users; --", to: "2026-09-10" },
  ])("rejects invalid date range %j without querying", async (range) => {
    await expect(getMetricsHistory(range as never)).rejects.toThrow(
      "Invalid metrics date range."
    );
    expect(db.execute).not.toHaveBeenCalled();
  });

  it("accepts real leap dates, a single inclusive day, and an unbounded lower date", () => {
    for (const range of [
      { from: "2024-02-29", to: "2026-09-10" },
      { from: "2026-09-10", to: "2026-09-10" },
      { from: null, to: "2026-09-10" },
    ])
      expect(validateMetricsHistoryRange(range)).toEqual(range);
  });

  it("uses the UTC current date, not the local calendar date", () => {
    const now = new Date("2026-09-10T00:01:00Z");
    expect(
      validateMetricsHistoryRange({ from: null, to: "2026-09-10" }, now).to
    ).toBe("2026-09-10");
    expect(() =>
      validateMetricsHistoryRange({ from: null, to: "2026-09-11" }, now)
    ).toThrow("Invalid metrics date range.");
  });

  it("returns empty totals without inventing prices or durations", async () => {
    const result = await getMetricsHistory({ from: null, to: "2026-09-10" });
    expect(result).toEqual({
      daily: [],
      models: [],
      summary: {
        jobCount: 0,
        successCount: 0,
        failedCount: 0,
        totalTokens: 0,
        costUsd: null,
        estimatedCallCount: 0,
        unpricedCallCount: 0,
        unknownCostCoverage: false,
        statsJobCount: 0,
        jobTokens: 0,
        jobCostUsd: null,
        costMeasuredJobCount: 0,
        costEstimatedJobCount: 0,
        pageCountSum: 0,
        pageMeasuredJobCount: 0,
        medianDurationMs: null,
        minDurationMs: null,
        maxDurationMs: null,
        timedJobCount: 0,
      },
    });
    expect(db.execute).toHaveBeenCalledTimes(1);
  });

  it("converts database numeric strings and retains unknown coverage and sparse UTC rows", async () => {
    const values = {
      jobCount: "10",
      successCount: "8",
      failedCount: "1",
      totalTokens: "1000",
      costUsd: "0.0123",
      estimatedCallCount: "2",
      unpricedCallCount: "1",
      unknownCostCoverage: true,
      statsJobCount: "6",
      jobTokens: "800",
      jobCostUsd: "0.5",
      costMeasuredJobCount: "3",
      costEstimatedJobCount: "1",
      pageCountSum: "20",
      pageMeasuredJobCount: "4",
      medianDurationMs: "100.5",
      minDurationMs: "0",
      maxDurationMs: "900",
      timedJobCount: "5",
    };
    vi.mocked(db.execute).mockResolvedValue([
      { kind: "daily", key: "2026-09-01", ...values },
      { kind: "model", key: "synthetic-model", ...values },
      { kind: "summary", key: "", ...values },
    ] as never);
    const result = await getMetricsHistory({
      from: "2026-09-01",
      to: "2026-09-10",
    });
    expect(result.summary).toMatchObject({
      jobCount: 10,
      statsJobCount: 6,
      costUsd: 0.0123,
      jobCostUsd: 0.5,
      costMeasuredJobCount: 3,
      costEstimatedJobCount: 1,
      unknownCostCoverage: true,
      medianDurationMs: 100.5,
      minDurationMs: 0,
    });
    expect(result.daily.map((row) => row.day)).toEqual(["2026-09-01"]);
    expect(result.models[0].model).toBe("synthetic-model");
    for (const row of [...result.daily, ...result.models])
      expect(row).toMatchObject({
        jobCostUsd: 0.5,
        costMeasuredJobCount: 3,
        costEstimatedJobCount: 1,
      });
    expect(result.models[0]).not.toHaveProperty("successCount");
    expect(db.execute).toHaveBeenCalledTimes(1);
  });

  it("parameterizes an inclusive UTC range and combines every live/archive source in one statement", () => {
    const query = new PgDialect().sqlToQuery(
      metricsHistoryQuery({ from: "2026-08-01", to: "2026-09-10" })
    );
    expect(query.params).toContain("2026-08-01");
    expect(query.params).toContain("2026-09-10");
    expect(query.sql).not.toContain("2026-08-01");
    for (const table of [
      "conversion_jobs",
      "model_calls",
      "retained_job_metrics",
      "retained_job_stats",
      "retained_model_metrics",
      "retained_job_duration_metrics",
    ])
      expect(query.sql).toContain(`"${table}"`);
    expect(query.sql).toContain("at time zone 'UTC'");
    expect(query.sql).toContain("<= bounds.to_day");
    expect(query.sql).toContain("partition by kind, key order by duration_ms");
    expect(query.sql).toContain("floor((total_weight + 1) / 2)");
    expect(query.sql).toContain("floor((total_weight + 2) / 2)");
    expect(query.sql).not.toMatch(
      /original_filename|email|preview_snippet|validation_findings/
    );
  });
});
