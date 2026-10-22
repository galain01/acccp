/** Public summary of trusted, earlier interaction tests for a matching form. */
export interface PdfInteractionTestSummary {
  evidenceId: string;
  testedAt: string;
  environment: string;
  passedChecks: string[];
  scopeNote: string;
}

const SUMMARY_KEYS = [
  "evidenceId",
  "testedAt",
  "environment",
  "passedChecks",
  "scopeNote",
] as const;

function isBoundedText(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

/** Validate stored/API data; never expose arbitrary worker or evidence metadata. */
export function readPdfInteractionTestSummary(
  value: unknown
): PdfInteractionTestSummary | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).length !== SUMMARY_KEYS.length ||
    !SUMMARY_KEYS.every((key) => Object.hasOwn(row, key)) ||
    !isBoundedText(row.evidenceId, 128) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(row.evidenceId) ||
    typeof row.testedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(row.testedAt) ||
    !isBoundedText(row.environment, 240) ||
    !Array.isArray(row.passedChecks) ||
    row.passedChecks.length < 1 ||
    row.passedChecks.length > 12 ||
    !row.passedChecks.every((check) => isBoundedText(check, 600)) ||
    new Set(row.passedChecks).size !== row.passedChecks.length ||
    !isBoundedText(row.scopeNote, 800)
  )
    return;
  const date = new Date(`${row.testedAt}T00:00:00.000Z`);
  if (
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 10) !== row.testedAt
  )
    return;
  return {
    evidenceId: row.evidenceId,
    testedAt: row.testedAt,
    environment: row.environment,
    passedChecks: [...row.passedChecks],
    scopeNote: row.scopeNote,
  };
}
