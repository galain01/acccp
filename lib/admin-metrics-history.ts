import "server-only";

import { sql } from "drizzle-orm";

import { db } from "./db";
import {
  conversionJobs,
  modelCalls,
  retainedJobDurationMetrics,
  retainedJobMetrics,
  retainedJobStats,
  retainedModelMetrics,
} from "./db/schema";
import {
  effectiveModelCallCostSql,
  estimatedModelCallSql,
} from "./model-cost-sql";

export interface MetricsHistoryRange {
  from: string | null;
  to: string;
}

interface HistoryUsage {
  totalTokens: number;
  costUsd: number | null;
  estimatedCallCount: number;
  unpricedCallCount: number;
  unknownCostCoverage: boolean;
}

interface HistoryJobStats {
  /** Jobs whose token/page cohort measurements are available. */
  statsJobCount: number;
  jobTokens: number;
  /** All recorded attempts, summed only for jobs with every call priced. */
  jobCostUsd: number | null;
  /** Requires at least one recorded call; older retained costs are unmeasured. */
  costMeasuredJobCount: number;
  costEstimatedJobCount: number;
  pageCountSum: number;
  pageMeasuredJobCount: number;
  medianDurationMs: number | null;
  minDurationMs: number | null;
  maxDurationMs: number | null;
  timedJobCount: number;
}

export interface DashboardHistorySummary extends HistoryUsage, HistoryJobStats {
  jobCount: number;
  successCount: number;
  failedCount: number;
}

export interface DashboardHistoryDay extends DashboardHistorySummary {
  day: string;
}

export interface DashboardHistoryModel extends HistoryUsage, HistoryJobStats {
  model: string;
  /** Older retained status totals cannot be attributed to a model. */
  jobCount: number;
}

export interface DashboardHistory {
  /** Sparse UTC days in ascending order; omitted days have no activity. */
  daily: DashboardHistoryDay[];
  summary: DashboardHistorySummary;
  models: DashboardHistoryModel[];
}

/** Validate again at the server-action boundary, regardless of client controls. */
export function validateMetricsHistoryRange(
  value: unknown,
  now = new Date()
): MetricsHistoryRange {
  const fail = () => {
    throw new Error("Invalid metrics date range.");
  };
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fail();
  const { from, to } = value as Record<string, unknown>;
  const isDate = (day: unknown): day is string => {
    if (
      typeof day !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
      day.startsWith("0000-")
    )
      return false;
    const parsed = new Date(`${day}T00:00:00.000Z`);
    return (
      Number.isFinite(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === day
    );
  };
  if (!isDate(to) || (from !== null && !isDate(from))) return fail();
  if (to > now.toISOString().slice(0, 10) || (from !== null && from > to))
    return fail();
  return { from, to };
}

/**
 * A single MVCC snapshot sees each job/call either live or retained during a
 * purge. Job cohorts follow job creation day; usage follows call creation day.
 * Duration frequencies stay in SQL: never transfer or expand per-job samples.
 */
export function metricsHistoryQuery(range: MetricsHistoryRange) {
  return sql`
    with bounds as (
      select ${range.from}::date as from_day, ${range.to}::date as to_day
    ), live_jobs as (
      select ${conversionJobs.id} as id,
        (${conversionJobs.createdAt} at time zone 'UTC')::date as day,
        coalesce(nullif(btrim(${conversionJobs.modelName}), ''), 'unknown') as model,
        ${conversionJobs.status} as status, ${conversionJobs.pageCount} as pages,
        ${conversionJobs.processingDurationMs} as duration_ms
      from ${conversionJobs}, bounds
      where (bounds.from_day is null or (${conversionJobs.createdAt} at time zone 'UTC')::date >= bounds.from_day)
        and (${conversionJobs.createdAt} at time zone 'UTC')::date <= bounds.to_day
    ), statuses as (
      select day, status, count(*) as jobs from live_jobs group by day, status
      union all
      select ${retainedJobMetrics.day}, ${retainedJobMetrics.status}, ${retainedJobMetrics.jobCount}
      from ${retainedJobMetrics}, bounds
      where (bounds.from_day is null or ${retainedJobMetrics.day} >= bounds.from_day)
        and ${retainedJobMetrics.day} <= bounds.to_day
    ), status_totals as (
      select case when grouping(day) = 1 then 'summary' else 'daily' end as kind,
        case when grouping(day) = 1 then '' else day::text end as key,
        sum(jobs) as jobs,
        sum(jobs) filter (where status in ('completed', 'needs_review')) as successes,
        sum(jobs) filter (where status in ('failed', 'expired', 'cancelled')) as failures
      from statuses group by grouping sets ((day), ())
    ), call_stats_by_job as (
      select ${modelCalls.jobId} as job_id,
        sum(${modelCalls.promptTokens}::bigint + ${modelCalls.completionTokens}) as tokens,
        sum(${effectiveModelCallCostSql()}) as cost,
        bool_and(${effectiveModelCallCostSql()} is not null) as cost_measured,
        bool_or(${estimatedModelCallSql()}) as cost_estimated
      from ${modelCalls} group by ${modelCalls.jobId}
    ), job_stats as (
      select j.day, j.model, count(*) as jobs, sum(coalesce(c.tokens, 0)) as tokens,
        sum(coalesce(j.pages, 0)) as pages, count(j.pages) as measured_pages,
        sum(c.cost) filter (where c.cost_measured) as cost,
        count(*) filter (where c.cost_measured) as measured_cost_jobs,
        count(*) filter (where c.cost_measured and c.cost_estimated) as estimated_cost_jobs
      from live_jobs j left join call_stats_by_job c on c.job_id = j.id
      group by j.day, j.model
      union all
      select ${retainedJobStats.day}, ${retainedJobStats.model}, ${retainedJobStats.jobCount},
        ${retainedJobStats.totalTokens}, ${retainedJobStats.pageCountSum}, ${retainedJobStats.pageMeasuredJobCount},
        ${retainedJobStats.jobCostUsd}, ${retainedJobStats.costMeasuredJobCount}, ${retainedJobStats.costEstimatedJobCount}
      from ${retainedJobStats}, bounds
      where (bounds.from_day is null or ${retainedJobStats.day} >= bounds.from_day)
        and ${retainedJobStats.day} <= bounds.to_day
    ), stats_totals as (
      select case when grouping(day) = 0 then 'daily' when grouping(model) = 0 then 'model' else 'summary' end as kind,
        case when grouping(day) = 0 then day::text when grouping(model) = 0 then model else '' end as key,
        sum(jobs) as jobs, sum(tokens) as tokens, sum(pages) as pages, sum(measured_pages) as measured_pages,
        sum(cost) as cost, sum(measured_cost_jobs) as measured_cost_jobs,
        sum(estimated_cost_jobs) as estimated_cost_jobs
      from job_stats group by grouping sets ((day), (model), ())
    ), usage as (
      select (${modelCalls.createdAt} at time zone 'UTC')::date as day,
        coalesce(nullif(btrim(${modelCalls.model}), ''), 'unknown') as model,
        ${modelCalls.promptTokens}::bigint + ${modelCalls.completionTokens} as tokens,
        ${effectiveModelCallCostSql()} as cost,
        case when ${estimatedModelCallSql()} then 1 else 0 end as estimated,
        case when ${effectiveModelCallCostSql()} is null then 1 else 0 end as unpriced,
        false as unknown_coverage
      from ${modelCalls}, bounds
      where (bounds.from_day is null or (${modelCalls.createdAt} at time zone 'UTC')::date >= bounds.from_day)
        and (${modelCalls.createdAt} at time zone 'UTC')::date <= bounds.to_day
      union all
      select ${retainedModelMetrics.day}, coalesce(nullif(btrim(${retainedModelMetrics.model}), ''), 'unknown'),
        ${retainedModelMetrics.promptTokens} + ${retainedModelMetrics.completionTokens}, ${retainedModelMetrics.costUsd},
        coalesce(${retainedModelMetrics.estimatedCallCount}, 0), coalesce(${retainedModelMetrics.unpricedCallCount}, 0),
        (${retainedModelMetrics.pricedCallCount} is null or ${retainedModelMetrics.estimatedCallCount} is null or ${retainedModelMetrics.unpricedCallCount} is null)
      from ${retainedModelMetrics}, bounds
      where (bounds.from_day is null or ${retainedModelMetrics.day} >= bounds.from_day)
        and ${retainedModelMetrics.day} <= bounds.to_day
    ), usage_totals as (
      select case when grouping(day) = 0 then 'daily' when grouping(model) = 0 then 'model' else 'summary' end as kind,
        case when grouping(day) = 0 then day::text when grouping(model) = 0 then model else '' end as key,
        sum(tokens) as tokens, sum(cost) as cost, sum(estimated) as estimated,
        sum(unpriced) as unpriced, bool_or(unknown_coverage) as unknown_coverage
      from usage group by grouping sets ((day), (model), ())
    ), durations as (
      select day, model, duration_ms, count(*) as weight from live_jobs
      where status in ('completed', 'needs_review') and duration_ms is not null and duration_ms >= 0
      group by day, model, duration_ms
      union all
      select ${retainedJobDurationMetrics.day}, ${retainedJobDurationMetrics.model},
        ${retainedJobDurationMetrics.durationMs}, ${retainedJobDurationMetrics.jobCount}
      from ${retainedJobDurationMetrics}, bounds
      where (bounds.from_day is null or ${retainedJobDurationMetrics.day} >= bounds.from_day)
        and ${retainedJobDurationMetrics.day} <= bounds.to_day
    ), duration_buckets as (
      select case when grouping(day) = 0 then 'daily' when grouping(model) = 0 then 'model' else 'summary' end as kind,
        case when grouping(day) = 0 then day::text when grouping(model) = 0 then model else '' end as key,
        duration_ms, sum(weight) as weight
      from durations group by grouping sets ((day, duration_ms), (model, duration_ms), (duration_ms))
    ), duration_ranks as (
      select *, sum(weight) over (partition by kind, key order by duration_ms rows unbounded preceding) as cumulative,
        sum(weight) over (partition by kind, key) as total_weight
      from duration_buckets
    ), duration_totals as (
      select kind, key, sum(weight) as jobs, min(duration_ms) as minimum, max(duration_ms) as maximum,
        (min(duration_ms) filter (where cumulative >= floor((total_weight + 1) / 2))::numeric
         + min(duration_ms) filter (where cumulative >= floor((total_weight + 2) / 2))::numeric) / 2 as median
      from duration_ranks group by kind, key
    ), keys as (
      select kind, key from status_totals union select kind, key from stats_totals
      union select kind, key from usage_totals union select kind, key from duration_totals
    )
    select k.kind, k.key,
      case when k.kind = 'model' then coalesce(j.jobs, 0) else coalesce(s.jobs, 0) end as "jobCount",
      coalesce(s.successes, 0) as "successCount", coalesce(s.failures, 0) as "failedCount",
      coalesce(u.tokens, 0) as "totalTokens", u.cost as "costUsd",
      coalesce(u.estimated, 0) as "estimatedCallCount", coalesce(u.unpriced, 0) as "unpricedCallCount",
      coalesce(u.unknown_coverage, false) as "unknownCostCoverage",
      coalesce(j.jobs, 0) as "statsJobCount", coalesce(j.tokens, 0) as "jobTokens",
      j.cost as "jobCostUsd", coalesce(j.measured_cost_jobs, 0) as "costMeasuredJobCount",
      coalesce(j.estimated_cost_jobs, 0) as "costEstimatedJobCount",
      coalesce(j.pages, 0) as "pageCountSum", coalesce(j.measured_pages, 0) as "pageMeasuredJobCount",
      d.median as "medianDurationMs", d.minimum as "minDurationMs", d.maximum as "maxDurationMs",
      coalesce(d.jobs, 0) as "timedJobCount"
    from keys k
    left join status_totals s on s.kind = k.kind and s.key = k.key
    left join stats_totals j on j.kind = k.kind and j.key = k.key
    left join usage_totals u on u.kind = k.kind and u.key = k.key
    left join duration_totals d on d.kind = k.kind and d.key = k.key
    order by k.kind, k.key
  `;
}

type DatabaseRow = Record<string, unknown> & { kind: string; key: string };

function summaryFromRow(row?: DatabaseRow): DashboardHistorySummary {
  const number = (field: string) => Number(row?.[field] ?? 0);
  const nullable = (field: string) =>
    row?.[field] == null ? null : Number(row[field]);
  return {
    jobCount: number("jobCount"),
    successCount: number("successCount"),
    failedCount: number("failedCount"),
    totalTokens: number("totalTokens"),
    costUsd: nullable("costUsd"),
    estimatedCallCount: number("estimatedCallCount"),
    unpricedCallCount: number("unpricedCallCount"),
    unknownCostCoverage: row?.unknownCostCoverage === true,
    statsJobCount: number("statsJobCount"),
    jobTokens: number("jobTokens"),
    jobCostUsd: nullable("jobCostUsd"),
    costMeasuredJobCount: number("costMeasuredJobCount"),
    costEstimatedJobCount: number("costEstimatedJobCount"),
    pageCountSum: number("pageCountSum"),
    pageMeasuredJobCount: number("pageMeasuredJobCount"),
    medianDurationMs: nullable("medianDurationMs"),
    minDurationMs: nullable("minDurationMs"),
    maxDurationMs: nullable("maxDurationMs"),
    timedJobCount: number("timedJobCount"),
  };
}

/** Server-only; callers exposing this over HTTP must authorize the admin first. */
export async function readMetricsHistory(
  range: MetricsHistoryRange
): Promise<DashboardHistory> {
  const rows = await db.execute<DatabaseRow>(metricsHistoryQuery(range));
  const history: DashboardHistory = {
    daily: [],
    summary: summaryFromRow(),
    models: [],
  };
  for (const row of rows) {
    const values = summaryFromRow(row);
    if (row.kind === "summary") history.summary = values;
    else if (row.kind === "daily")
      history.daily.push({ day: row.key, ...values });
    else if (row.kind === "model") {
      history.models.push({
        model: row.key,
        jobCount: values.jobCount,
        totalTokens: values.totalTokens,
        costUsd: values.costUsd,
        estimatedCallCount: values.estimatedCallCount,
        unpricedCallCount: values.unpricedCallCount,
        unknownCostCoverage: values.unknownCostCoverage,
        statsJobCount: values.statsJobCount,
        jobTokens: values.jobTokens,
        jobCostUsd: values.jobCostUsd,
        costMeasuredJobCount: values.costMeasuredJobCount,
        costEstimatedJobCount: values.costEstimatedJobCount,
        pageCountSum: values.pageCountSum,
        pageMeasuredJobCount: values.pageMeasuredJobCount,
        medianDurationMs: values.medianDurationMs,
        minDurationMs: values.minDurationMs,
        maxDurationMs: values.maxDurationMs,
        timedJobCount: values.timedJobCount,
      });
    }
  }
  return history;
}
