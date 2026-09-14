import { beforeEach, describe, expect, it, vi } from "vitest";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { dailyFailureMetrics } from "@/lib/db/schema";

const mocks = vi.hoisted(() => ({ authorize: vi.fn(), select: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({ verifyRoleOrRedirect: mocks.authorize }));
vi.mock("@/lib/db", () => ({ db: { select: mocks.select } }));
import { getFailureSummary } from "@/lib/actions/failure-metrics";

describe("anonymous failure metrics authorization and privacy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authorize.mockResolvedValue({ user: { role: "admin" } });
  });
  it("contains only daily category totals with no identifiers or content", () => {
    const config = getTableConfig(dailyFailureMetrics);
    expect(config.columns.map((column) => column.name)).toEqual([
      "day",
      "stage",
      "code",
      "failure_count",
    ]);
    expect(config.foreignKeys).toEqual([]);
    expect(config.enableRLS).toBe(true);
    expect(config.primaryKeys).toHaveLength(1);
  });
  it("checks admin access before validating inputs or reading data", async () => {
    mocks.authorize.mockRejectedValueOnce(new Error("Unauthorized"));
    await expect(
      getFailureSummary({ from: "not a date", to: "bad" })
    ).rejects.toThrow("Unauthorized");
    expect(mocks.authorize).toHaveBeenCalledExactlyOnceWith(["admin"]);
    expect(mocks.select).not.toHaveBeenCalled();
  });
  it("rejects malformed or inverted ranges before querying", async () => {
    await expect(
      getFailureSummary({ from: "2026-09-02", to: "2026-09-01" })
    ).rejects.toThrow("Invalid metrics date range");
    expect(mocks.select).not.toHaveBeenCalled();
  });
  it("returns only recognized categories and applies both UTC date bounds", async () => {
    const rows = [
      { stage: "audit", code: "provider_quota", count: "2" },
      { stage: "unknown private stage", code: "provider_quota", count: "1" },
      { stage: "audit", code: "upstream-private-message", count: "1" },
    ];
    const builder = {
      from: vi.fn(),
      where: vi.fn(),
      groupBy: vi.fn(),
      orderBy: vi.fn().mockResolvedValue(rows),
    };
    for (const method of [builder.from, builder.where, builder.groupBy])
      method.mockReturnValue(builder);
    mocks.select.mockReturnValue(builder);
    expect(
      await getFailureSummary({ from: "2026-09-01", to: "2026-09-02" })
    ).toEqual([{ stage: "audit", code: "provider_quota", count: 2 }]);
    const query = new PgDialect().sqlToQuery(builder.where.mock.calls[0][0]);
    expect(query.params).toEqual(["2026-09-01", "2026-09-02"]);
    expect(query.sql).toContain(">=");
    expect(query.sql).toContain("<=");
  });
});
