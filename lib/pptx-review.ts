import type { PptxFinding, PptxInspection } from "./pptx-types";

export interface PowerPointReviewConcern {
  id: string;
  finding: PptxFinding;
}

export interface PowerPointReview {
  /** Findings the audit cannot dismiss, including output defects and coverage gaps. */
  fixed: PptxFinding[];
  /** Each concern requires an explicit disposition based on the repaired output. */
  concerns: PowerPointReviewConcern[];
}

function findingKey(finding: PptxFinding): string {
  return JSON.stringify([
    finding.code,
    finding.severity,
    finding.slideNumber,
    finding.objectId,
    finding.message,
    finding.suggestion,
  ]);
}

function hasKnownLocation(
  inspection: PptxInspection,
  finding: PptxFinding
): boolean {
  if (finding.slideNumber === undefined) return finding.objectId === undefined;
  const slide = inspection.slides.find(
    (item) => item.slideNumber === finding.slideNumber
  );
  if (!slide) return false;
  return (
    finding.objectId === undefined ||
    slide.objects.some((object) => object.id === finding.objectId)
  );
}

function isAuditableEngineConcern(
  inspection: PptxInspection,
  finding: PptxFinding
): boolean {
  if (finding.severity === "error") return false;
  const slide = inspection.slides.find(
    (item) => item.slideNumber === finding.slideNumber
  );
  const object = slide?.objects.find((item) => item.id === finding.objectId);
  if (!slide || !object || slide.hasTiming || object.hidden) return false;
  if (finding.code === "group-review") return object.kind === "group";
  const rect = object.rect;
  const canMatchDescribedObject =
    !object.grouped &&
    object.parentId === null &&
    rect !== null &&
    [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) &&
    rect.width > 0 &&
    rect.height > 0 &&
    Boolean(object.description.trim() || object.title.trim());
  return (
    canMatchDescribedObject &&
    ((finding.code === "authored-description-preserved" &&
      (object.kind === "image" ||
        object.kind === "chart" ||
        object.kind === "smartart")) ||
      (finding.code === "complex-object-review" &&
        (object.kind === "chart" || object.kind === "smartart")))
  );
}

/** Separate protected output facts from questions the independent audit can assess. */
export function buildPowerPointReview(
  inspection: PptxInspection,
  engineFindings: readonly PptxFinding[],
  proposedFindings: readonly PptxFinding[],
  revertedFindings: readonly PptxFinding[]
): PowerPointReview {
  const fixed = new Map<string, PptxFinding>();
  const candidates = new Map<string, PptxFinding>();
  const remember = (target: Map<string, PptxFinding>, finding: PptxFinding) => {
    const key = findingKey(finding);
    if (!target.has(key)) target.set(key, { ...finding });
  };

  for (const finding of engineFindings) {
    remember(
      isAuditableEngineConcern(inspection, finding) ? candidates : fixed,
      finding
    );
  }
  for (const finding of revertedFindings) remember(fixed, finding);
  for (const finding of proposedFindings) {
    remember(
      hasKnownLocation(inspection, finding) ? candidates : fixed,
      finding
    );
  }

  const concerns: PowerPointReviewConcern[] = [];
  for (const [key, finding] of candidates) {
    if (!fixed.has(key)) {
      concerns.push({ id: `review-${concerns.length + 1}`, finding });
    }
  }
  return { fixed: [...fixed.values()], concerns };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: string[]
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    expected.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function boundedText(
  value: unknown,
  minimum: number,
  maximum: number
): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length >= minimum && trimmed.length <= maximum
    ? trimmed
    : null;
}

/** All concerns must be accounted for exactly once; malformed responses resolve nothing. */
export function resolvePowerPointReviews(
  value: unknown,
  concerns: readonly PowerPointReviewConcern[]
): PptxFinding[] | null {
  if (!Array.isArray(value) || value.length !== concerns.length) return null;
  const expected = new Map(concerns.map((concern) => [concern.id, concern]));
  if (
    expected.size !== concerns.length ||
    concerns.some((concern) => !concern.id.trim())
  )
    return null;

  const decisions = new Map<string, PptxFinding | null>();
  for (const item of value) {
    if (!isRecord(item) || typeof item.id !== "string") return null;
    const concern = expected.get(item.id);
    if (!concern || decisions.has(item.id)) return null;
    if (item.status === "resolved") {
      if (
        !hasExactKeys(item, ["id", "status", "reason"]) ||
        boundedText(item.reason, 20, 1200) === null
      )
        return null;
      decisions.set(item.id, null);
    } else if (item.status === "needs_review" || item.status === "needs_fix") {
      if (!hasExactKeys(item, ["id", "status", "message", "suggestion"]))
        return null;
      const message = boundedText(item.message, 1, 2000);
      const suggestion = boundedText(item.suggestion, 1, 2000);
      if (message === null || suggestion === null) return null;
      decisions.set(item.id, {
        ...concern.finding,
        severity: item.status === "needs_fix" ? "error" : "warning",
        message,
        suggestion,
      });
    } else {
      return null;
    }
  }

  const remaining: PptxFinding[] = [];
  for (const concern of concerns) {
    const decision = decisions.get(concern.id);
    if (decision === undefined) return null;
    if (decision !== null) remaining.push(decision);
  }
  return remaining;
}
