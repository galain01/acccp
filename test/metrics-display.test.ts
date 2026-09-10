import { describe, expect, it } from "vitest";
import {
  costQualifier,
  formatDuration,
  formatUsd,
  metricsRange,
} from "@/lib/metrics-display";

describe("admin date controls", () => {
  const now = new Date("2026-03-01T01:00:00.000Z");
  it("includes today and crosses month/year boundaries in UTC", () => {
    expect(metricsRange({}, now).from).toBe("2026-01-31");
    expect(metricsRange({ range: "90" }, now).from).toBe("2025-12-02");
    expect(metricsRange({ range: "365" }, now).from).toBe("2025-03-02");
  });
  it("supports all history and real custom calendar ranges", () => {
    expect(metricsRange({ range: "all" }, now).from).toBeNull();
    expect(
      metricsRange(
        { range: "custom", from: "2024-02-29", to: "2026-02-28" },
        now
      ).key
    ).toBe("custom");
  });
  it.each([
    { range: "custom", from: "2026-02-29", to: "2026-03-01" },
    { range: "custom", from: "2026-02-01", to: "2026-03-02" },
    { range: "custom", from: "2026-03-01", to: "2026-02-01" },
    { range: "custom", from: "invalid", to: "2026-03-01" },
  ])("falls back for invalid custom range %j", (params) => {
    expect(metricsRange(params, now).key).toBe("30");
  });
});

describe("metric labels", () => {
  it("keeps unknown values different from real zero measurements", () => {
    expect(formatUsd(null)).toBe("Unknown");
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(0.000012)).toBe("$0.000012");
    expect(formatDuration(null)).toBe("Unknown");
    expect(formatDuration(0)).toBe("0 ms");
    expect(formatDuration(2500)).toBe("2.5 s");
  });
  it("marks estimates, incomplete pricing, and unknown old coverage together", () => {
    expect(
      costQualifier({
        estimatedCallCount: 2,
        unpricedCallCount: 1,
        unknownCostCoverage: true,
      })
    ).toContain("1 unpriced calls excluded");
    expect(
      costQualifier({
        estimatedCallCount: 0,
        unpricedCallCount: 0,
        unknownCostCoverage: true,
      })
    ).toContain("older coverage unknown");
    expect(costQualifier({ estimatedCallCount: 0, unpricedCallCount: 0 })).toBe(
      ""
    );
  });
});
