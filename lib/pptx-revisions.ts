import { createHash } from "node:crypto";
import {
  applyPptxRepairs,
  inspectPptx,
  PptxPackageError,
  validatePptxRepairPlan,
} from "./pptx-package";
import type {
  PptxChange,
  PptxInspection,
  PptxObject,
  PptxRepairPlan,
  PptxRepairResult,
  PptxRevisionBundle,
  PptxRevisionChange,
  PptxSlideRepairs,
} from "./pptx-types";

const digest = (value: Buffer | string) =>
  createHash("sha256").update(value).digest("hex");
function invalid(
  message = "The saved PowerPoint revision information could not be verified."
): never {
  throw new PptxPackageError("pptx_integrity", message);
}

/** No machine finding currently proves a missing title/header/description's intended meaning. */
export function buildPptxMechanicalPlan(
  inspection: PptxInspection
): PptxRepairPlan {
  return {
    slides: inspection.slides.map(({ slideNumber }) => ({ slideNumber })),
  };
}

/** Combine a corrective pass with earlier operations so export always starts at the original. */
export function mergePptxRepairPlans(
  initial: PptxRepairPlan,
  correction: PptxRepairPlan
): PptxRepairPlan {
  if (!validatePptxRepairPlan(initial) || !validatePptxRepairPlan(correction))
    invalid();
  const result = structuredClone(initial);
  for (const next of correction.slides) {
    let target = result.slides.find(
      (slide) => slide.slideNumber === next.slideNumber
    );
    if (!target) {
      target = { slideNumber: next.slideNumber };
      result.slides.push(target);
    }
    if (next.titleObjectId !== undefined)
      target.titleObjectId = next.titleObjectId;
    if (next.readingOrder !== undefined)
      target.readingOrder = [...next.readingOrder];
    if (next.language !== undefined) target.language = { ...next.language };
    for (const key of [
      "descriptions",
      "decorativeObjects",
      "longDescriptions",
      "tableHeaders",
      "splitTableCaption",
      "objectBounds",
    ] as const) {
      const entries = new Map(
        (target[key] ?? []).map((entry) => [entry.objectId, entry])
      );
      for (const entry of next[key] ?? []) {
        const prior = entries.get(entry.objectId);
        entries.set(
          entry.objectId,
          key === "objectBounds" &&
            prior &&
            "sourceRect" in prior &&
            "sourceRect" in entry
            ? { ...entry, sourceRect: prior.sourceRect }
            : entry
        );
      }
      if (entries.size) Object.assign(target, { [key]: [...entries.values()] });
    }
    const languages = new Map(
      (target.textLanguages ?? []).map((entry) => [
        JSON.stringify([entry.objectId, entry.sourceText]),
        entry,
      ])
    );
    for (const entry of next.textLanguages ?? [])
      languages.set(JSON.stringify([entry.objectId, entry.sourceText]), entry);
    if (languages.size) target.textLanguages = [...languages.values()];
    const styles = new Map(
      (target.textStyles ?? []).map((entry) => [
        JSON.stringify([entry.objectId, entry.sourceText]),
        entry,
      ])
    );
    for (const entry of next.textStyles ?? []) {
      const key = JSON.stringify([entry.objectId, entry.sourceText]);
      styles.set(key, { ...styles.get(key), ...entry });
    }
    if (styles.size) target.textStyles = [...styles.values()];
    const links = [...(target.linkTexts ?? [])];
    for (const entry of next.linkTexts ?? []) {
      const index = links.findIndex(
        (prior) =>
          prior.objectId === entry.objectId &&
          (prior.sourceText === entry.sourceText ||
            prior.text === entry.sourceText)
      );
      if (index < 0) links.push(entry);
      else links[index] = { ...entry, sourceText: links[index].sourceText };
    }
    if (links.length) target.linkTexts = links;
    const notes = new Map(
      (target.revisionNotes ?? []).map((entry) => [
        JSON.stringify([entry.type, entry.objectId]),
        entry,
      ])
    );
    for (const entry of next.revisionNotes ?? [])
      notes.set(JSON.stringify([entry.type, entry.objectId]), entry);
    if (notes.size) target.revisionNotes = [...notes.values()];
  }
  result.slides.sort((left, right) => left.slideNumber - right.slideNumber);
  if (!validatePptxRepairPlan(result)) invalid();
  return result;
}

function languageSummary(object: PptxObject | undefined): string {
  const combined: { text: string; language: string | null }[] = [];
  for (const run of object?.textRuns ?? []) {
    const prior = combined.at(-1);
    if (prior && prior.language === run.language) prior.text += run.text;
    else combined.push({ text: run.text, language: run.language });
  }
  return combined
    .map(
      (run) => `${run.language ?? "Inherited language setting"}: ${run.text}`
    )
    .join("\n");
}

function objectLabel(object: PptxObject): string {
  const text =
    object.text.trim() ||
    object.description.trim() ||
    object.name ||
    object.kind;
  return `${text.length > 160 ? `${text.slice(0, 157)}…` : text} (object ${object.id})`;
}

function styleSummary(object: PptxObject | undefined): string {
  const combined: { text: string; style: string }[] = [];
  for (const run of object?.textRuns ?? []) {
    const style = `${run.fontSizePt === undefined ? "Inherited font size" : `${run.fontSizePt} pt`}, ${run.colorHex ? `#${run.colorHex.toUpperCase()}` : "inherited color"}`;
    const prior = combined.at(-1);
    if (prior?.style === style) prior.text += run.text;
    else combined.push({ style, text: run.text });
  }
  return combined.map((run) => `${run.style}: ${run.text}`).join("\n");
}

function positionSummary(object: PptxObject | undefined): string {
  const rect = object?.rect;
  const inches = (value: number) => Number((value / 914400).toFixed(6));
  return rect
    ? `From the slide's left edge: ${inches(rect.x)} in; from top: ${inches(rect.y)} in; width: ${inches(rect.width)} in; height: ${inches(rect.height)} in.`
    : "Position inherited from the slide layout";
}

function revisionValues(
  change: PptxChange,
  source: PptxInspection,
  output: PptxInspection
): [string, string] {
  const beforeSlide = source.slides[change.slideNumber - 1];
  const afterSlide = output.slides[change.slideNumber - 1];
  const before = beforeSlide.objects.find(
    (item) => item.id === change.objectId
  );
  const after = afterSlide.objects.find((item) => item.id === change.objectId);
  switch (change.type) {
    case "description":
      return [
        before?.description || "No description",
        after?.description || "No description",
      ];
    case "decorative":
      return [before, after].map((object) =>
        object?.decorative
          ? "Skipped by screen readers (decorative image)"
          : "Included for screen readers"
      ) as [string, string];
    case "long-description":
      return [
        before?.description || "No description",
        `Short description: ${after?.description || "No description"}\n\n${
          change.generatedSlideNumbers
            ?.map((slideNumber) => {
              const slide = output.slides.find(
                (item) => item.slideNumber === slideNumber
              );
              if (!slide) invalid();
              return `Added description slide ${slideNumber}:\n${slide.objects
                .map((object) => object.text)
                .filter(Boolean)
                .join("\n")}`;
            })
            .join("\n\n") ?? ""
        }`,
      ];
    case "title":
      return [
        before?.isTitle
          ? `Slide title: ${before.text}`
          : `Ordinary text: ${before?.text ?? ""}`,
        `Slide title: ${after?.text ?? ""}`,
      ];
    case "language":
      return [languageSummary(before), languageSummary(after)];
    case "text-style":
      return [styleSummary(before), styleSummary(after)];
    case "position":
      return [positionSummary(before), positionSummary(after)];
    case "link-text":
      return [before?.text ?? "", after?.text ?? ""];
    case "reading-order":
      return [beforeSlide, afterSlide].map((slide) =>
        slide.objects
          .filter((object) => !object.grouped)
          .map(
            (object, index) =>
              `${index + 1}. ${objectLabel(beforeSlide.objects.find((source) => source.id === object.id) ?? object)}`
          )
          .join("\n")
      ) as [string, string];
    case "table-header":
      return [
        `First row is ${before?.table?.firstRow ? "" : "not "}marked as column labels: ${before?.table?.cells[0]?.join(" | ") ?? ""}`,
        `First row is ${after?.table?.firstRow ? "" : "not "}marked as column labels: ${after?.table?.cells[0]?.join(" | ") ?? ""}`,
      ];
    case "table-caption":
      return [
        before?.table?.cells.map((row) => row.join(" | ")).join("\n") ?? "",
        `${afterSlide.objects
          .filter(
            (object) =>
              !beforeSlide.objects.some((original) => original.id === object.id)
          )
          .map((object) => object.text)
          .join(
            "\n"
          )}\n${after?.table?.cells.map((row) => row.join(" | ")).join("\n") ?? ""}`,
      ];
  }
}

const labels: Record<PptxChange["type"], string> = {
  title: "Identify the slide title",
  description: "Describe the object's information",
  decorative: "Choose whether students hear this image",
  "long-description": "Add slides with the full image description",
  language: "Set the passage's spoken language",
  "reading-order": "Set the order students hear",
  "table-header": "Identify the table's column labels",
  "table-caption": "Separate the table caption and column labels",
  "link-text": "Make the link wording meaningful",
  "text-style": "Improve the text's size or color",
  position: "Improve the object's position or size",
};

/** The ledger describes the reopened output, rather than trusting the model's claimed edits. */
export async function createPptxRevisionBundle(
  source: Buffer,
  plan: PptxRepairPlan
): Promise<{
  result: PptxRepairResult;
  bundle: PptxRevisionBundle;
}> {
  if (!validatePptxRepairPlan(plan)) invalid();
  const immutablePlan = structuredClone(plan);
  const before = await inspectPptx(source);
  const result = await applyPptxRepairs(source, immutablePlan, {
    revisioned: true,
  });
  const groups = new Map<string, PptxChange[]>();
  for (const change of result.changes) {
    if (!change.operationId) invalid();
    const caption = result.changes.some(
      (other) =>
        other.type === "table-caption" &&
        other.slideNumber === change.slideNumber &&
        other.objectId === change.objectId
    );
    const imageAlternative =
      (change.type === "description" || change.type === "decorative") &&
      result.changes.some(
        (other) =>
          other.type === "decorative" &&
          other.slideNumber === change.slideNumber &&
          other.objectId === change.objectId
      );
    const key = JSON.stringify([
      change.slideNumber,
      caption ? "table-caption" : imageAlternative ? "decorative" : change.type,
      change.objectId,
    ]);
    groups.set(key, [...(groups.get(key) ?? []), change]);
  }
  const changes: PptxRevisionChange[] = [];
  for (const group of groups.values()) {
    const first =
      group.find((change) => change.type === "table-caption") ??
      group.find((change) => change.type === "decorative") ??
      group[0];
    const values = new Map(group.map((change) => [change.type, change]));
    const pairs = [...values.values()].map((change) =>
      revisionValues(change, before, result.inspection)
    );
    const original = pairs
      .map(
        (pair, index) =>
          `${pairs.length > 1 ? `${labels[[...values.keys()][index]]}:\n` : ""}${pair[0]}`
      )
      .join("\n\n");
    const revised = pairs
      .map(
        (pair, index) =>
          `${pairs.length > 1 ? `${labels[[...values.keys()][index]]}:\n` : ""}${pair[1]}`
      )
      .join("\n\n");
    // The displayed empty-description label can itself be literal authored text.
    const sameActualDescription =
      first.type === "description" &&
      before.slides[first.slideNumber - 1].objects.find(
        (object) => object.id === first.objectId
      )?.description ===
        result.inspection.slides[first.slideNumber - 1].objects.find(
          (object) => object.id === first.objectId
        )?.description;
    if (
      first.type === "description"
        ? sameActualDescription
        : original === revised
    )
      continue;
    const note = immutablePlan.slides
      .find((slide) => slide.slideNumber === first.slideNumber)
      ?.revisionNotes?.find(
        (note) => note.type === first.type && note.objectId === first.objectId
      );
    const relatedNotes =
      immutablePlan.slides
        .find((slide) => slide.slideNumber === first.slideNumber)
        ?.revisionNotes?.filter((note) =>
          group.some(
            (change) =>
              note.type === change.type && note.objectId === change.objectId
          )
        ) ?? [];
    const assumption = [
      ...new Set(relatedNotes.map((note) => note.assumption).filter(Boolean)),
    ].join(" ");
    const operationIds = [
      ...new Set(group.map((change) => change.operationId!)),
    ];
    const compositeDescription =
      first.type === "decorative" &&
      group.some((change) => change.type === "description");
    changes.push({
      id: `change-${digest(operationIds.join("\n")).slice(0, 20)}`,
      type: first.type,
      slideNumber: first.slideNumber,
      ...(first.objectId ? { objectId: first.objectId } : {}),
      label: labels[first.type],
      before: original,
      after: revised,
      reason: group.some((change) => change.type !== first.type)
        ? [
            ...new Set(
              group.map(
                (change) =>
                  relatedNotes.find((note) => note.type === change.type)
                    ?.reason ?? change.message
              )
            ),
          ].join(" ")
        : (note?.reason ?? first.message),
      ...(assumption ? { assumption } : {}),
      operationIds,
      ...(first.type === "description" || compositeDescription
        ? { editableDescription: true }
        : {}),
      ...(compositeDescription
        ? {
            descriptionBefore:
              before.slides[first.slideNumber - 1].objects.find(
                (object) => object.id === first.objectId
              )?.description ?? "",
            descriptionAfter:
              result.inspection.slides[first.slideNumber - 1].objects.find(
                (object) => object.id === first.objectId
              )?.description ?? "",
          }
        : {}),
      ...(first.generatedSlideNumbers?.length
        ? { generatedSlideNumbers: [...first.generatedSlideNumbers] }
        : {}),
    });
  }
  return {
    result,
    bundle: {
      version: 1,
      sourceHash: digest(source),
      plan: immutablePlan,
      changes,
    },
  };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function selectedPlan(
  plan: PptxRepairPlan,
  operationIds: Set<string>
): PptxRepairPlan {
  plan = structuredClone(plan);
  return {
    slides: plan.slides.map((slide) => {
      const target: PptxSlideRepairs = { slideNumber: slide.slideNumber };
      const key = (type: string, object: string) =>
        `${slide.slideNumber}:${type}:${object}`;
      if (
        slide.titleObjectId &&
        operationIds.has(key("title", slide.titleObjectId))
      )
        target.titleObjectId = slide.titleObjectId;
      if (slide.readingOrder && operationIds.has(key("reading-order", "slide")))
        target.readingOrder = slide.readingOrder;
      const fields = {
        descriptions: "description",
        decorativeObjects: "decorative",
        longDescriptions: "long-description",
        tableHeaders: "table-header",
        splitTableCaption: "table-caption",
        objectBounds: "position",
      } as const;
      for (const [field, type] of Object.entries(fields) as [
        keyof typeof fields,
        string,
      ][]) {
        const values = slide[field]?.filter((entry) =>
          operationIds.has(key(type, entry.objectId))
        );
        if (values?.length) Object.assign(target, { [field]: values });
      }
      target.textLanguages = slide.textLanguages?.filter((_, index) =>
        operationIds.has(key("language", String(index)))
      );
      target.linkTexts = slide.linkTexts?.filter((_, index) =>
        operationIds.has(key("link-text", String(index)))
      );
      target.textStyles = slide.textStyles?.filter((_, index) =>
        operationIds.has(key("text-style", String(index)))
      );
      return target;
    }),
  };
}

/** Only IDs and optional description wording come from the browser. The bundle stays server-owned. */
export async function replayPptxRevisions(
  source: Buffer,
  bundle: PptxRevisionBundle,
  selectedIds: string[],
  descriptionEdits: Record<string, string> = {}
): Promise<PptxRepairResult> {
  if (
    !bundle ||
    bundle.version !== 1 ||
    bundle.sourceHash !== digest(source) ||
    !validatePptxRepairPlan(bundle.plan)
  )
    invalid();
  if (
    !Array.isArray(selectedIds) ||
    selectedIds.length > 3000 ||
    new Set(selectedIds).size !== selectedIds.length ||
    !descriptionEdits ||
    typeof descriptionEdits !== "object" ||
    Array.isArray(descriptionEdits)
  )
    invalid();
  const verified = await createPptxRevisionBundle(source, bundle.plan);
  if (canonical(verified.bundle) !== canonical(bundle)) invalid();
  const known = new Map(bundle.changes.map((change) => [change.id, change]));
  if (selectedIds.some((id) => typeof id !== "string" || !known.has(id)))
    invalid();
  const selected = new Set(selectedIds);
  const operations = new Set(
    selectedIds.flatMap((id) => known.get(id)!.operationIds)
  );
  const plan = selectedPlan(bundle.plan, operations);
  for (const [id, text] of Object.entries(descriptionEdits)) {
    const change = known.get(id);
    if (
      !change?.editableDescription ||
      !selected.has(id) ||
      typeof text !== "string" ||
      !text.trim() ||
      text.length > 2000 ||
      !text.isWellFormed() ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)
    )
      invalid();
    const operation = plan.slides
      .find((slide) => slide.slideNumber === change.slideNumber)
      ?.descriptions?.find((entry) => entry.objectId === change.objectId);
    if (!operation) invalid();
    operation.text = text;
  }
  return applyPptxRepairs(source, plan, { revisioned: true });
}
