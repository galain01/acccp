import { describe, expect, it } from "vitest";
import { DOMParser } from "@xmldom/xmldom";
import {
  applyPptxRepairs,
  checkPptxAccessibility,
  inspectPptx,
  validatePptxRepairPlan,
} from "../lib/pptx-package";
import { pptxElementHash } from "../lib/pptx-table-caption";
import {
  DECORATIVE,
  DECORATIVE_EXTENSION,
  R,
  imageFixture,
  pictureXml,
  unzipParts,
} from "./pptx-image-fixture";

const rolePlan = (decorative: boolean) => ({
  slides: [
    { slideNumber: 1, decorativeObjects: [{ objectId: "3", decorative }] },
  ],
});
const image = (inspection: Awaited<ReturnType<typeof inspectPptx>>) =>
  inspection.slides[0].objects.find((object) => object.id === "3")!;

describe("native PowerPoint image alternatives", () => {
  it("marks an image decorative without discarding its authored description or any unrelated package part", async () => {
    const source = await imageFixture({
      picture: pictureXml({
        description: "Authored description",
        title: "Authored title",
      }),
      extraParts: [["customXml/provenance.xml", "<author>Instructor</author>"]],
    });
    const repaired = await applyPptxRepairs(source, rolePlan(true), {
      revisioned: true,
    });
    expect(image(repaired.inspection)).toMatchObject({
      decorative: true,
      description: "Authored description",
      title: "Authored title",
    });
    expect(repaired.changes).toEqual([
      expect.objectContaining({
        type: "decorative",
        operationId: "1:decorative:3",
      }),
    ]);
    const before = await unzipParts(source);
    const after = await unzipParts(repaired.buffer);
    for (const [name, bytes] of before)
      if (name !== "ppt/slides/slide1.xml")
        expect(after.get(name)).toEqual(bytes);
    const originalXml = new DOMParser().parseFromString(
      before.get("ppt/slides/slide1.xml")!.toString(),
      "application/xml"
    );
    const repairedXml = new DOMParser().parseFromString(
      after.get("ppt/slides/slide1.xml")!.toString(),
      "application/xml"
    );
    const marker = repairedXml.getElementsByTagNameNS(
      DECORATIVE,
      "decorative"
    )[0];
    expect(marker.getAttribute("val")).toBe("1");
    expect(marker.parentElement?.getAttribute("uri")).toBe(
      DECORATIVE_EXTENSION
    );
    const list = marker.parentNode!.parentNode!;
    list.parentNode!.removeChild(list);
    expect(pptxElementHash(repairedXml.documentElement!)).toBe(
      pptxElementHash(originalXml.documentElement!)
    );
  });

  it("unmarks an informative image before applying its revised description", async () => {
    const source = await imageFixture({
      picture: pictureXml({
        decorative: true,
        description: "Generic picture",
        title: "Chart",
      }),
    });
    const repaired = await applyPptxRepairs(
      source,
      {
        slides: [
          {
            ...rolePlan(false).slides[0],
            descriptions: [
              {
                objectId: "3",
                text: "Participation increased from 12 to 24 students.",
                replaceExisting: true,
              },
            ],
          },
        ],
      },
      { revisioned: true }
    );
    expect(image(repaired.inspection)).toMatchObject({
      decorative: false,
      title: "Chart",
      description: "Participation increased from 12 to 24 students.",
    });
    expect(repaired.changes.map((change) => change.type)).toEqual([
      "decorative",
      "description",
    ]);
    expect(
      repaired.findings.some(
        (finding) => finding.code === "missing-description"
      )
    ).toBe(false);
    expect(image(await inspectPptx(source))).toMatchObject({
      decorative: true,
      description: "Generic picture",
    });
  });

  it("keeps images marked decorative out of missing-description findings", async () => {
    const repaired = await applyPptxRepairs(
      await imageFixture(),
      rolePlan(true),
      { revisioned: true }
    );
    expect(
      checkPptxAccessibility(repaired.inspection).some(
        (finding) => finding.code === "missing-description"
      )
    ).toBe(false);
  });

  it("preserves a stored description when the image is made informative without a wording change", async () => {
    const repaired = await applyPptxRepairs(
      await imageFixture({
        picture: pictureXml({
          decorative: true,
          description: "The red arrow points to the nucleus.",
        }),
      }),
      rolePlan(false),
      { revisioned: true }
    );
    expect(image(repaired.inspection)).toMatchObject({
      decorative: false,
      description: "The red arrow points to the nucleus.",
    });
  });

  it("retains unrelated extension metadata while updating an existing false decorative marker", async () => {
    const metadata = `<a:extLst><a:ext uri="{unrelated}"><sample:setting xmlns:sample="urn:sample" value="keep"/></a:ext><a:ext uri="${DECORATIVE_EXTENSION}"><adec:decorative xmlns:adec="${DECORATIVE}" val="0"/></a:ext></a:extLst>`;
    const repaired = await applyPptxRepairs(
      await imageFixture({ picture: pictureXml({ metadata }) }),
      rolePlan(true),
      { revisioned: true }
    );
    expect(image(repaired.inspection).decorative).toBe(true);
    const xml = new DOMParser().parseFromString(
      (await unzipParts(repaired.buffer))
        .get("ppt/slides/slide1.xml")!
        .toString(),
      "application/xml"
    );
    expect(
      xml
        .getElementsByTagNameNS("urn:sample", "setting")[0]
        .getAttribute("value")
    ).toBe("keep");
    expect(xml.getElementsByTagNameNS(DECORATIVE, "decorative")).toHaveLength(
      1
    );
  });

  it.each(["hlinkClick", "hlinkHover"])(
    "exposes %s targets and rejects hiding functional images from reading software",
    async (trigger) => {
      const source = await imageFixture({
        picture: pictureXml({
          metadata: `<a:${trigger} r:id="rLink" action="ppaction://hlinkfile"/>`,
        }),
        extraRelationships: `<Relationship Id="rLink" Type="${R}/hyperlink" Target="https://example.edu/course" TargetMode="External"/>`,
      });
      const inspection = await inspectPptx(source);
      expect(image(inspection).actions).toEqual([
        {
          trigger: trigger === "hlinkClick" ? "click" : "hover",
          relationshipId: "rLink",
          target: "https://example.edu/course",
          targetKind: "external",
          action: "ppaction://hlinkfile",
        },
      ]);
      const repaired = await applyPptxRepairs(source, rolePlan(true), {
        revisioned: true,
      });
      expect(repaired.buffer).toEqual(source);
      expect(repaired.changes).toEqual([]);
      expect(repaired.findings).toContainEqual(
        expect.objectContaining({ code: "decorative-review", objectId: "3" })
      );
    }
  );

  it("protects native actions without a relationship and permits correcting an incorrectly decorative action image", async () => {
    const source = await imageFixture({
      picture: pictureXml({
        decorative: true,
        metadata:
          '<a:hlinkClick action="ppaction://hlinkshowjump?jump=nextslide"/>',
      }),
    });
    const inspection = await inspectPptx(source);
    expect(image(inspection).actions).toEqual([
      { trigger: "click", action: "ppaction://hlinkshowjump?jump=nextslide" },
    ]);
    expect(checkPptxAccessibility(inspection)).toContainEqual(
      expect.objectContaining({
        code: "interactive-image-decorative",
        severity: "error",
      })
    );
    const repaired = await applyPptxRepairs(
      source,
      {
        slides: [
          {
            ...rolePlan(false).slides[0],
            descriptions: [{ objectId: "3", text: "Go to the next slide." }],
          },
        ],
      },
      { revisioned: true }
    );
    expect(image(repaired.inspection)).toMatchObject({
      decorative: false,
      description: "Go to the next slide.",
      actions: image(inspection).actions,
    });
    expect(
      checkPptxAccessibility(repaired.inspection).some(
        (finding) => finding.code === "interactive-image-decorative"
      )
    ).toBe(false);
  });

  it("resolves internal action destinations as package parts without following them", async () => {
    const source = await imageFixture({
      picture: pictureXml({ metadata: '<a:hlinkClick r:id="rJump"/>' }),
      extraRelationships: `<Relationship Id="rJump" Type="${R}/hyperlink" Target="slide1.xml"/>`,
    });
    expect(image(await inspectPptx(source)).actions).toEqual([
      {
        trigger: "click",
        relationshipId: "rJump",
        target: "ppt/slides/slide1.xml",
        targetKind: "internal",
      },
    ]);
  });

  it.each([
    { name: "hidden", options: { picture: pictureXml({ hidden: true }) } },
    {
      name: "unmeasured",
      options: { picture: pictureXml({ measured: false }) },
    },
    { name: "animated", options: { timing: "<p:timing/>" } },
    {
      name: "linked external",
      options: {
        picture: pictureXml({ linked: true }),
        extraRelationships: `<Relationship Id="rLinked" Type="${R}/image" Target="https://example.edu/picture.png" TargetMode="External"/>`,
      },
    },
    {
      name: "grouped",
      options: {
        picture: `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="4" name="Group"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${pictureXml()}</p:grpSp>`,
      },
    },
  ])(
    "leaves $name image metadata unchanged and records a review finding",
    async ({ options }) => {
      const source = await imageFixture(options);
      const repaired = await applyPptxRepairs(source, rolePlan(true), {
        revisioned: true,
      });
      expect(repaired.buffer).toEqual(source);
      expect(repaired.changes).toEqual([]);
      expect(repaired.findings).toContainEqual(
        expect.objectContaining({ code: "decorative-review", objectId: "3" })
      );
    }
  );

  it("requires revision mode for a changed image role and returns original bytes for no-op choices", async () => {
    const source = await imageFixture();
    expect((await applyPptxRepairs(source, rolePlan(true))).buffer).toEqual(
      source
    );
    expect(
      (await applyPptxRepairs(source, rolePlan(false), { revisioned: true }))
        .changes
    ).toEqual([]);
  });

  it("preserves unrecognized or duplicate decorative extension payloads", async () => {
    for (const metadata of [
      `<a:extLst><a:ext uri="${DECORATIVE_EXTENSION}"><sample:setting xmlns:sample="urn:sample"/></a:ext></a:extLst>`,
      `<a:extLst><a:ext uri="${DECORATIVE_EXTENSION}"><adec:decorative xmlns:adec="${DECORATIVE}" val="0"/><adec:decorative xmlns:adec="${DECORATIVE}" val="0"/></a:ext></a:extLst>`,
    ]) {
      const source = await imageFixture({ picture: pictureXml({ metadata }) });
      const repaired = await applyPptxRepairs(source, rolePlan(true), {
        revisioned: true,
      });
      expect(repaired.buffer).toEqual(source);
      expect(repaired.findings).toContainEqual(
        expect.objectContaining({ code: "decorative-review" })
      );
    }
  });
});

describe("bounded image alternative plan contract", () => {
  it("accepts explicit native roles and language-tagged detailed explanation requests", () => {
    expect(validatePptxRepairPlan(rolePlan(true))).toBe(true);
    expect(
      validatePptxRepairPlan({
        slides: [
          {
            slideNumber: 1,
            longDescriptions: [
              {
                objectId: "3",
                title: "Course participation",
                summary: "Participation increased over the semester.",
                paragraphs: ["January: 12 students. February: 24 students."],
                languageTag: "en-US",
              },
            ],
          },
        ],
      })
    ).toBe(true);
  });
  it.each([
    { decorativeObjects: [{ objectId: "3", decorative: "true" }] },
    {
      decorativeObjects: [
        { objectId: "3", decorative: true, deleteDescription: true },
      ],
    },
    {
      decorativeObjects: [
        { objectId: "3", decorative: true },
        { objectId: "3", decorative: false },
      ],
    },
  ])(
    "rejects malformed or conflicting native roles",
    ({ decorativeObjects }) => {
      expect(
        validatePptxRepairPlan({
          slides: [{ slideNumber: 1, decorativeObjects }],
        })
      ).toBe(false);
    }
  );
  it.each([
    { title: "x".repeat(121) },
    { summary: "x".repeat(301) },
    { paragraphs: [] },
    { paragraphs: ["x".repeat(2001)] },
    { paragraphs: Array.from({ length: 21 }, () => "Explanation.") },
    { paragraphs: Array.from({ length: 4 }, () => "x".repeat(1600)) },
    { languageTag: "en US" },
  ])("rejects oversized or invalid description content", (override) => {
    expect(
      validatePptxRepairPlan({
        slides: [
          {
            slideNumber: 1,
            longDescriptions: [
              {
                objectId: "3",
                title: "Chart",
                summary: "Summary",
                paragraphs: ["Explanation."],
                ...override,
              },
            ],
          },
        ],
      })
    ).toBe(false);
  });
  it.each([
    { descriptions: [{ objectId: "3", text: "Other description." }] },
    { decorativeObjects: [{ objectId: "3", decorative: true }] },
  ])("rejects overlapping alternatives for the same image", (other) => {
    expect(
      validatePptxRepairPlan({
        slides: [
          {
            slideNumber: 1,
            longDescriptions: [
              {
                objectId: "3",
                title: "Chart",
                summary: "Summary",
                paragraphs: ["Explanation."],
              },
            ],
            ...other,
          },
        ],
      })
    ).toBe(false);
  });
});
