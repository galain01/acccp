import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("server-only", () => ({}));
vi.mock("@/lib/storage", () => ({
  removeObjects: vi.fn(),
  sourceDocxKey: vi.fn(),
  sourcePdfKey: vi.fn(),
  htmlOutputKey: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  verifyRoleOrRedirect: vi
    .fn()
    .mockResolvedValue({ user: { id: "admin-1", role: "admin" } }),
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
  },
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { verifyRoleOrRedirect } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  getCostSummary,
  getJobStatusSummary,
  getTokenUsage,
  getUserRoleCounts,
  listPendingUsersPage,
  listRecentJobs,
} from "./admin-metrics";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeChain<T>(value: T) {
  const chain: Record<string, unknown> = {};

  const selfFn = () => {
    const fn = vi.fn();
    fn.mockReturnValue(chain);
    return fn;
  };

  chain.from = selfFn();
  chain.where = selfFn();
  chain.orderBy = selfFn();
  chain.groupBy = selfFn();
  chain.limit = selfFn();
  chain.offset = selfFn();
  chain.innerJoin = selfFn();
  chain.leftJoin = selfFn();
  const promise = Promise.resolve(value);
  chain.then = promise.then.bind(promise);
  chain.catch = promise.catch.bind(promise);

  // Duck-types Drizzle's query builders: `any` satisfies mockReturnValue's
  // builder types while keeping property access for assertions.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return chain as any;
}

// ── getUserRoleCounts ─────────────────────────────────────────────────────────

describe("getUserRoleCounts", () => {
  beforeEach(() => vi.clearAllMocks());

  it("aggregates all three roles from DB rows", async () => {
    vi.mocked(db.select).mockReturnValue(
      makeChain([
        { role: "pending", count: 3 },
        { role: "instructor", count: 10 },
        { role: "admin", count: 2 },
      ])
    );

    expect(await getUserRoleCounts()).toEqual({
      pending: 3,
      instructor: 10,
      admin: 2,
    });
  });

  it("defaults missing roles to 0 when no users exist for that role", async () => {
    vi.mocked(db.select).mockReturnValue(
      makeChain([{ role: "admin", count: 1 }])
    );

    expect(await getUserRoleCounts()).toEqual({
      pending: 0,
      instructor: 0,
      admin: 1,
    });
  });

  it("ignores unknown role values returned by the DB", async () => {
    vi.mocked(db.select).mockReturnValue(
      makeChain([{ role: "super_admin", count: 99 }])
    );

    expect(await getUserRoleCounts()).toEqual({
      pending: 0,
      instructor: 0,
      admin: 0,
    });
  });

  it("requires admin role", async () => {
    vi.mocked(db.select).mockReturnValue(makeChain([]));
    await getUserRoleCounts();
    expect(verifyRoleOrRedirect).toHaveBeenCalledWith(["admin"]);
  });

  it("propagates a redirect thrown by the auth check", async () => {
    vi.mocked(verifyRoleOrRedirect).mockRejectedValueOnce(
      new Error("NEXT_REDIRECT")
    );
    await expect(getUserRoleCounts()).rejects.toThrow("NEXT_REDIRECT");
  });
});

// ── getJobStatusSummary ───────────────────────────────────────────────────────

describe("getJobStatusSummary", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns a summary with success/error counts and percentages", async () => {
    vi.mocked(db.select).mockReturnValue(
      makeChain([
        { status: "completed", count: 8 },
        { status: "failed", count: 2 },
      ])
    );

    const result = await getJobStatusSummary();

    expect(result.total).toBe(10);
    expect(result.success).toEqual({ count: 8, pct: 80 });
    expect(result.error).toEqual({ count: 2, pct: 20 });
  });

  it("returns all-zero summary when no jobs exist", async () => {
    vi.mocked(db.select).mockReturnValue(makeChain([]));

    const result = await getJobStatusSummary();

    expect(result).toEqual({
      total: 0,
      success: { count: 0, pct: 0 },
      error: { count: 0, pct: 0 },
    });
  });

  it("counts needs_review as success (HTML is available)", async () => {
    vi.mocked(db.select).mockReturnValue(
      makeChain([{ status: "needs_review", count: 5 }])
    );

    const result = await getJobStatusSummary();

    expect(result.success.count).toBe(5);
    expect(result.error.count).toBe(0);
  });

  it("counts expired and cancelled as errors", async () => {
    vi.mocked(db.select).mockReturnValue(
      makeChain([
        { status: "expired", count: 3 },
        { status: "cancelled", count: 1 },
      ])
    );

    const result = await getJobStatusSummary();

    expect(result.error.count).toBe(4);
    expect(result.success.count).toBe(0);
  });

  it("excludes queued/processing from both success and error counts", async () => {
    vi.mocked(db.select).mockReturnValue(
      makeChain([
        { status: "queued", count: 5 },
        { status: "processing", count: 5 },
      ])
    );

    const result = await getJobStatusSummary();

    expect(result.total).toBe(10);
    expect(result.success.count).toBe(0);
    expect(result.error.count).toBe(0);
  });

  it("combines current jobs and retained outcome totals in one database snapshot", async () => {
    const query = makeChain([
      { status: "completed", count: "12" },
      { status: "failed", count: "3" },
    ]);
    vi.mocked(db.select).mockReturnValue(query);
    const result = await getJobStatusSummary();
    expect(result).toEqual({
      total: 15,
      success: { count: 12, pct: 80 },
      error: { count: 3, pct: 20 },
    });
    expect(db.select).toHaveBeenCalledTimes(1);
    const source = new PgDialect().sqlToQuery(query.from.mock.calls[0][0]);
    expect(source.sql).toContain('"conversion_jobs"');
    expect(source.sql).toContain('"retained_job_metrics"');
    expect(source.sql).toContain("union all");
  });
});

// ── getTokenUsage ─────────────────────────────────────────────────────────────

describe("getTokenUsage", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns total tokens for the default 30-day window", async () => {
    vi.mocked(db.select).mockReturnValue(makeChain([{ totalTokens: "5000" }]));

    const result = await getTokenUsage();

    expect(result).toEqual({ days: 30, totalTokens: 5000 });
  });

  it("accepts a custom window", async () => {
    vi.mocked(db.select).mockReturnValue(makeChain([{ totalTokens: "1200" }]));

    const result = await getTokenUsage(7);

    expect(result.days).toBe(7);
    expect(result.totalTokens).toBe(1200);
  });

  it("clamps negative days to 30", async () => {
    vi.mocked(db.select).mockReturnValue(makeChain([{ totalTokens: "0" }]));

    expect((await getTokenUsage(-5)).days).toBe(30);
  });

  it("clamps zero days to 30", async () => {
    vi.mocked(db.select).mockReturnValue(makeChain([{ totalTokens: "0" }]));

    expect((await getTokenUsage(0)).days).toBe(30);
  });

  it("clamps days above 365 to 365", async () => {
    vi.mocked(db.select).mockReturnValue(makeChain([{ totalTokens: "0" }]));

    expect((await getTokenUsage(9999)).days).toBe(365);
  });

  it("returns 0 when there are no model_calls rows (coalesce handling)", async () => {
    vi.mocked(db.select).mockReturnValue(makeChain([{ totalTokens: null }]));

    expect((await getTokenUsage()).totalTokens).toBe(0);
  });

  it("combines live calls and retained daily totals with the same UTC day boundary", async () => {
    const query = makeChain([{ totalTokens: "12345" }]);
    vi.mocked(db.select).mockReturnValue(query);
    expect(await getTokenUsage(7)).toEqual({ days: 7, totalTokens: 12345 });
    expect(db.select).toHaveBeenCalledTimes(1);
    const source = new PgDialect().sqlToQuery(query.from.mock.calls[0][0]);
    expect(source.sql).toContain('"model_calls"');
    expect(source.sql).toContain('"retained_model_metrics"');
    expect(source.sql).toContain("union all");
    expect(source.sql.match(/at time zone 'UTC'/g)).toHaveLength(3);
    expect(source.params).toEqual([7, 7]);
  });

  it.each([NaN, Infinity, 0.1])(
    "keeps calendar windows valid for %s",
    async (days) => {
      vi.mocked(db.select).mockReturnValue(makeChain([{ totalTokens: "0" }]));
      expect((await getTokenUsage(days)).days).toBe(days === 0.1 ? 1 : 30);
    }
  );
});

// ── getCostSummary ────────────────────────────────────────────────────────────

describe("getCostSummary", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns both window and all-time costs when data exists", async () => {
    vi.mocked(db.select).mockReturnValueOnce(
      makeChain([{ windowCost: "12.5", allTimeCost: "100.25" }])
    );

    const result = await getCostSummary(30);

    expect(result).toEqual({
      days: 30,
      windowCostUsd: 12.5,
      allTimeCostUsd: 100.25,
    });
  });

  it("returns null for both costs when no model_calls exist", async () => {
    vi.mocked(db.select).mockReturnValueOnce(
      makeChain([{ windowCost: null, allTimeCost: null }])
    );

    const result = await getCostSummary();

    expect(result.windowCostUsd).toBeNull();
    expect(result.allTimeCostUsd).toBeNull();
  });

  it("can return null window cost while all-time cost is known", async () => {
    vi.mocked(db.select).mockReturnValueOnce(
      makeChain([{ windowCost: null, allTimeCost: "50.0" }])
    );

    const result = await getCostSummary(7);

    expect(result.windowCostUsd).toBeNull();
    expect(result.allTimeCostUsd).toBe(50);
  });

  it("uses the default 30-day window when no argument is passed", async () => {
    vi.mocked(db.select).mockReturnValueOnce(
      makeChain([{ windowCost: "0", allTimeCost: "0" }])
    );

    const result = await getCostSummary();

    expect(result.days).toBe(30);
  });

  it("uses one live-plus-retained snapshot for window and all-time costs", async () => {
    const query = makeChain([{ windowCost: "5.00", allTimeCost: "100.00" }]);
    vi.mocked(db.select).mockReturnValue(query);
    expect(await getCostSummary(7)).toEqual({
      days: 7,
      windowCostUsd: 5,
      allTimeCostUsd: 100,
    });
    expect(db.select).toHaveBeenCalledTimes(1);
    const source = new PgDialect().sqlToQuery(query.from.mock.calls[0][0]);
    expect(source.sql).toContain('"model_calls"');
    expect(source.sql).toContain('"retained_model_metrics"');
    expect(source.sql).toContain("union all");
  });
});

describe("retained admin metric authorization", () => {
  beforeEach(() => vi.clearAllMocks());
  it.each([getJobStatusSummary, getTokenUsage, getCostSummary])(
    "does not read live or retained metrics without admin permission",
    async (action) => {
      vi.mocked(verifyRoleOrRedirect).mockRejectedValueOnce(
        new Error("NEXT_REDIRECT")
      );
      await expect(action()).rejects.toThrow("NEXT_REDIRECT");
      expect(db.select).not.toHaveBeenCalled();
    }
  );
});

// ── listRecentJobs ────────────────────────────────────────────────────────────

describe("listRecentJobs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-20T10:00:00.000Z"));
  });
  afterEach(() => vi.useRealTimers());

  const JOB_ROW = {
    jobId: "job-1",
    filename: "lecture.docx",
    requestedByEmail: "prof@osu.edu",
    status: "completed",
    model: "gpt-5.4-nano",
    totalTokens: 500,
    costUsd: "0.0025",
    createdAt: "2026-01-15T10:00:00Z",
    documentCreatedAt: "2026-01-15T10:00:00Z",
  };

  it("returns paginated rows with costUsd coerced to a number", async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(makeChain([{ value: 1 }]))
      .mockReturnValueOnce(makeChain([JOB_ROW]));

    const result = await listRecentJobs(1, 10);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].jobId).toBe("job-1");
    expect(result.rows[0].costUsd).toBe(0.0025);
  });

  it("calculates totalPages correctly", async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(makeChain([{ value: 25 }]))
      .mockReturnValueOnce(makeChain([]));

    const result = await listRecentJobs(1, 10);

    expect(result.totalCount).toBe(25);
    expect(result.totalPages).toBe(3);
  });

  it("returns page 1 of 1 when no jobs exist", async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(makeChain([{ value: 0 }]))
      .mockReturnValueOnce(makeChain([]));

    const result = await listRecentJobs(1, 10);

    expect(result.totalPages).toBe(1);
    expect(result.rows).toEqual([]);
  });

  it("clamps page below 1 to page 1", async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(makeChain([{ value: 0 }]))
      .mockReturnValueOnce(makeChain([]));

    const result = await listRecentJobs(-3, 10);

    expect(result.page).toBe(1);
  });

  it("passes null through for rows with unknown cost", async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(makeChain([{ value: 1 }]))
      .mockReturnValueOnce(makeChain([{ ...JOB_ROW, costUsd: null }]));

    const result = await listRecentJobs(1, 10);

    expect(result.rows[0].costUsd).toBeNull();
  });

  it("scopes the paginated count and filenames to unexpired undeleted documents", async () => {
    const countQuery = makeChain([{ value: 1 }]);
    const jobsQuery = makeChain([JOB_ROW]);
    vi.mocked(db.select)
      .mockReturnValueOnce(countQuery)
      .mockReturnValueOnce(jobsQuery);

    const result = await listRecentJobs();

    expect(verifyRoleOrRedirect).toHaveBeenCalledWith(["admin"]);
    expect(countQuery.innerJoin).toHaveBeenCalledTimes(1);
    for (const builder of [countQuery, jobsQuery]) {
      const query = new PgDialect().sqlToQuery(builder.where.mock.calls[0][0]);
      expect(query.sql).toContain('"documents"."deleted_at" is null');
      expect(query.sql).toContain('"documents"."created_at"');
      expect(query.sql).toContain("clock_timestamp()");
      expect(query.sql).toContain("interval '336 hours'");
      expect(query.sql).toMatch(/>/);
    }
    expect(result.rows[0]).not.toHaveProperty("documentCreatedAt");
  });

  it("removes filenames that expire during the query even when the job was recently reconverted", async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(makeChain([{ value: 2 }]))
      .mockReturnValueOnce(
        makeChain([
          {
            ...JOB_ROW,
            jobId: "expired",
            documentCreatedAt: "2026-01-06T10:00:00.000Z",
          },
          {
            ...JOB_ROW,
            jobId: "retained",
            documentCreatedAt: "2026-01-06T10:00:00.001Z",
          },
        ])
      );

    expect((await listRecentJobs()).rows.map((row) => row.jobId)).toEqual([
      "retained",
    ]);
  });

  it("does not query document filenames without admin authorization", async () => {
    vi.mocked(verifyRoleOrRedirect).mockRejectedValueOnce(
      new Error("NEXT_REDIRECT")
    );

    await expect(listRecentJobs()).rejects.toThrow("NEXT_REDIRECT");
    expect(db.select).not.toHaveBeenCalled();
  });
});

// ── listPendingUsersPage ──────────────────────────────────────────────────────

describe("listPendingUsersPage", () => {
  beforeEach(() => vi.clearAllMocks());

  const PENDING_USER = {
    id: "user-99",
    email: "new@osu.edu",
    displayName: "New Student",
    createdAt: new Date("2026-01-01"),
  };

  it("returns paginated pending users", async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(makeChain([{ value: 1 }]))
      .mockReturnValueOnce(makeChain([PENDING_USER]));

    const result = await listPendingUsersPage(1, 10);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].email).toBe("new@osu.edu");
    expect(result.totalCount).toBe(1);
    expect(result.totalPages).toBe(1);
  });

  it("returns empty rows with page 1 of 1 when there are no pending users", async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(makeChain([{ value: 0 }]))
      .mockReturnValueOnce(makeChain([]));

    const result = await listPendingUsersPage(1, 10);

    expect(result.rows).toEqual([]);
    expect(result.totalPages).toBe(1);
  });

  it("uses sensible defaults for page and pageSize", async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(makeChain([{ value: 0 }]))
      .mockReturnValueOnce(makeChain([]));

    const result = await listPendingUsersPage();

    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(10);
  });

  it("requires admin role", async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(makeChain([{ value: 0 }]))
      .mockReturnValueOnce(makeChain([]));

    await listPendingUsersPage();

    expect(verifyRoleOrRedirect).toHaveBeenCalledWith(["admin"]);
  });

  it("propagates a redirect thrown by the auth check", async () => {
    vi.mocked(verifyRoleOrRedirect).mockRejectedValueOnce(
      new Error("NEXT_REDIRECT")
    );

    await expect(listPendingUsersPage()).rejects.toThrow("NEXT_REDIRECT");
  });
});
