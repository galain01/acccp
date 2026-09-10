export type MetricsRangeKey = "30" | "90" | "365" | "all" | "custom";
export interface MetricsRange {
  key: MetricsRangeKey;
  from: string | null;
  to: string;
  label: string;
}

export function validDate(value: string | undefined): value is string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    value.startsWith("0000-")
  )
    return false;
  const time = Date.parse(`${value}T00:00:00.000Z`);
  return (
    Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value
  );
}

/** Bad URL filters fall back to 30 days; dates always represent UTC calendar days. */
export function metricsRange(
  params: { range?: string; from?: string; to?: string },
  now = new Date()
): MetricsRange {
  const today = now.toISOString().slice(0, 10);
  if (
    params.range === "custom" &&
    validDate(params.from) &&
    validDate(params.to) &&
    params.from <= params.to &&
    params.to <= today
  ) {
    return {
      key: "custom",
      from: params.from,
      to: params.to,
      label: `${params.from} to ${params.to}`,
    };
  }
  if (params.range === "all")
    return { key: "all", from: null, to: today, label: "All time" };
  const key =
    params.range === "90" || params.range === "365" ? params.range : "30";
  const from = new Date(`${today}T00:00:00.000Z`);
  from.setUTCDate(from.getUTCDate() - Number(key) + 1);
  return {
    key,
    from: from.toISOString().slice(0, 10),
    to: today,
    label: `Last ${key} days`,
  };
}

export function formatUsd(value: number | null): string {
  if (value === null) return "Unknown";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  }).format(value);
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(
    value
  );
}

export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "Unknown";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60000) return `${formatNumber(ms / 1000)} s`;
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function costQualifier(value: {
  estimatedCallCount: number;
  unpricedCallCount: number;
  unknownCostCoverage?: boolean;
}): string {
  const labels = [];
  if (value.estimatedCallCount > 0 || value.unknownCostCoverage)
    labels.push("includes estimates");
  if (value.unpricedCallCount > 0)
    labels.push(
      `${formatNumber(value.unpricedCallCount)} unpriced calls excluded`
    );
  if (value.unknownCostCoverage) labels.push("older coverage unknown");
  return labels.join(" · ");
}
