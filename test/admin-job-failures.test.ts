import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const mocks = vi.hoisted(() => ({ select: vi.fn(), authorize: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({ verifyRoleOrRedirect: mocks.authorize }));
vi.mock("@/lib/db", () => ({ db: { select: mocks.select } }));
vi.mock("@/lib/storage", () => ({
  removeObjects: vi.fn(),
  sourceDocxKey: vi.fn(),
  sourcePdfKey: vi.fn(),
  htmlOutputKey: vi.fn(),
}));

import { listRecentJobs } from "@/lib/actions/admin-metrics";

function chain(value: unknown) {
  const promise = Promise.resolve(value);
  const builder = {
    from: vi.fn(),
    innerJoin: vi.fn(),
    leftJoin: vi.fn(),
    where: vi.fn(),
    groupBy: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn(),
    offset: vi.fn(),
    then: promise.then.bind(promise),
  };
  for (const key of [
    "from",
    "innerJoin",
    "leftJoin",
    "where",
    "groupBy",
    "orderBy",
    "limit",
    "offset",
  ] as const)
    builder[key].mockReturnValue(builder);
  return builder;
}
const diagnostic = {
  version: 1,
  stage: "audit",
  code: "provider_rate_limit",
  attemptNumber: 2,
  model: "gpt-5.6-sol-2026-07-09",
  httpStatus: 429,
  elapsedMs: 1200,
  retryAfterSeconds: 30,
  providerRequestId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
};
function row(overrides: Record<string, unknown> = {}) {
  return {
    jobId: "11111111-2222-4333-8444-555555555555",
    filename: "Synthetic course.pdf",
    requestedByEmail: "synthetic@osu.edu",
    status: "failed",
    model: null,
    totalTokens: 100,
    costUsd: null,
    estimatedCallCount: 0,
    unpricedCallCount: 1,
    pageCount: 3,
    processingDurationMs: null,
    attemptCount: 2,
    createdAt: "2026-09-13T10:00:00Z",
    startedAt: "2026-09-14T11:00:00Z",
    documentCreatedAt: "2026-09-13T10:00:00Z",
    documentDeletedAt: null,
    failureEvent: { createdAt: "2026-09-14T11:01:00Z", diagnostic },
    ...overrides,
  };
}
function queued(rows: unknown[]) {
  const count = chain([{ value: rows.length }]);
  const records = chain(rows);
  mocks.select.mockReturnValueOnce(count).mockReturnValueOnce(records);
  return { count, records };
}
const sqlText = (statement: SQL) => new PgDialect().sqlToQuery(statement).sql;
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-14T12:00:00Z"));
  mocks.authorize.mockResolvedValue({ user: { role: "admin" } });
});
afterEach(() => vi.useRealTimers());

describe("admin recent failure access", () => {
  it.each(["signed out", "instructor"])(
    "does not query details for %s",
    async () => {
      mocks.authorize.mockRejectedValue(new Error("Unauthorized"));
      await expect(listRecentJobs()).rejects.toThrow("Unauthorized");
      expect(mocks.authorize).toHaveBeenCalledWith(["admin"]);
      expect(mocks.select).not.toHaveBeenCalled();
    }
  );

  it("bounds the latest failure event and applies retention to both SQL reads", async () => {
    const { count, records } = queued([row()]);
    await listRecentJobs(1, 1000);
    for (const builder of [count, records]) {
      const where = sqlText(builder.where.mock.calls[0][0]);
      expect(where).toContain('"documents"."deleted_at" is null');
      expect(where).toContain('"documents"."created_at" > clock_timestamp()');
      expect(where).toContain("interval '336 hours'");
    }
    const selection = mocks.select.mock.calls[1][0];
    const query = sqlText(selection.failureEvent);
    expect(query).toContain("limit 1");
    expect(query).toContain("failure.created_at >= coalesce");
    expect(query).toContain('"conversion_jobs"."started_at"');
    expect(query).toContain("'conversion_failed', 'output_storage_failed'");
    expect(query).toContain("<= 4096");
    expect(query).not.toContain("failure.message");
    expect(Object.keys(selection)).not.toContain("errorMessage");
    expect(records.limit).toHaveBeenCalledWith(100);
  });

  it("returns only validated fields from a matching current attempt", async () => {
    queued([row()]);
    const result = (await listRecentJobs()).rows[0];
    expect(result.failure).toEqual({
      diagnostic,
      occurredAt: "2026-09-14T11:01:00.000Z",
    });
    expect(result).not.toHaveProperty("failureEvent");
    expect(result).not.toHaveProperty("documentCreatedAt");
  });

  it.each([
    { documentCreatedAt: "2026-08-31T12:00:00Z" },
    { documentCreatedAt: "2026-08-31T11:59:59Z" },
    { documentDeletedAt: "2026-09-14T11:59:00Z" },
  ])(
    "removes records that are expired or tombstoned at the after-fetch check",
    async (overrides) => {
      queued([row(overrides)]);
      expect((await listRecentJobs()).rows).toEqual([]);
    }
  );

  it.each([
    "processing",
    "completed",
    "needs_review",
    "queued",
    "cancelled",
    "expired",
  ])("does not show a prior failure for current status %s", async (status) => {
    queued([row({ status })]);
    expect((await listRecentJobs()).rows[0].failure).toBeNull();
  });

  it.each([
    { failureEvent: { createdAt: "2026-09-14T10:59:59Z", diagnostic } },
    {
      failureEvent: {
        createdAt: "2026-09-14T11:01:00Z",
        diagnostic: { ...diagnostic, attemptNumber: 1 },
      },
    },
    { startedAt: null },
  ])(
    "does not attach an older or unprovable attempt to a new failure",
    async (overrides) => {
      queued([row(overrides)]);
      expect((await listRecentJobs()).rows[0].failure).toEqual({
        diagnostic: null,
        occurredAt: null,
      });
    }
  );

  it("uses creation time only for a legacy first attempt", async () => {
    queued([
      row({
        startedAt: null,
        attemptCount: 1,
        failureEvent: {
          createdAt: "2026-09-13T10:01:00Z",
          diagnostic: { ...diagnostic, attemptNumber: 1 },
        },
      }),
    ]);
    expect(
      (await listRecentJobs()).rows[0].failure?.diagnostic?.attemptNumber
    ).toBe(1);
  });

  it.each([
    null,
    { diagnostic: { version: 7, stage: "audit", code: "provider_rate_limit" } },
    {
      diagnostic: {
        version: 1,
        stage: "private source",
        code: "unknown_error",
      },
    },
  ])(
    "uses a fixed fallback for missing or malformed legacy diagnostics",
    async (event) => {
      queued([
        row({
          failureEvent: event,
          errorMessage: "SYNTHETIC_PRIVATE_TEXT",
          errorCode: "<script>example</script>",
        }),
      ]);
      const result = (await listRecentJobs()).rows[0];
      expect(result.failure).toEqual({ diagnostic: null, occurredAt: null });
      expect(JSON.stringify(result)).not.toContain("SYNTHETIC_PRIVATE_TEXT");
      expect(JSON.stringify(result)).not.toContain("<script>");
    }
  );

  it("strips unrecognized metadata and unsafe optional strings before returning it", async () => {
    queued([
      row({
        failureEvent: {
          createdAt: "2026-09-14T11:01:00Z",
          message: "SYNTHETIC_PRIVATE_TEXT",
          diagnostic: {
            ...diagnostic,
            model: "https://private.invalid/token",
            providerRequestId: "SYNTHETIC_PRIVATE_TEXT",
            rawError: "SYNTHETIC_PRIVATE_TEXT",
            html: "<script>example</script>",
          },
        },
      }),
    ]);
    const result = (await listRecentJobs()).rows[0];
    expect(result.failure?.diagnostic?.code).toBe("provider_rate_limit");
    expect(result.failure?.diagnostic).not.toHaveProperty("model");
    expect(result.failure?.diagnostic).not.toHaveProperty("providerRequestId");
    expect(JSON.stringify(result)).not.toContain("SYNTHETIC_PRIVATE_TEXT");
    expect(JSON.stringify(result)).not.toContain("private.invalid");
    expect(JSON.stringify(result)).not.toContain("<script>");
  });
});
