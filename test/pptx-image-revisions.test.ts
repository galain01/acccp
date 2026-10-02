import { describe, expect, it } from "vitest";
import { inspectPptx } from "../lib/pptx-package";
import {
  createPptxRevisionBundle,
  mergePptxRepairPlans,
  replayPptxRevisions,
} from "../lib/pptx-revisions";
import type { PptxRepairPlan } from "../lib/pptx-types";
import {
  A,
  P,
  R,
  imageFixture,
  pictureXml,
  unzipParts,
} from "./pptx-image-fixture";

const slidePlan = (
  repair: Omit<PptxRepairPlan["slides"][number], "slideNumber">
): PptxRepairPlan => ({
  slides: [{ slideNumber: 1, ...repair }],
});
const image = (inspection: Awaited<ReturnType<typeof inspectPptx>>, id = "3") =>
  inspection.slides[0].objects.find((object) => object.id === id)!;
const longDescription = (objectId = "3") => ({
  objectId,
  title: "Enrollment chart",
  summary: "Enrollment increased from 10 students to 20 students.",
  paragraphs: [
    "The horizontal axis shows 2024 and 2025. The vertical axis shows student enrollment.",
    "Enrollment was 10 in 2024 and 20 in 2025, an increase of 10 students.",
  ],
});
const withLayout = (
  picture = pictureXml({ description: "Original chart description" })
) =>
  imageFixture({
    picture,
    extraRelationships: `<Relationship Id="rLayout" Type="${R}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>`,
    extraParts: [
      [
        "ppt/slideLayouts/slideLayout1.xml",
        `<p:sldLayout xmlns:p="${P}" xmlns:a="${A}" type="blank"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld></p:sldLayout>`,
      ],
    ],
  });

describe("image-alternative revision replay", () => {
  it("records the actual decorative flag while preserving existing descriptions and all other parts", async () => {
    const source = await imageFixture({
      picture: pictureXml({
        description: "Blue background accent",
        title: "Authored title",
      }),
    });
    const plan = slidePlan({
      decorativeObjects: [{ objectId: "3", decorative: true }],
      revisionNotes: [
        {
          type: "decorative",
          objectId: "3",
          reason: "The image adds visual decoration only.",
          assumption: "Its color is unrelated to the lesson's categories.",
        },
      ],
    });
    const { result, bundle } = await createPptxRevisionBundle(source, plan);
    expect(image(result.inspection)).toMatchObject({
      decorative: true,
      description: "Blue background accent",
      title: "Authored title",
    });
    expect(bundle.changes).toEqual([
      expect.objectContaining({
        type: "decorative",
        before: "Included for screen readers",
        after: "Skipped by screen readers (decorative image)",
        reason: plan.slides[0].revisionNotes![0].reason,
        assumption: plan.slides[0].revisionNotes![0].assumption,
        operationIds: ["1:decorative:3"],
      }),
    ]);
    expect(bundle.changes[0].editableDescription).toBeUndefined();
    const replay = await replayPptxRevisions(source, bundle, [
      bundle.changes[0].id,
    ]);
    expect(image(replay.inspection).decorative).toBe(true);
    expect(
      (await replayPptxRevisions(source, bundle, [])).buffer.equals(source)
    ).toBe(true);
    const originalParts = await unzipParts(source);
    const outputParts = await unzipParts(result.buffer);
    for (const [name, bytes] of originalParts) {
      if (name !== "ppt/slides/slide1.xml")
        expect(outputParts.get(name)).toEqual(bytes);
    }
  });

  it("keeps making an image informative and adding its description in one editable review choice", async () => {
    const source = await imageFixture({
      picture: pictureXml({
        decorative: true,
        description: "Original wording",
      }),
    });
    const plan = slidePlan({
      decorativeObjects: [{ objectId: "3", decorative: false }],
      descriptions: [
        {
          objectId: "3",
          text: "The chart shows enrollment doubling.",
          replaceExisting: true,
        },
      ],
      revisionNotes: [
        {
          type: "decorative",
          objectId: "3",
          reason: "Students need the comparison shown in this chart.",
        },
        {
          type: "description",
          objectId: "3",
          reason: "Explain the chart's visible result.",
          assumption: "The bar labels represent student counts.",
        },
      ],
    });
    const { result, bundle } = await createPptxRevisionBundle(source, plan);
    expect(image(result.inspection)).toMatchObject({
      decorative: false,
      description: "The chart shows enrollment doubling.",
    });
    expect(bundle.changes).toHaveLength(1);
    const revision = bundle.changes[0];
    expect(revision).toMatchObject({
      type: "decorative",
      editableDescription: true,
      descriptionBefore: "Original wording",
      descriptionAfter: "The chart shows enrollment doubling.",
      operationIds: ["1:decorative:3", "1:description:3"],
    });
    expect(revision.before).toContain("Skipped by screen readers");
    expect(revision.before).toContain("Original wording");
    expect(revision.after).toContain("Included for screen readers");
    expect(revision.after).toContain("The chart shows enrollment doubling.");
    expect(revision.reason).toContain("Students need the comparison");
    expect(revision.reason).toContain("Explain the chart");
    const frozen = JSON.stringify(bundle);
    const selected = await replayPptxRevisions(source, bundle, [revision.id], {
      [revision.id]: "Enrollment rose from 10 to 20 students.",
    });
    expect(image(selected.inspection)).toMatchObject({
      decorative: false,
      description: "Enrollment rose from 10 to 20 students.",
    });
    expect(JSON.stringify(bundle)).toBe(frozen);
    expect(
      (await replayPptxRevisions(source, bundle, [])).buffer.equals(source)
    ).toBe(true);
    await expect(
      replayPptxRevisions(source, bundle, [], {
        [revision.id]: "Unselected replacement",
      })
    ).rejects.toHaveProperty("code", "pptx_integrity");
  });

  it("keeps unrelated image repairs independently reversible", async () => {
    const source = await imageFixture({
      picture: pictureXml({ id: 3, decorative: true }) + pictureXml({ id: 4 }),
    });
    const { bundle } = await createPptxRevisionBundle(
      source,
      slidePlan({
        decorativeObjects: [{ objectId: "3", decorative: false }],
        descriptions: [
          { objectId: "3", text: "Enrollment doubled." },
          { objectId: "4", text: "An oak tree beside a path." },
        ],
      })
    );
    expect(bundle.changes).toHaveLength(2);
    const ordinary = bundle.changes.find((change) => change.objectId === "4")!;
    expect(ordinary.type).toBe("description");
    expect(ordinary).not.toHaveProperty("descriptionAfter");
    const selected = await replayPptxRevisions(source, bundle, [ordinary.id]);
    expect(image(selected.inspection, "3")).toMatchObject({
      decorative: true,
      description: "",
    });
    expect(image(selected.inspection, "4").description).toBe(
      "An oak tree beside a path."
    );
  });

  it("does not create a measured revision for an already matching native flag", async () => {
    const source = await imageFixture({
      picture: pictureXml({ decorative: true }),
    });
    const { result, bundle } = await createPptxRevisionBundle(
      source,
      slidePlan({ decorativeObjects: [{ objectId: "3", decorative: true }] })
    );
    expect(bundle.changes).toEqual([]);
    expect(result.buffer.equals(source)).toBe(true);
  });

  it("merges a corrected flag against the original without retaining a cancelled change", async () => {
    const source = await imageFixture();
    const merged = mergePptxRepairPlans(
      slidePlan({ decorativeObjects: [{ objectId: "3", decorative: true }] }),
      slidePlan({
        decorativeObjects: [{ objectId: "3", decorative: false }],
        descriptions: [{ objectId: "3", text: "Information students need." }],
      })
    );
    expect(merged.slides[0].decorativeObjects).toEqual([
      { objectId: "3", decorative: false },
    ]);
    const { bundle, result } = await createPptxRevisionBundle(source, merged);
    expect(bundle.changes.map((change) => change.type)).toEqual([
      "description",
    ]);
    expect(image(result.inspection)).toMatchObject({
      decorative: false,
      description: "Information students need.",
    });
  });

  it("rejects a modified role ledger instead of trusting browser-provided wording", async () => {
    const source = await imageFixture();
    const { bundle } = await createPptxRevisionBundle(
      source,
      slidePlan({ decorativeObjects: [{ objectId: "3", decorative: true }] })
    );
    bundle.changes[0].after = "Kept informative";
    await expect(
      replayPptxRevisions(source, bundle, [bundle.changes[0].id])
    ).rejects.toHaveProperty("code", "pptx_integrity");
  });
});

describe("added description-slide revision replay", () => {
  it("records actual added text and the short alternative as one reversible change", async () => {
    const source = await withLayout();
    const { result, bundle } = await createPptxRevisionBundle(
      source,
      slidePlan({ longDescriptions: [longDescription()] })
    );
    expect(result.inspection.slideCount).toBe(2);
    expect(bundle.changes).toHaveLength(1);
    const revision = bundle.changes[0];
    expect(revision).toMatchObject({
      type: "long-description",
      before: "Original chart description",
      generatedSlideNumbers: [2],
      operationIds: ["1:long-description:3"],
    });
    expect(revision.after).toContain(image(result.inspection).description);
    expect(revision.after).toContain("Added description slide 2");
    const actualText = result.inspection.slides[1].objects
      .map((object) => object.text)
      .join(" ");
    expect(actualText).toContain("Enrollment chart");
    expect(actualText.replace(/\s+/g, " ")).toContain(
      "Enrollment was 10 in 2024 and 20 in 2025"
    );
    expect(revision.after.replace(/\s+/g, " ")).toContain(
      "Enrollment was 10 in 2024 and 20 in 2025"
    );
    expect(revision.editableDescription).toBeUndefined();
    expect(
      (await replayPptxRevisions(source, bundle, [])).buffer.equals(source)
    ).toBe(true);
    const replay = await replayPptxRevisions(source, bundle, [revision.id]);
    expect(replay.inspection).toEqual(result.inspection);
    expect(
      (await unzipParts(replay.buffer)).get("ppt/slides/slide1.xml")
    ).toEqual((await unzipParts(result.buffer)).get("ppt/slides/slide1.xml"));
    await expect(
      replayPptxRevisions(source, bundle, [revision.id], {
        [revision.id]: "Untracked replacement",
      })
    ).rejects.toHaveProperty("code", "pptx_integrity");
  });

  it("renumbers retained added slides and their source references when an earlier description is restored", async () => {
    const source = await withLayout(
      pictureXml({ id: 3, description: "First chart" }) +
        pictureXml({ id: 4, description: "Second chart" })
    );
    const { bundle, result } = await createPptxRevisionBundle(
      source,
      slidePlan({
        longDescriptions: [
          longDescription("3"),
          { ...longDescription("4"), title: "Second enrollment chart" },
        ],
      })
    );
    expect(result.inspection.slideCount).toBe(3);
    const second = bundle.changes.find((change) => change.objectId === "4")!;
    expect(second.generatedSlideNumbers).toEqual([3]);
    const selected = await replayPptxRevisions(source, bundle, [second.id]);
    expect(selected.inspection.slideCount).toBe(2);
    expect(image(selected.inspection, "3").description).toBe("First chart");
    expect(image(selected.inspection, "4").description).toContain("slide 2.");
    expect(image(selected.inspection, "4").description).not.toContain(
      "slide 3."
    );
    expect(selected.changes[0].generatedSlideNumbers).toEqual([2]);
    expect(
      selected.inspection.slides[1].objects
        .map((object) => object.text)
        .join(" ")
    ).toContain("Second enrollment chart");
  });

  it("merges full-description replacements by source object and measures only the final text", async () => {
    const source = await withLayout();
    const merged = mergePptxRepairPlans(
      slidePlan({ longDescriptions: [longDescription()] }),
      slidePlan({
        longDescriptions: [
          {
            ...longDescription(),
            paragraphs: ["Enrollment increased by ten students."],
          },
        ],
      })
    );
    expect(merged.slides[0].longDescriptions).toHaveLength(1);
    const { bundle } = await createPptxRevisionBundle(source, merged);
    expect(bundle.changes[0].after).toContain(
      "Enrollment increased by ten students."
    );
    expect(bundle.changes[0].after).not.toContain("horizontal axis");
  });

  it("does not invent a revision when the engine cannot add the requested slide", async () => {
    const source = await imageFixture();
    const { bundle, result } = await createPptxRevisionBundle(
      source,
      slidePlan({ longDescriptions: [longDescription()] })
    );
    expect(bundle.changes).toEqual([]);
    expect(
      result.findings.some(
        (finding) => finding.code === "long-description-review"
      )
    ).toBe(true);
    expect(result.inspection.slideCount).toBe(1);
    expect(
      (await replayPptxRevisions(source, bundle, [])).buffer.equals(source)
    ).toBe(true);
  });

  it("rejects tampered generated slide identities before export", async () => {
    const source = await withLayout();
    const { bundle } = await createPptxRevisionBundle(
      source,
      slidePlan({ longDescriptions: [longDescription()] })
    );
    bundle.changes[0].generatedSlideNumbers = [3];
    await expect(
      replayPptxRevisions(source, bundle, [bundle.changes[0].id])
    ).rejects.toHaveProperty("code", "pptx_integrity");
  });
});
