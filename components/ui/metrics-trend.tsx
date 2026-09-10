"use client";

import { useId, useState } from "react";
import type { DashboardHistoryDay } from "@/lib/admin-metrics-history";
import {
  costQualifier,
  formatDuration,
  formatNumber,
  formatUsd,
} from "@/lib/metrics-display";
import { Button } from "./button";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./table";

type Metric = "totalTokens" | "costUsd" | "jobCount" | "pageCountSum";
const METRICS: { key: Metric; label: string }[] = [
  { key: "totalTokens", label: "Tokens" },
  { key: "costUsd", label: "Cost (USD)" },
  { key: "jobCount", label: "Jobs" },
  { key: "pageCountSum", label: "Pages" },
];

/** Calendar buckets make quiet days visible and keep long histories readable. */
function chartBuckets(
  days: DashboardHistoryDay[],
  from: string | null,
  to: string,
  metric: Metric
) {
  const start = from ?? days[0]?.day ?? to;
  const span = (Date.parse(to) - Date.parse(start)) / 86400000 + 1;
  const monthly = span > 120;
  const yearly = span > 3650;
  const keyFor = (day: string) => day.slice(0, yearly ? 4 : monthly ? 7 : 10);
  const buckets = new Map<
    string,
    { label: string; value: number; known: boolean; incomplete: boolean }
  >();
  const cursor = new Date(start + "T00:00:00.000Z");
  if (yearly) cursor.setUTCMonth(0, 1);
  else if (monthly) cursor.setUTCDate(1);
  while (cursor.toISOString().slice(0, 10) <= to) {
    const label = keyFor(cursor.toISOString().slice(0, 10));
    buckets.set(label, { label, value: 0, known: true, incomplete: false });
    if (yearly) cursor.setUTCFullYear(cursor.getUTCFullYear() + 1);
    else if (monthly) cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    else cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  for (const day of days) {
    const bucket = buckets.get(keyFor(day.day));
    if (!bucket) continue;
    const value = day[metric];
    if (metric === "costUsd") {
      bucket.incomplete ||=
        day.unpricedCallCount > 0 || day.unknownCostCoverage;
      if (
        value === null &&
        (day.totalTokens > 0 ||
          day.unpricedCallCount > 0 ||
          day.unknownCostCoverage)
      )
        bucket.known = false;
    } else if (metric === "pageCountSum") {
      bucket.incomplete ||= day.pageMeasuredJobCount < day.jobCount;
      if (day.jobCount > 0 && day.pageMeasuredJobCount === 0)
        bucket.known = false;
    }
    bucket.value += value ?? 0;
  }
  return {
    buckets: [...buckets.values()],
    interval: yearly ? "Yearly" : monthly ? "Monthly" : "Daily",
  };
}

export default function MetricsTrend({
  days,
  from,
  to,
}: {
  days: DashboardHistoryDay[];
  from: string | null;
  to: string;
}) {
  const [metric, setMetric] = useState<Metric>("totalTokens");
  const [page, setPage] = useState(1);
  const id = useId();
  const { buckets, interval } = chartBuckets(days, from, to, metric);
  const max = Math.max(1, ...buckets.map((row) => row.value));
  const label = METRICS.find((item) => item.key === metric)!.label;
  const format = metric === "costUsd" ? formatUsd : formatNumber;
  const step = 680 / Math.max(1, buckets.length);
  const totalPages = Math.max(1, Math.ceil(days.length / 30));
  const safePage = Math.min(page, totalPages);
  const dailyRows = [...days]
    .reverse()
    .slice((safePage - 1) * 30, safePage * 30);
  return (
    <section
      className="min-w-0 rounded-xl border p-4"
      aria-labelledby={id + "-heading"}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 id={id + "-heading"} className="font-semibold">
          Activity over time
        </h3>
        <div
          role="group"
          aria-label="Chart metric"
          className="flex flex-wrap gap-2"
        >
          {METRICS.map((item) => (
            <Button
              key={item.key}
              size="sm"
              variant={item.key === metric ? "default" : "outline"}
              aria-pressed={item.key === metric}
              onClick={() => setMetric(item.key)}
            >
              {item.label}
            </Button>
          ))}
        </div>
      </div>
      <p className="mt-2 text-sm text-muted-foreground">
        {interval} {label.toLowerCase()}. Empty dates have no recorded activity.
        Cost and page totals may be incomplete; see the daily values for
        coverage. Hollow dots indicate unknown totals.
      </p>
      <div
        className="overflow-x-auto"
        role="region"
        aria-label="Activity chart"
        tabIndex={0}
      >
        <svg
          viewBox="0 0 780 270"
          className="mt-3 min-w-140"
          role="img"
          aria-labelledby={id + "-title " + id + "-desc"}
        >
          <title
            id={id + "-title"}
          >{`${interval} ${label.toLowerCase()} over time`}</title>
          <desc id={id + "-desc"}>
            Bar chart. Exact values and missing-data notes are in the Daily
            history table below. Cost bars show known subtotals when some costs
            are unavailable.
          </desc>
          {[0, 0.5, 1].map((fraction) => (
            <g key={fraction}>
              <line
                x1="85"
                x2="765"
                y1={215 - 180 * fraction}
                y2={215 - 180 * fraction}
                stroke="currentColor"
                opacity="0.15"
              />
              <text
                x="77"
                y={219 - 180 * fraction}
                textAnchor="end"
                fill="currentColor"
                fontSize="11"
              >
                {format(max * fraction)}
              </text>
            </g>
          ))}
          {buckets.map((row, index) =>
            row.value === 0 && !row.known ? (
              <circle
                key={row.label}
                cx={85 + (index + 0.5) * step}
                cy={215}
                r={3}
                fill="white"
                stroke="currentColor"
              >
                <title>{`${row.label}: Unknown`}</title>
              </circle>
            ) : (
              <rect
                key={row.label}
                x={85 + index * step + step * 0.12}
                y={215 - (180 * row.value) / max}
                width={Math.max(1, step * 0.76)}
                height={Math.max(
                  row.value > 0 ? 1 : 0,
                  (180 * row.value) / max
                )}
                rx="1"
                className="fill-primary"
              >
                <title>{`${row.label}: ${row.value === 0 && !row.known ? "Unknown" : format(row.value)}${row.incomplete || !row.known ? " (incomplete)" : ""}`}</title>
              </rect>
            )
          )}
          <text x="85" y="244" fill="currentColor" fontSize="12">
            {buckets[0]?.label}
          </text>
          <text
            x="765"
            y="244"
            textAnchor="end"
            fill="currentColor"
            fontSize="12"
          >
            {buckets.at(-1)?.label}
          </text>
        </svg>
      </div>
      <details className="mt-4">
        <summary className="cursor-pointer font-medium">
          Daily history and exact values
        </summary>
        <Table>
          <TableCaption>
            Days with recorded activity, newest first. Tokens and cost use call
            dates; job counts and performance use job creation dates. Pages and
            times omit unknown measurements.
          </TableCaption>
          <TableHeader>
            <TableRow>
              {[
                "Day (UTC)",
                "Jobs / succeeded",
                "Tokens",
                "Avg tokens / job",
                "Model cost",
                "Pages / measured jobs",
                "Median time",
                "Min / max time",
              ].map((text) => (
                <TableHead key={text}>{text}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {dailyRows.map((row) => (
              <TableRow key={row.day}>
                <TableCell>{row.day}</TableCell>
                <TableCell>
                  {row.jobCount} / {row.successCount}
                </TableCell>
                <TableCell>{formatNumber(row.totalTokens)}</TableCell>
                <TableCell>
                  {row.statsJobCount
                    ? formatNumber(row.jobTokens / row.statsJobCount)
                    : "Unknown"}
                  <div className="text-xs text-muted-foreground">
                    {row.statsJobCount} jobs with history
                  </div>
                </TableCell>
                <TableCell>
                  {formatUsd(row.costUsd)}
                  <div className="max-w-52 text-xs whitespace-normal text-muted-foreground">
                    {costQualifier(row)}
                  </div>
                </TableCell>
                <TableCell>
                  {row.pageMeasuredJobCount
                    ? formatNumber(row.pageCountSum)
                    : "Unknown"}{" "}
                  / {row.pageMeasuredJobCount}
                </TableCell>
                <TableCell>
                  {formatDuration(row.medianDurationMs)}
                  <div className="text-xs text-muted-foreground">
                    {row.timedJobCount} measured
                  </div>
                </TableCell>
                <TableCell>
                  {formatDuration(row.minDurationMs)} /{" "}
                  {formatDuration(row.maxDurationMs)}
                </TableCell>
              </TableRow>
            ))}
            {!dailyRows.length && (
              <TableRow>
                <TableCell colSpan={8}>No activity in this period.</TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
        {totalPages > 1 && (
          <div className="mt-3 flex items-center justify-center gap-3">
            <Button
              variant="outline"
              size="sm"
              disabled={safePage === 1}
              onClick={() => setPage(safePage - 1)}
            >
              Newer
            </Button>
            <span className="text-sm" aria-live="polite">
              Page {safePage} of {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={safePage === totalPages}
              onClick={() => setPage(safePage + 1)}
            >
              Older
            </Button>
          </div>
        )}
      </details>
    </section>
  );
}
