/** The local experiment permits at most two independently verified appendix pages. */
export function validateAuditPageCounts(
  before: number,
  after: number,
  inspection: { appendix_validation?: { passed?: boolean } }
): void {
  if (
    !Number.isInteger(before) ||
    !Number.isInteger(after) ||
    before < 1 ||
    before > 8 ||
    after < before ||
    after > 10 ||
    after - before > 2 ||
    (after !== before && inspection.appendix_validation?.passed !== true)
  )
    throw new Error("local_audit_page_count_or_appendix_not_verified");
}
