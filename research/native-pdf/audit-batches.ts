import {
  compactAuditEvidence,
  validateAudit,
  type NativePdfAudit,
  type SavedTag,
} from "./audit-contract";

export interface AuditBatch {
  number: number;
  tags: SavedTag[];
  artifactPages: number[];
  ocrPages: number[];
  evidence: string;
}

/** Every native tag gets detailed review; a full outline keeps cross-batch context. */
export function planAuditBatches(
  inspection: unknown,
  artifactPages: number[],
  ocrPages: number[] = []
): AuditBatch[] {
  const compact = JSON.parse(compactAuditEvidence(inspection));
  const tags: SavedTag[] = compact.structure?.tags;
  if (
    !Array.isArray(tags) ||
    !tags.length ||
    tags.length > 5000 ||
    new Set(tags.map((tag) => tag.id)).size !== tags.length
  )
    throw new Error("tag_inventory_limit");
  const groups: SavedTag[][] = [];
  let group: SavedTag[] = [],
    weight = 0;
  for (const tag of tags) {
    const size = JSON.stringify(tag).length;
    if (size > 400_000) throw new Error("single_tag_evidence_limit");
    if (group.length && (group.length >= 400 || weight + size > 400_000)) {
      groups.push(group);
      group = [];
      weight = 0;
    }
    group.push(tag);
    weight += size;
  }
  if (group.length) groups.push(group);
  if (groups.length === 1)
    return [
      {
        number: 1,
        tags,
        artifactPages,
        ocrPages,
        evidence: JSON.stringify(compact),
      },
    ];
  // The outline is context, not a substitute for any tag's detailed review.
  const outline = (items: SavedTag[]) =>
    items.map((tag) => ({
      id: tag.id,
      role: tag.role,
      parentId: tag.parentId,
      pageNumber: tag.pageNumber,
      ...(/^(H[1-6]|Figure|TH)$/.test(tag.role)
        ? { text: tag.text, alt: tag.alt }
        : {}),
    }));
  const context = {
    ...compact,
    source_structure: {
      ...compact.source_structure,
      tags: undefined,
      contextOutline: outline(compact.source_structure?.tags ?? []),
    },
    structure: {
      ...compact.structure,
      tags: undefined,
      contextOutline: outline(tags),
    },
    auditEvidenceProjection:
      "Batched review. Context outlines retain every tag's nesting, role and page, plus headings, figures and table-header labels. Only assignedOutputTags contains this batch's complete native text/content sequences. Every output tag is assigned once across the complete audit. All source/output page images accompany each batch. The first batch also reviews whole-document omissions and excluded text.",
  };
  return groups.map((assigned, index) => {
    const evidence = JSON.stringify({
      ...context,
      assignedOutputTags: assigned,
    });
    if (evidence.length > 1_000_000) throw new Error("audit_evidence_limit");
    return {
      number: index + 1,
      tags: assigned,
      artifactPages: index === 0 ? artifactPages : [],
      ocrPages: index === 0 ? ocrPages : [],
      evidence,
    };
  });
}

/** A failed, missing, repeated or incomplete batch can never yield a complete audit. */
export function combineAuditBatches(
  batches: AuditBatch[],
  results: NativePdfAudit[],
  tags: SavedTag[],
  pageCount: number,
  artifactPages: number[],
  ocrPages: number[] = []
): NativePdfAudit {
  if (!batches.length || results.length !== batches.length)
    throw new Error("audit_batch_missing");
  results.forEach((result, index) =>
    validateAudit(
      result,
      batches[index].tags,
      pageCount,
      batches[index].artifactPages,
      tags,
      batches[index].ocrPages
    )
  );
  const findings = [
    ...new Map(
      results
        .flatMap((result) => result.findings)
        .map((finding) => [JSON.stringify(finding), finding])
    ).values(),
  ];
  return validateAudit(
    {
      reviewedPages: Array.from({ length: pageCount }, (_, index) => index + 1),
      reviewedTagIds: results.flatMap((result) => result.reviewedTagIds),
      artifactReviews: results.flatMap((result) => result.artifactReviews),
      ocrReviews: results.flatMap((result) => result.ocrReviews ?? []),
      findings,
    },
    tags,
    pageCount,
    artifactPages,
    tags,
    ocrPages
  );
}
