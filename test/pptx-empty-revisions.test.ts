import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { applyPptxRepairs, inspectPptx } from "../lib/pptx-package";
import {
  buildPptxMechanicalPlan,
  createPptxRevisionBundle,
  mergePptxRepairPlans,
  normalizePptxReadingOrders,
  replayPptxRevisions,
} from "../lib/pptx-revisions";
import type { PptxRepairPlan, PptxRevisionBundle } from "../lib/pptx-types";
import {
  imageFixture,
  pictureXml,
  unzipParts,
  zipParts,
} from "./pptx-image-fixture";

const emptyPlaceholder = (id: number) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Content Placeholder ${id}"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="${id}"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp>`;
const fixture = () =>
  imageFixture({
    picture: emptyPlaceholder(4) + pictureXml() + emptyPlaceholder(5),
  });
const digest = (value: Buffer | string) =>
  createHash("sha256").update(value).digest("hex");

describe("mechanical empty-placeholder revisions", () => {
  it("plans only reader-verified empty placeholders, including on hidden slides", async () => {
    const source = await fixture();
    const parts = await unzipParts(source);
    parts.set(
      "ppt/slides/slide1.xml",
      Buffer.from(
        parts
          .get("ppt/slides/slide1.xml")!
          .toString()
          .replace("<p:sld ", '<p:sld show="0" ')
      )
    );
    const hidden = await inspectPptx(await zipParts([...parts]));
    expect(hidden.slides[0].hidden).toBe(true);
    expect(buildPptxMechanicalPlan(hidden)).toEqual({
      slides: [{ slideNumber: 1, removeEmptyPlaceholders: ["4", "5"] }],
    });
    const unverified = structuredClone(hidden);
    delete unverified.slides[0].objects.find((object) => object.id === "4")!
      .emptyPlaceholder;
    expect(buildPptxMechanicalPlan(unverified)).toEqual({
      slides: [{ slideNumber: 1, removeEmptyPlaceholders: ["5"] }],
    });
  });

  it("records actual independent removals and restores the exact original or one chosen placeholder", async () => {
    const source = await fixture();
    const plan = buildPptxMechanicalPlan(await inspectPptx(source));
    const { result, bundle } = await createPptxRevisionBundle(source, plan);
    expect(
      result.inspection.slides[0].objects.map((object) => object.id)
    ).toEqual(["2", "3"]);
    expect(bundle.changes).toHaveLength(2);
    const first = bundle.changes.find((change) => change.objectId === "4")!;
    expect(first).toMatchObject({
      type: "empty-placeholder",
      label: "Remove empty placeholder",
      before: "Empty placeholder: Content Placeholder 4",
      after: "Removed from this slide. No lesson content was deleted.",
      operationIds: ["1:empty-placeholder:4"],
    });
    expect(
      (await replayPptxRevisions(source, bundle, [])).buffer.equals(source)
    ).toBe(true);
    const partial = await replayPptxRevisions(source, bundle, [first.id]);
    expect(
      partial.inspection.slides[0].objects.map((object) => object.id)
    ).toEqual(["2", "3", "5"]);
    const originalParts = await unzipParts(source);
    const outputParts = await unzipParts(result.buffer);
    for (const [name, bytes] of originalParts) {
      if (name !== "ppt/slides/slide1.xml")
        expect(outputParts.get(name)).toEqual(bytes);
    }
  });

  it("normalizes cleaned reading order to original slots so either removal can be restored independently", async () => {
    const source = await fixture();
    const inspection = await inspectPptx(source);
    const plan = normalizePptxReadingOrders(
      mergePptxRepairPlans(buildPptxMechanicalPlan(inspection), {
        slides: [{ slideNumber: 1, readingOrder: ["3", "2"] }],
      }),
      inspection
    );
    expect(plan.slides[0].readingOrder).toEqual(["3", "4", "2", "5"]);
    const { result, bundle } = await createPptxRevisionBundle(source, plan);
    expect(
      result.inspection.slides[0].objects.map((object) => object.id)
    ).toEqual(["3", "2"]);
    const order = bundle.changes.find(
      (change) => change.type === "reading-order"
    )!;
    expect(order.before).not.toContain("Content Placeholder");
    expect(order.after).not.toContain("Content Placeholder");
    const keepOrderOnly = await replayPptxRevisions(source, bundle, [order.id]);
    expect(
      keepOrderOnly.inspection.slides[0].objects.map((object) => object.id)
    ).toEqual(["3", "4", "2", "5"]);
    expect(
      keepOrderOnly.findings.some(
        (finding) => finding.code === "reading-order-review"
      )
    ).toBe(false);
    const firstRemoval = bundle.changes.find(
      (change) => change.objectId === "4"
    )!;
    const keepOneRemoval = await replayPptxRevisions(source, bundle, [
      order.id,
      firstRemoval.id,
    ]);
    expect(
      keepOneRemoval.inspection.slides[0].objects.map((object) => object.id)
    ).toEqual(["3", "2", "5"]);
    expect(
      (await replayPptxRevisions(source, bundle, [])).buffer.equals(source)
    ).toBe(true);
  });

  it("does not misreport deleting a placeholder as a separate reading-order change", async () => {
    const source = await fixture();
    const inspection = await inspectPptx(source);
    const plan = normalizePptxReadingOrders(
      mergePptxRepairPlans(buildPptxMechanicalPlan(inspection), {
        slides: [{ slideNumber: 1, readingOrder: ["2", "3"] }],
      }),
      inspection
    );
    const { bundle } = await createPptxRevisionBundle(source, plan);
    expect(bundle.changes.map((change) => change.type)).toEqual([
      "empty-placeholder",
      "empty-placeholder",
    ]);
  });

  it("retains deterministic removals when merging semantic or corrective plans", async () => {
    const source = await fixture();
    const mechanical = buildPptxMechanicalPlan(await inspectPptx(source));
    const semantic: PptxRepairPlan = {
      slides: [
        {
          slideNumber: 1,
          removeEmptyPlaceholders: [],
          descriptions: [{ objectId: "3", text: "A tree beside the path." }],
        },
      ],
    };
    const merged = mergePptxRepairPlans(mechanical, semantic);
    expect(merged.slides[0].removeEmptyPlaceholders).toEqual(["4", "5"]);
    const output = await applyPptxRepairs(source, merged, { revisioned: true });
    expect(
      output.inspection.slides[0].objects.map((object) => object.id)
    ).toEqual(["2", "3"]);
  });

  it("rejects a cleaned permutation that omits meaningful content", async () => {
    const source = await fixture();
    const inspection = await inspectPptx(source);
    expect(() =>
      normalizePptxReadingOrders(
        mergePptxRepairPlans(buildPptxMechanicalPlan(inspection), {
          slides: [{ slideNumber: 1, readingOrder: ["2"] }],
        }),
        inspection
      )
    ).toThrow();
  });

  it("keeps a legacy saved description bundle byte-compatible and does not introduce cleanup during replay", async () => {
    const source = await fixture();
    const plan: PptxRepairPlan = {
      slides: [
        {
          slideNumber: 1,
          descriptions: [{ objectId: "3", text: "A tree beside the path." }],
        },
      ],
    };
    const bundle: PptxRevisionBundle = {
      version: 1,
      sourceHash: digest(source),
      plan,
      changes: [
        {
          id: `change-${digest("1:description:3").slice(0, 20)}`,
          type: "description",
          slideNumber: 1,
          objectId: "3",
          label: "Describe the object's information",
          before: "No description",
          after: "A tree beside the path.",
          reason:
            "Added an image description in the object's Alt Text metadata.",
          operationIds: ["1:description:3"],
          editableDescription: true,
        },
      ],
    };
    const kept = await replayPptxRevisions(source, bundle, [
      bundle.changes[0].id,
    ]);
    expect(
      kept.inspection.slides[0].objects.map((object) => object.id)
    ).toEqual(["2", "4", "3", "5"]);
    expect(kept.changes.map((change) => change.type)).toEqual(["description"]);
    expect(
      (await replayPptxRevisions(source, bundle, [])).buffer.equals(source)
    ).toBe(true);
  });
});
