import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

vi.mock("@/lib/actions/admin-metrics", () => ({
  getTokenUsage: vi.fn(),
  getUserRoleCounts: vi.fn(),
  listRecentJobs: vi.fn(),
}));
vi.mock("@/lib/actions/metrics-history", () => ({
  getMetricsHistory: vi.fn(),
}));

import AdminMetrics from "@/components/ui/admin-metrics";
import {
  getTokenUsage,
  getUserRoleCounts,
  listRecentJobs,
} from "@/lib/actions/admin-metrics";
import { getMetricsHistory } from "@/lib/actions/metrics-history";
import type {
  DashboardHistory,
  DashboardHistoryDay,
} from "@/lib/admin-metrics-history";
import type { MetricsRange } from "@/lib/metrics-display";

const SOL = "gpt-5.6-sol-2026-07-09";
const LONG_FILENAME =
  "Synthetic accessibility evaluation of interdisciplinary course communication and weekly assignments with multiple revisions and instructor annotations — final Word conversion review.docx";
const SELECTED_RANGE: MetricsRange = {
  key: "30",
  from: "2026-08-12",
  to: "2026-09-10",
  label: "Last 30 days",
};

function historyFixture(): DashboardHistory {
  const daily: DashboardHistoryDay[] = Array.from(
    { length: 12 },
    (_, index) => {
      const date = new Date("2026-08-30T00:00:00Z");
      date.setUTCDate(date.getUTCDate() + index);
      const measured = index >= 4;
      const hasHistory = index >= 2;
      const succeeded = index !== 0 && index !== 1;
      return {
        day: date.toISOString().slice(0, 10),
        jobCount: 1,
        successCount: succeeded ? 1 : 0,
        failedCount: succeeded ? 0 : 1,
        totalTokens: (index + 1) * 1000,
        costUsd: index === 0 ? null : (index + 1) / 100,
        estimatedCallCount: index === 2 || index === 3 ? 1 : 0,
        unpricedCallCount: index === 0 ? 1 : 0,
        unknownCostCoverage: index === 1,
        statsJobCount: hasHistory ? 1 : 0,
        jobTokens: hasHistory ? (index + 1) * 1000 : 0,
        pageCountSum: measured ? 3 : 0,
        pageMeasuredJobCount: measured ? 1 : 0,
        timedJobCount: measured ? 1 : 0,
        medianDurationMs: measured ? (index - 3) * 10_000 : null,
        minDurationMs: measured ? (index - 3) * 10_000 : null,
        maxDurationMs: measured ? (index - 3) * 10_000 : null,
      };
    }
  );
  return {
    daily,
    summary: {
      jobCount: 12,
      successCount: 10,
      failedCount: 2,
      totalTokens: 78_000,
      costUsd: 0.77,
      estimatedCallCount: 2,
      unpricedCallCount: 1,
      unknownCostCoverage: true,
      statsJobCount: 10,
      jobTokens: 75_000,
      pageCountSum: 24,
      pageMeasuredJobCount: 8,
      medianDurationMs: 45_000,
      minDurationMs: 10_000,
      maxDurationMs: 80_000,
      timedJobCount: 8,
    },
    models: [
      {
        model: SOL,
        jobCount: 10,
        statsJobCount: 10,
        totalTokens: 75_000,
        jobTokens: 75_000,
        costUsd: 0.75,
        estimatedCallCount: 2,
        unpricedCallCount: 0,
        unknownCostCoverage: false,
        pageCountSum: 24,
        pageMeasuredJobCount: 8,
        medianDurationMs: 45_000,
        minDurationMs: 10_000,
        maxDurationMs: 80_000,
        timedJobCount: 8,
      },
      {
        model: "legacy-model-with-unknown-coverage",
        jobCount: 0,
        statsJobCount: 0,
        totalTokens: 2000,
        jobTokens: 0,
        costUsd: 0.02,
        estimatedCallCount: 0,
        unpricedCallCount: 0,
        unknownCostCoverage: true,
        pageCountSum: 0,
        pageMeasuredJobCount: 0,
        medianDurationMs: null,
        minDurationMs: null,
        maxDurationMs: null,
        timedJobCount: 0,
      },
      {
        model: "synthetic-unpriced-model",
        jobCount: 0,
        statsJobCount: 0,
        totalTokens: 1000,
        jobTokens: 0,
        costUsd: null,
        estimatedCallCount: 0,
        unpricedCallCount: 1,
        unknownCostCoverage: false,
        pageCountSum: 0,
        pageMeasuredJobCount: 0,
        medianDurationMs: null,
        minDurationMs: null,
        maxDurationMs: null,
        timedJobCount: 0,
      },
    ],
  };
}

function jobsFixture(): Awaited<ReturnType<typeof listRecentJobs>> {
  const rows = Array.from({ length: 12 }, (_, index) => ({
    jobId: `synthetic-job-${index}`,
    filename:
      index === 0
        ? "synthetic-unknown-metrics.pdf"
        : index === 1
          ? LONG_FILENAME
          : `Synthetic course week ${index}.pdf`,
    requestedByEmail: `synthetic.instructor${index}@osu.edu`,
    status: index === 0 ? "failed" : index === 1 ? "needs_review" : "completed",
    model: index === 0 ? null : SOL,
    totalTokens: index === 0 ? 1000 : 7500,
    costUsd: index === 0 ? null : 0.075,
    pageCount: index === 0 ? null : 3,
    processingDurationMs: index === 0 ? null : 45_000,
    attemptCount: index === 1 ? 3 : 1,
    estimatedCallCount: index === 1 ? 1 : 0,
    unpricedCallCount: index === 0 ? 1 : 0,
    createdAt: "2026-09-09T17:42:00.000Z",
  }));
  return {
    rows: rows.slice(0, 10),
    page: 1,
    pageSize: 10,
    totalCount: 12,
    totalPages: 2,
  };
}

function textContent(markup: string): string {
  return markup
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function rowContaining(markup: string, needle: string): string {
  const row = markup
    .match(/<tr\b[^>]*>[\s\S]*?<\/tr>/g)
    ?.find((candidate) => candidate.includes(needle));
  expect(
    row,
    `Expected a rendered table row containing ${needle}`
  ).toBeDefined();
  return row!;
}

let previewMarkup = "";
let consoleErrors: ReturnType<typeof vi.spyOn>;
const fetchGuard = vi.fn(() => {
  throw new Error("SSR fixture must not access the network.");
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-10T12:00:00.000Z"));
  // Supports both Vite's automatic JSX transform and classic-transformed deps.
  vi.stubGlobal("React", React);
  vi.stubGlobal("fetch", fetchGuard);
  // Capture SSR diagnostics once; report a count rather than hundreds of
  // repeated warning bodies or the entire rendered dashboard on failure.
  consoleErrors = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(getUserRoleCounts).mockResolvedValue({
    pending: 2,
    instructor: 14,
    admin: 1,
  });
  vi.mocked(getTokenUsage).mockResolvedValue({ days: 30, totalTokens: 78_000 });
  vi.mocked(listRecentJobs).mockResolvedValue(jobsFixture());
  vi.mocked(getMetricsHistory).mockResolvedValue(historyFixture());
});

afterEach(() => {
  const errorCount = consoleErrors.mock.calls.length;
  expect(fetchGuard).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  expect(
    errorCount,
    "React SSR must not emit errors or invalid-title warnings"
  ).toBe(0);
});

async function renderDashboard(range = SELECTED_RANGE) {
  return renderToStaticMarkup(await AdminMetrics({ jobsPage: 1, range }));
}

describe("real admin metrics server rendering", () => {
  it("renders the 12-job fixture with measured averages and qualified cost totals", async () => {
    const markup = await renderDashboard();
    previewMarkup = markup;
    const text = textContent(markup);
    expect(text).toContain("12 / 83.3%");
    expect(text).toContain("10 succeeded · 2 failed, expired or cancelled");
    expect(text).toContain("Average tokens per job 7,500");
    expect(text).toContain("10 of 12 jobs have this history");
    expect(text).toContain("Model cost in selected period $0.77");
    expect(text).toContain(
      "includes estimates · 1 unpriced calls excluded · older coverage unknown"
    );
    expect(text).toContain("Median successful job time 45 s");
    expect(text).toContain("Minimum 10 s · maximum 1m 20s");
    expect(text).toContain("Pages in selected jobs 24");
    expect(text).toContain("8 of 12 jobs have page counts");
    expect(text).toContain("Average pages per measured job 3");
    expect(getTokenUsage).toHaveBeenCalledWith(30);
    expect(getMetricsHistory).toHaveBeenCalledWith({
      from: "2026-08-12",
      to: "2026-09-10",
    });
  });

  it("renders unknown prices/pages/times as Unknown rather than zero", async () => {
    const markup = await renderDashboard();
    const recent = textContent(
      rowContaining(markup, "synthetic-unknown-metrics.pdf")
    );
    expect(recent.match(/Unknown/g)).toHaveLength(4);
    expect(recent).toContain("1 unpriced calls excluded");
    expect(recent).not.toContain("$0.00");
    expect(recent).not.toContain("0 ms");
    const unpricedModel = textContent(
      rowContaining(markup, "synthetic-unpriced-model")
    );
    expect(unpricedModel).toContain("Unknown");
    expect(unpricedModel).not.toContain("$0.00");
    expect(
      textContent(rowContaining(markup, "legacy-model-with-unknown-coverage"))
    ).toContain("older coverage unknown");
  });

  it("keeps source qualifiers, a long filename and selected filters in real table markup", async () => {
    const markup = await renderDashboard();
    const longRow = rowContaining(markup, LONG_FILENAME);
    expect(longRow).toContain("break-words whitespace-normal");
    expect(textContent(longRow)).toContain("needs_review");
    expect(textContent(longRow)).toContain("3 3 45 s 7,500 $0.075");
    expect(textContent(longRow)).toContain("includes estimates");
    expect(markup).toContain('aria-label="Metrics date range"');
    expect(markup).toContain('href="?range=90"');
    expect(markup).toContain('href="?range=all"');
    expect(markup).toContain(
      'href="?range=30&amp;from=2026-08-12&amp;to=2026-09-10&amp;jobsPage=2"'
    );
    expect(markup).toContain('name="from"');
    expect(markup).toContain('value="2026-08-12"');
    expect(markup).toContain('name="to"');
    expect(markup).toContain('value="2026-09-10"');
  });

  it.each([45, 125])(
    "renders %i dated rows as a chart plus 30 exact daily rows with navigation",
    async (dayCount) => {
      const history = historyFixture();
      const first = new Date("2026-09-10T00:00:00Z");
      first.setUTCDate(first.getUTCDate() - dayCount + 1);
      history.daily = Array.from({ length: dayCount }, (_, index) => {
        const day = new Date(first);
        day.setUTCDate(day.getUTCDate() + index);
        return {
          ...history.daily[index % history.daily.length],
          day: day.toISOString().slice(0, 10),
        };
      });
      vi.mocked(getMetricsHistory).mockResolvedValue(history);
      const markup = await renderDashboard({
        key: "all",
        from: null,
        to: "2026-09-10",
        label: "All time",
      });
      const details = markup.match(/<details\b[^>]*>[\s\S]*?<\/details>/)?.[0];
      expect(details).toBeDefined();
      const dailyRows = details!.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/g)!.slice(1);
      expect(dailyRows).toHaveLength(30);
      expect(textContent(dailyRows[0])).toContain("2026-09-10");
      expect(textContent(dailyRows.at(-1)!)).toContain("2026-08-12");
      expect(textContent(details!)).toContain(
        `Page 1 of ${Math.ceil(dayCount / 30)}`
      );
      expect(textContent(details!)).toContain("Older");
      expect(markup).toContain(
        dayCount > 120 ? "Monthly tokens over time" : "Daily tokens over time"
      );
      expect(markup).toContain('role="img"');
      expect(markup).toContain("Exact values and missing-data notes");
    }
  );
});

async function compiledCss(directory: string): Promise<string> {
  const entries = await readdir(directory, { withFileTypes: true });
  const chunks = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return compiledCss(path);
      return entry.isFile() && entry.name.endsWith(".css")
        ? readFile(path, "utf8")
        : "";
    })
  );
  return chunks.join("\n");
}

afterAll(async () => {
  const output = process.env.METRICS_PREVIEW_OUTPUT;
  if (!output || !previewMarkup) return;
  if (!isAbsolute(output))
    throw new Error("METRICS_PREVIEW_OUTPUT must be an absolute path.");
  const css = await compiledCss(resolve(".next/static"));
  if (!css.trim())
    throw new Error("Build the app before exporting the styled SSR preview.");
  await mkdir(dirname(output), { recursive: true });
  await writeFile(
    output,
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic admin metrics preview</title><style>${css.replace(/<\/style/gi, "<\\/style")}</style><style>body{margin:0;background:#f8fafc;font-family:Arial,Helvetica,sans-serif}main{max-width:1440px;margin:0 auto;padding:24px}.fixture-note{margin-bottom:16px;padding:12px;border:1px solid #cbd5e1;background:#fff;border-radius:8px;font-size:14px;color:#334155}</style></head><body><main><p class="fixture-note">Synthetic dashboard fixture. Static layout preview; filters and chart controls are not connected.</p>${previewMarkup}</main></body></html>`,
    "utf8"
  );
});
