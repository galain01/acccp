import Link from "next/link";
import {
  getTokenUsage,
  getUserRoleCounts,
  listRecentJobs,
} from "@/lib/actions/admin-metrics";
import { getMetricsHistory } from "@/lib/actions/metrics-history";
import {
  costQualifier,
  formatDuration,
  formatNumber,
  formatUsd,
  type MetricsRange,
} from "@/lib/metrics-display";
import AdminTablePagination from "./admin-table-pagination";
import MetricsTrend from "./metrics-trend";
import { Badge } from "./badge";
import { Button } from "./button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "./card";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./table";

const STATUS_BADGE_VARIANT = {
  completed: "default",
  needs_review: "secondary",
  processing: "processing",
  queued: "outline",
  failed: "destructive",
  expired: "destructive",
  cancelled: "destructive",
} as const;

function MetricCard({
  title,
  value,
  children,
}: {
  title: string;
  value: string;
  children?: React.ReactNode;
}) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardDescription>{title}</CardDescription>
        <CardTitle className="text-2xl tabular-nums">{value}</CardTitle>
      </CardHeader>
      {children && (
        <CardContent className="text-sm text-muted-foreground">
          {children}
        </CardContent>
      )}
    </Card>
  );
}

export default async function AdminMetrics({
  jobsPage,
  range,
}: {
  jobsPage: number;
  range: MetricsRange;
}) {
  const [roleCounts, tokens30, recentJobs, history] = await Promise.all([
    getUserRoleCounts(),
    getTokenUsage(30),
    listRecentJobs(jobsPage),
    getMetricsHistory({ from: range.from, to: range.to }),
  ]);
  const summary = history.summary;
  const filters: Record<string, string> = {
    range: range.key,
    ...(range.from ? { from: range.from } : {}),
    to: range.to,
  };
  const avgTokens = summary.statsJobCount
    ? formatNumber(summary.jobTokens / summary.statsJobCount)
    : "Unknown";
  const successRate = summary.jobCount
    ? formatNumber((100 * summary.successCount) / summary.jobCount) + "%"
    : "No jobs";
  return (
    <div className="flex w-full min-w-0 flex-col gap-6 pt-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold">Usage and performance</h2>
          <p className="text-sm text-muted-foreground">
            {roleCounts.pending} users pending · {roleCounts.instructor}{" "}
            instructors · {roleCounts.admin} admins
          </p>
        </div>
        <p className="text-sm text-muted-foreground">
          All dates use UTC. Aggregated history stays after the 14-day document
          purge.
        </p>
      </div>
      <nav aria-label="Metrics date range" className="flex flex-wrap gap-2">
        {(
          [
            ["30", "30 days"],
            ["90", "90 days"],
            ["365", "1 year"],
            ["all", "All time"],
          ] as const
        ).map(([key, label]) => (
          <Button
            key={key}
            variant={range.key === key ? "default" : "outline"}
            size="sm"
            render={
              <Link
                href={"?range=" + key}
                aria-current={range.key === key ? "page" : undefined}
              >
                {label}
              </Link>
            }
          />
        ))}
      </nav>
      <form
        action="/admin"
        method="get"
        className="flex flex-wrap items-end gap-3"
      >
        <input type="hidden" name="range" value="custom" />
        <label className="flex flex-col gap-1 text-sm">
          From
          <input
            key={"from-" + range.from}
            className="rounded-md border bg-background px-3 py-2"
            type="date"
            name="from"
            defaultValue={range.from ?? undefined}
            max={new Date().toISOString().slice(0, 10)}
            required
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Through
          <input
            key={"to-" + range.to}
            className="rounded-md border bg-background px-3 py-2"
            type="date"
            name="to"
            defaultValue={range.to}
            max={new Date().toISOString().slice(0, 10)}
            required
          />
        </label>
        <Button variant="outline" type="submit">
          Apply dates
        </Button>
      </form>
      <h3 className="font-medium">{range.label}</h3>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          title="Jobs / success rate"
          value={formatNumber(summary.jobCount) + " / " + successRate}
        >
          {formatNumber(summary.successCount)} succeeded ·{" "}
          {formatNumber(summary.failedCount)} failed, expired or cancelled.
          Latest status per document.
        </MetricCard>
        <MetricCard
          title="Tokens in selected period"
          value={formatNumber(summary.totalTokens)}
        >
          Input + output for every recorded model call, including retries.
        </MetricCard>
        <MetricCard title="Average tokens per job" value={avgTokens}>
          All attempts for jobs created in this period.{" "}
          {formatNumber(summary.statsJobCount)} of{" "}
          {formatNumber(summary.jobCount)} jobs have this history.
        </MetricCard>
        <MetricCard
          title="Model cost in selected period"
          value={formatUsd(summary.costUsd)}
        >
          {costQualifier(summary) ||
            (summary.costUsd === null
              ? "No priced calls in this period."
              : "Gateway-reported model charges.")}{" "}
          Excludes hosting and storage.
        </MetricCard>
        <MetricCard
          title="Median successful job time"
          value={formatDuration(summary.medianDurationMs)}
        >
          Minimum {formatDuration(summary.minDurationMs)} · maximum{" "}
          {formatDuration(summary.maxDurationMs)}.{" "}
          {formatNumber(summary.timedJobCount)} measured jobs.
        </MetricCard>
        <MetricCard
          title="Pages in selected jobs"
          value={
            summary.pageMeasuredJobCount
              ? formatNumber(summary.pageCountSum)
              : "Unknown"
          }
        >
          {formatNumber(summary.pageMeasuredJobCount)} of{" "}
          {formatNumber(summary.jobCount)} jobs have page counts. Latest PDF per
          job.
        </MetricCard>
        <MetricCard
          title="Tokens in the last 30 days"
          value={formatNumber(tokens30.totalTokens)}
        >
          Always the most recent 30 UTC days, regardless of the selected period.
        </MetricCard>
        <MetricCard
          title="Average pages per measured job"
          value={
            summary.pageMeasuredJobCount
              ? formatNumber(
                  summary.pageCountSum / summary.pageMeasuredJobCount
                )
              : "Unknown"
          }
        >
          Older jobs without page or duration measurements are excluded from
          those averages.
        </MetricCard>
      </div>
      <p className="text-sm text-muted-foreground">
        Job statistics group documents by the date their first conversion job
        was created. Usage and cost group calls by the date they ran. Successful
        job time covers server processing through rendering, conversion and
        saving for the latest attempt; it excludes the browser upload.
        Historical list-price estimates assume uncached input when cache details
        were not recorded.
      </p>
      <MetricsTrend days={history.daily} from={range.from} to={range.to} />
      <section className="min-w-0" aria-labelledby="metrics-models">
        <h3 id="metrics-models" className="mb-3 font-semibold">
          By model
        </h3>
        <Table>
          <TableCaption>
            Usage includes all calls. Jobs, pages and timing use each job’s
            latest model; older totals may lack model attribution.
          </TableCaption>
          <TableHeader>
            <TableRow>
              {[
                "Model",
                "Tokens",
                "Model cost",
                "Jobs with history",
                "Avg tokens / job",
                "Pages",
                "Median time",
                "Min / max time",
              ].map((label) => (
                <TableHead key={label}>{label}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {history.models.map((row) => (
              <TableRow key={row.model}>
                <TableCell className="max-w-64 break-words whitespace-normal">
                  {row.model}
                </TableCell>
                <TableCell>{formatNumber(row.totalTokens)}</TableCell>
                <TableCell>
                  {formatUsd(row.costUsd)}
                  <div className="max-w-56 text-xs whitespace-normal text-muted-foreground">
                    {costQualifier(row)}
                  </div>
                </TableCell>
                <TableCell>{formatNumber(row.statsJobCount)}</TableCell>
                <TableCell>
                  {row.statsJobCount
                    ? formatNumber(row.jobTokens / row.statsJobCount)
                    : "Unknown"}
                </TableCell>
                <TableCell>
                  {row.pageMeasuredJobCount
                    ? formatNumber(row.pageCountSum)
                    : "Unknown"}
                </TableCell>
                <TableCell>{formatDuration(row.medianDurationMs)}</TableCell>
                <TableCell>
                  {formatDuration(row.minDurationMs)} /{" "}
                  {formatDuration(row.maxDurationMs)}
                </TableCell>
              </TableRow>
            ))}
            {!history.models.length && (
              <TableRow>
                <TableCell colSpan={8}>
                  No model activity in this period.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </section>
      <section
        className="flex min-w-0 flex-col gap-4"
        aria-labelledby="metrics-recent"
      >
        <h3 id="metrics-recent" className="font-semibold">
          Recent jobs
        </h3>
        <p className="text-sm text-muted-foreground">
          Unexpired documents from the last 14 days, independent of the history
          filter. Job tokens and cost include all attempts; pages and successful
          processing time describe the latest attempt.
        </p>
        <Table>
          <TableCaption>
            {recentJobs.rows.length
              ? "Page " +
                recentJobs.page +
                " of " +
                recentJobs.totalPages +
                ". File details disappear after expiry; aggregated metrics remain."
              : "No unexpired jobs. Historical totals remain above."}
          </TableCaption>
          <TableHeader>
            <TableRow>
              {[
                "File / requester",
                "Status",
                "Model",
                "Attempts",
                "Pages",
                "Job time",
                "Tokens",
                "Job cost",
                "Created (UTC)",
              ].map((label) => (
                <TableHead key={label}>{label}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {recentJobs.rows.map((row) => (
              <TableRow key={row.jobId}>
                <TableCell className="max-w-64 break-words whitespace-normal">
                  {row.filename}
                  <div className="text-xs text-muted-foreground">
                    {row.requestedByEmail}
                  </div>
                </TableCell>
                <TableCell>
                  <Badge
                    variant={
                      STATUS_BADGE_VARIANT[
                        row.status as keyof typeof STATUS_BADGE_VARIANT
                      ] ?? "outline"
                    }
                  >
                    {row.status}
                  </Badge>
                </TableCell>
                <TableCell className="max-w-40 break-words whitespace-normal">
                  {row.model ?? "Unknown"}
                </TableCell>
                <TableCell>{row.attemptCount}</TableCell>
                <TableCell>{row.pageCount ?? "Unknown"}</TableCell>
                <TableCell>
                  {formatDuration(row.processingDurationMs)}
                </TableCell>
                <TableCell>{formatNumber(row.totalTokens)}</TableCell>
                <TableCell>
                  {formatUsd(row.costUsd)}
                  <div className="max-w-48 text-xs whitespace-normal text-muted-foreground">
                    {costQualifier(row)}
                  </div>
                </TableCell>
                <TableCell>
                  {new Date(row.createdAt)
                    .toISOString()
                    .slice(0, 16)
                    .replace("T", " ")}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {recentJobs.totalPages > 1 && (
          <AdminTablePagination
            page={recentJobs.page}
            totalPages={recentJobs.totalPages}
            param="jobsPage"
            filters={filters}
          />
        )}
      </section>
    </div>
  );
}
