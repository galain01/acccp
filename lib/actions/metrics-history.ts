"use server";

import { verifyRoleOrRedirect } from "@/lib/auth";
import {
  readMetricsHistory,
  validateMetricsHistoryRange,
  type DashboardHistory,
  type MetricsHistoryRange,
} from "@/lib/admin-metrics-history";

export async function getMetricsHistory(
  range: MetricsHistoryRange
): Promise<DashboardHistory> {
  await verifyRoleOrRedirect(["admin"]);
  return readMetricsHistory(validateMetricsHistoryRange(range));
}
