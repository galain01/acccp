import {
  getCostSummary,
  getJobStatusSummary,
  getTokenUsage,
  getUserRoleCounts,
  listRecentJobs,
} from "@/lib/actions/admin-metrics";
import {
  fetchModelPricing,
  getLiteLLMConfig,
  type ModelPricing,
} from "@/lib/litellm";
import AdminTablePagination from "./admin-table-pagination";
import { Badge } from "./badge";
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

interface AdminMetricsProps {
  jobsPage: number;
}

const STATUS_BADGE_VARIANT: Record<
  string,
  "default" | "secondary" | "destructive" | "processing" | "outline"
> = {
  completed: "default",
  needs_review: "secondary",
  processing: "processing",
  queued: "outline",
  failed: "destructive",
  expired: "destructive",
  cancelled: "destructive",
};

function formatUsd(value: number | null): string {
  if (value === null) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(value);
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

/** Live pricing is best-effort — LiteLLM being unreachable shouldn't break the tab. */
async function getCurrentModelPricing(): Promise<{
  model: string;
  pricing: ModelPricing;
} | null> {
  try {
    const config = getLiteLLMConfig();
    const pricing = await fetchModelPricing(config.model, config);
    return pricing ? { model: config.model, pricing } : null;
  } catch {
    return null;
  }
}

export default async function AdminMetrics({
  jobsPage,
}: AdminMetricsProps): Promise<React.JSX.Element> {
  const [
    roleCounts,
    jobStatus,
    tokenUsage,
    costSummary,
    recentJobs,
    currentPricing,
  ] = await Promise.all([
    getUserRoleCounts(),
    getJobStatusSummary(),
    getTokenUsage(30),
    getCostSummary(30),
    listRecentJobs(jobsPage),
    getCurrentModelPricing(),
  ]);

  return (
    <div className="flex w-full max-w-4xl flex-col gap-6">
      <p className="text-sm text-muted-foreground">
        Usage and conversion outcome totals are kept after online document
        copies expire. Token and cost windows use UTC calendar days, including
        today. File details below are available for 14 days.
      </p>
      <div className="grid grid-cols-2 gap-4 @lg:grid-cols-4">
        <Card size="sm">
          <CardHeader>
            <CardDescription>Users pending</CardDescription>
            <CardTitle>{roleCounts.pending}</CardTitle>
          </CardHeader>
          <CardContent className="text-muted-foreground">
            {roleCounts.instructor} instructors · {roleCounts.admin} admins
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <CardDescription>Job success rate</CardDescription>
            <CardTitle>{jobStatus.success.pct}%</CardTitle>
          </CardHeader>
          <CardContent className="text-muted-foreground">
            {jobStatus.success.count} succeeded ·{" "}
            <span
              className={
                jobStatus.error.count > 0 ? "text-destructive" : undefined
              }
            >
              {jobStatus.error.count} errored ({jobStatus.error.pct}%)
            </span>{" "}
            of {jobStatus.total} total
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <CardDescription>Tokens (last {tokenUsage.days}d)</CardDescription>
            <CardTitle>{formatNumber(tokenUsage.totalTokens)}</CardTitle>
          </CardHeader>
        </Card>

        <Card size="sm">
          <CardHeader>
            <CardDescription>Cost (last {costSummary.days}d)</CardDescription>
            <CardTitle>{formatUsd(costSummary.windowCostUsd)}</CardTitle>
          </CardHeader>
          <CardContent className="text-muted-foreground">
            {formatUsd(costSummary.allTimeCostUsd)} all-time
            {currentPricing
              ? ` · ${currentPricing.model}: $${(currentPricing.pricing.inputCostPerToken * 1_000_000).toFixed(2)}/1M in, $${(currentPricing.pricing.outputCostPerToken * 1_000_000).toFixed(2)}/1M out`
              : ""}
          </CardContent>
        </Card>
      </div>

      <div className="flex flex-col gap-4">
        <Table>
          <TableCaption>
            {recentJobs.rows.length === 0
              ? "No unexpired conversion jobs to display. Historical totals remain above."
              : `Unexpired conversion jobs — page ${recentJobs.page} of ${recentJobs.totalPages}.`}
          </TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead>File</TableHead>
              <TableHead>Requested by</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Model</TableHead>
              <TableHead>Tokens</TableHead>
              <TableHead>Cost</TableHead>
              <TableHead>Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {recentJobs.rows.map((row) => (
              <TableRow key={row.jobId}>
                <TableCell>{row.filename}</TableCell>
                <TableCell>{row.requestedByEmail}</TableCell>
                <TableCell>
                  <Badge
                    variant={STATUS_BADGE_VARIANT[row.status] ?? "outline"}
                  >
                    {row.status}
                  </Badge>
                </TableCell>
                <TableCell>{row.model ?? "—"}</TableCell>
                <TableCell>{formatNumber(row.totalTokens)}</TableCell>
                <TableCell>{formatUsd(row.costUsd)}</TableCell>
                <TableCell>{formatDate(row.createdAt)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {recentJobs.totalPages > 1 && (
          <AdminTablePagination
            page={recentJobs.page}
            totalPages={recentJobs.totalPages}
            param="jobsPage"
          />
        )}
      </div>
    </div>
  );
}
