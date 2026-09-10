/** Fixed elapsed time from the original upload, independent of reconversion. */
export const DOCUMENT_RETENTION_DAYS = 14;
export const DOCUMENT_RETENTION_MS =
  DOCUMENT_RETENTION_DAYS * 24 * 60 * 60 * 1000;

function timestamp(value: string | Date): number {
  const milliseconds =
    value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(milliseconds))
    throw new RangeError("Invalid retention date.");
  return milliseconds;
}

export function retentionExpiresAt(createdAt: string | Date): string {
  return new Date(timestamp(createdAt) + DOCUMENT_RETENTION_MS).toISOString();
}

export function retentionCutoff(now: Date = new Date()): string {
  return new Date(timestamp(now) - DOCUMENT_RETENTION_MS).toISOString();
}

/** Exact expiry is unavailable, rather than granting one extra millisecond. */
export function isDocumentExpired(
  createdAt: string | Date,
  now: Date = new Date()
): boolean {
  return timestamp(now) >= timestamp(createdAt) + DOCUMENT_RETENTION_MS;
}
