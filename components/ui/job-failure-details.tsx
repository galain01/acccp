import type { RecentJobFailure } from "@/lib/actions/admin-metrics";
import {
  describeJobDiagnostic,
  diagnosticStageLabel,
  readJobDiagnostic,
} from "@/lib/job-diagnostics";
import { formatDuration } from "@/lib/metrics-display";

/** Native disclosure keeps the admin-only, sanitized content server-rendered. */
export default function JobFailureDetails({
  failure,
  filename,
}: {
  failure: RecentJobFailure | null;
  filename: string;
}) {
  const diagnostic = readJobDiagnostic(failure?.diagnostic);
  const occurredAt = failure?.occurredAt;
  const validDate =
    typeof occurredAt === "string" && Number.isFinite(Date.parse(occurredAt));
  const fields: [string, string][] = diagnostic
    ? [
        ["Stage", diagnosticStageLabel(diagnostic.stage)],
        ["Diagnostic code", diagnostic.code],
        ...(diagnostic.model !== undefined
          ? [["Model", diagnostic.model] as [string, string]]
          : []),
        ...(diagnostic.httpStatus !== undefined
          ? [["HTTP status", String(diagnostic.httpStatus)] as [string, string]]
          : []),
        ...(diagnostic.pageNumber !== undefined
          ? [["PDF page", String(diagnostic.pageNumber)] as [string, string]]
          : []),
        ...(diagnostic.elapsedMs !== undefined
          ? [
              ["Time in this step", formatDuration(diagnostic.elapsedMs)] as [
                string,
                string,
              ],
            ]
          : []),
        ...(diagnostic.attemptNumber !== undefined
          ? [["Attempt", String(diagnostic.attemptNumber)] as [string, string]]
          : []),
        ...(diagnostic.retryAfterSeconds !== undefined
          ? [
              [
                "Provider wait hint",
                `${diagnostic.retryAfterSeconds} seconds`,
              ] as [string, string],
            ]
          : []),
        ...(diagnostic.providerRequestId !== undefined
          ? [
              ["Provider request ID", diagnostic.providerRequestId] as [
                string,
                string,
              ],
            ]
          : []),
        ...(validDate
          ? [
              [
                "Failed (UTC)",
                new Date(occurredAt)
                  .toISOString()
                  .slice(0, 19)
                  .replace("T", " "),
              ] as [string, string],
            ]
          : []),
      ]
    : [];
  return (
    <details className="mt-2 max-w-sm whitespace-normal">
      <summary className="cursor-pointer rounded text-sm underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-ring">
        Error details<span className="sr-only"> for {filename}</span>
      </summary>
      <div className="mt-2 space-y-3 rounded-md border bg-muted/30 p-3 text-sm">
        <p>
          {diagnostic
            ? describeJobDiagnostic(diagnostic)
            : "Detailed reason was not recorded for this failure."}
        </p>
        {fields.length > 0 && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            {fields.map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="font-medium">{label}</dt>
                <dd className="min-w-0 break-words">{value}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </details>
  );
}
