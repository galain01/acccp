import path from "node:path";
import { DOMParser, type Document, type Element } from "@xmldom/xmldom";
import { describe, expect, it } from "vitest";
import { applyPptxRepairs, inspectPptx } from "../lib/pptx-package";
import { pptxElementHash } from "../lib/pptx-table-caption";
import type { PptxRepairPlan, PptxSlideRepairs } from "../lib/pptx-types";
import {
  A,
  P,
  R,
  REL,
  imageFixture,
  pictureXml,
  unzipParts,
  zipParts,
} from "./pptx-image-fixture";

const CT = "http://schemas.openxmlformats.org/package/2006/content-types";
const DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
type Explanation = NonNullable<PptxSlideRepairs["longDescriptions"]>[number];
const explanation = (override: Partial<Explanation> = {}): Explanation => ({
  objectId: "3",
  title: "Course enrollment",
  summary: "Enrollment increased between 2024 and 2025.",
  paragraphs: [
    "In 2024, 120 students enrolled. In 2025, 150 students enrolled: an increase of 30 students, or 25%.",
  ],
  ...override,
});
const plan = (item = explanation()): PptxRepairPlan => ({
  slides: [{ slideNumber: 1, longDescriptions: [item] }],
});
const elements = (document: Document | Element, ns: string, name: string) =>
  Array.from(document.getElementsByTagNameNS(ns, name));
const parse = (bytes: Buffer) =>
  new DOMParser({
    onError: (message) => {
      throw new Error(String(message));
    },
  }).parseFromString(bytes.toString("utf8"), "application/xml");
const words = (value: string) => value.trim().split(/\s+/u);

async function fixture(
  options: { declaration?: boolean; hidden?: boolean } = {}
): Promise<Buffer> {
  const parts = await unzipParts(
    await imageFixture({
      picture: pictureXml({
        description: "Original chart description",
        title: "Authored chart title",
      }),
      extraRelationships: `<Relationship Id="rLayout" Type="${R}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rNotes" Type="${R}/notesSlide" Target="../notesSlides/notesSlide1.xml"/>`,
      extraParts: [
        [
          "ppt/slideLayouts/slideLayout1.xml",
          `<p:sldLayout xmlns:p="${P}" xmlns:a="${A}"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld></p:sldLayout>`,
        ],
        [
          "ppt/notesSlides/notesSlide1.xml",
          `<p:notes xmlns:p="${P}" xmlns:a="${A}"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Keep these authored notes: 31 students &amp; 2 instructors.</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>`,
        ],
      ],
    })
  );
  const types = parts
    .get("[Content_Types].xml")!
    .toString("utf8")
    .replace(
      "</Types>",
      '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/notesSlides/notesSlide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/></Types>'
    );
  parts.set("[Content_Types].xml", Buffer.from(types));
  if (options.hidden)
    parts.set(
      "ppt/slides/slide1.xml",
      Buffer.from(
        parts
          .get("ppt/slides/slide1.xml")!
          .toString("utf8")
          .replace("<p:sld ", '<p:sld show="0" ')
      )
    );
  if (options.declaration)
    for (const [name, bytes] of parts)
      if (name.endsWith(".xml") || name.endsWith(".rels"))
        parts.set(name, Buffer.concat([Buffer.from(DECLARATION), bytes]));
  return zipParts([...parts]);
}

describe("editable PowerPoint description slides", () => {
  it("preserves every explanation word and source object while adding native, titled text in reading order", async () => {
    const source = await fixture();
    const item = explanation({
      paragraphs: [
        "In 2024, 120 students enrolled. In 2025, 150 students enrolled: an increase of 30 students, or 25%.",
        "The final category is unknown; no missing value has been inferred.",
      ],
    });
    const result = await applyPptxRepairs(source, plan(item), {
      revisioned: true,
    });
    expect(result.changes).toEqual([
      expect.objectContaining({
        type: "long-description",
        slideNumber: 1,
        objectId: "3",
        generatedSlideNumbers: [2],
      }),
    ]);
    const added = result.inspection.slides[1];
    expect(
      added.objects.map(({ id, kind, isTitle }) => ({ id, kind, isTitle }))
    ).toEqual([
      { id: "2", kind: "text", isTitle: true },
      { id: "3", kind: "text", isTitle: false },
    ]);
    expect(words(added.objects[0].text)).toEqual(
      words("Description of slide 1: Course enrollment")
    );
    expect(words(added.objects[1].text)).toEqual(
      words(item.paragraphs.join(" "))
    );
    expect(
      result.inspection.slides[0].objects.find((object) => object.id === "3")
    ).toMatchObject({
      title: "Authored chart title",
      description: `${item.summary} Detailed description on slide 2.`,
    });

    const originalParts = await unzipParts(source);
    const outputParts = await unzipParts(result.buffer);
    const allowedChanges = new Set([
      "[Content_Types].xml",
      "ppt/presentation.xml",
      "ppt/_rels/presentation.xml.rels",
      "ppt/slides/slide1.xml",
    ]);
    for (const [name, bytes] of originalParts)
      if (!allowedChanges.has(name))
        expect(outputParts.get(name), name).toEqual(bytes);
    const before = parse(originalParts.get("ppt/slides/slide1.xml")!);
    const after = parse(outputParts.get("ppt/slides/slide1.xml")!);
    elements(after, P, "cNvPr")
      .find((element) => element.getAttribute("id") === "3")!
      .setAttribute("descr", "Original chart description");
    expect(pptxElementHash(after.documentElement!)).toBe(
      pptxElementHash(before.documentElement!)
    );

    const generatedXml = parse(outputParts.get(added.partName)!);
    expect(elements(generatedXml, P, "pic")).toHaveLength(0);
    expect(elements(generatedXml, A, "blip")).toHaveLength(0);
    expect(elements(generatedXml, P, "txBody")).toHaveLength(2);
    expect(
      [...outputParts.keys()].filter((name) => name.startsWith("ppt/media/"))
    ).toEqual(["ppt/media/image1.png"]);
    const relationshipsName = path.posix.join(
      path.posix.dirname(added.partName),
      "_rels",
      `${path.posix.basename(added.partName)}.rels`
    );
    const relationships = elements(
      parse(outputParts.get(relationshipsName)!),
      REL,
      "Relationship"
    );
    expect(relationships).toHaveLength(1);
    expect(relationships[0].getAttribute("Type")).toBe(`${R}/slideLayout`);
    expect(relationships[0].getAttribute("TargetMode")).not.toBe("External");
    const layout = path.posix.normalize(
      path.posix.join(
        path.posix.dirname(added.partName),
        relationships[0].getAttribute("Target")!
      )
    );
    expect(outputParts.get(layout)).toEqual(
      originalParts.get("ppt/slideLayouts/slideLayout1.xml")
    );
    expect(
      elements(
        parse(outputParts.get("[Content_Types].xml")!),
        CT,
        "Override"
      ).some((node) => node.getAttribute("PartName") === `/${added.partName}`)
    ).toBe(true);
  });

  it("paginates a long paragraph without losing numbers, shrinking text, or reversing reading order", async () => {
    const paragraph = Array.from(
      { length: 36 },
      (_, index) =>
        `Group ${index + 1} recorded ${120 + index} students in 2025.`
    ).join(" ");
    expect(paragraph.length).toBeLessThanOrEqual(2000);
    const result = await applyPptxRepairs(
      await fixture(),
      plan(explanation({ paragraphs: [paragraph] })),
      { revisioned: true }
    );
    const added = result.inspection.slides.slice(1);
    expect(added.length).toBeGreaterThan(1);
    expect(added.length).toBeLessThanOrEqual(8);
    expect(
      words(added.map((slide) => slide.objects[1].text).join(" "))
    ).toEqual(words(paragraph));
    expect(result.changes[0].generatedSlideNumbers).toEqual(
      added.map((slide) => slide.slideNumber)
    );
    expect(result.inspection.slides[0].objects[1].description).toContain(
      `Detailed description on slides 2–${added.length + 1}.`
    );
    const parts = await unzipParts(result.buffer);
    for (const [index, slide] of added.entries()) {
      expect(words(slide.objects[0].text).join(" ")).toBe(
        `Description of slide 1: Course enrollment (${index + 1} of ${added.length})`
      );
      expect(slide.objects[0].isTitle).toBe(true);
      const document = parse(parts.get(slide.partName)!);
      const body = elements(document, P, "sp")[1];
      const runs = elements(body, A, "rPr");
      expect(runs.length).toBeGreaterThan(0);
      expect(runs.every((run) => run.getAttribute("sz") === "2200")).toBe(true);
      expect(elements(body, A, "normAutofit")).toHaveLength(0);
      expect(elements(body, A, "noAutofit")).toHaveLength(1);
      const rect = slide.objects[1].rect!;
      const occupiedHeight = elements(body, A, "p").length * 22 * 1.3 * 12700;
      expect(occupiedHeight).toBeLessThanOrEqual(rect.height);
      expect(rect.y + rect.height).toBeLessThan(result.inspection.height);
    }
  });

  it("keeps continuation identifiers and unique accessible titles when a long label must be shortened", async () => {
    const paragraph = Array.from(
      { length: 36 },
      (_, index) =>
        `Group ${index + 1} recorded ${120 + index} students in 2025.`
    ).join(" ");
    const result = await applyPptxRepairs(
      await fixture(),
      plan(explanation({ title: "W".repeat(120), paragraphs: [paragraph] })),
      { revisioned: true }
    );
    const added = result.inspection.slides.slice(1);
    expect(added.length).toBeGreaterThan(1);
    const titles = added.map((slide) => words(slide.objects[0].text).join(" "));
    expect(new Set(titles).size).toBe(added.length);
    expect(
      result.findings.some((finding) => finding.code === "duplicate-title")
    ).toBe(false);
    const parts = await unzipParts(result.buffer);
    for (const [index, slide] of added.entries()) {
      expect(titles[index]).toContain("…");
      expect(titles[index]).toMatch(
        new RegExp(`\\(${index + 1} of ${added.length}\\)$`)
      );
      expect(slide.objects[0].isTitle).toBe(true);
      const titleShape = elements(
        parse(parts.get(slide.partName)!),
        P,
        "sp"
      )[0];
      const occupiedHeight =
        elements(titleShape, A, "p").length * 24 * 1.3 * 12700;
      expect(occupiedHeight).toBeLessThanOrEqual(slide.objects[0].rect!.height);
    }
    expect(
      words(added.map((slide) => slide.objects[1].text).join(" "))
    ).toEqual(words(paragraph));
  });

  it("escapes markup-shaped text and XML entities without changing their literal meaning", async () => {
    const item = explanation({
      title: 'Cost < limit & "review"',
      summary: 'A & B compare "cost" < $50.',
      paragraphs: [
        'Example: <script>alert("x")</script> is literal text. A & B cost $12.50; 3 < 5 and 8 > 4.',
        "Keep &amp; as authored, the student's 25%, and the value −2.5 unchanged.",
      ],
    });
    const result = await applyPptxRepairs(await fixture(), plan(item), {
      revisioned: true,
    });
    expect(words(result.inspection.slides[1].objects[1].text)).toEqual(
      words(item.paragraphs.join(" "))
    );
    expect(result.inspection.slides[0].objects[1].description).toBe(
      `${item.summary} Detailed description on slide 2.`
    );
    const parts = await unzipParts(result.buffer);
    const raw = parts
      .get(result.inspection.slides[1].partName)!
      .toString("utf8");
    const document = parse(Buffer.from(raw));
    expect(document.getElementsByTagName("script")).toHaveLength(0);
    expect(elements(document, P, "cSld")[0].getAttribute("name")).toBe(
      `Description of slide 1: ${item.title}`
    );
    expect(raw).toContain("&lt;script&gt;");
    expect(raw).toContain("&amp;amp;");
  });

  it("accepts normal PowerPoint XML declarations and writes each declaration only once", async () => {
    const source = await fixture({ declaration: true });
    const result = await applyPptxRepairs(source, plan(), { revisioned: true });
    expect((await inspectPptx(result.buffer)).slideCount).toBe(2);
    for (const [name, bytes] of await unzipParts(result.buffer)) {
      if (!name.endsWith(".xml") && !name.endsWith(".rels")) continue;
      const xml = bytes.toString("utf8");
      expect(xml.startsWith(DECLARATION), name).toBe(true);
      expect(xml.match(/<\?xml\b/g), name).toHaveLength(1);
      expect(() => parse(bytes), name).not.toThrow();
    }
  });

  it("does not expose an image on a hidden source slide by appending a visible explanation", async () => {
    const source = await fixture({ hidden: true });
    const result = await applyPptxRepairs(source, plan(), { revisioned: true });
    expect(result.buffer.equals(source)).toBe(true);
    expect(result.changes).toEqual([]);
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        code: "long-description-review",
        slideNumber: 1,
        objectId: "3",
      })
    );
  });

  it.each([
    ["an unbreakable value", ["W".repeat(250)]],
    [
      "more than eight explanation slides",
      Array.from({ length: 3 }, () =>
        Array.from({ length: 95 }, () => "WWWWWWWWWWWWWWWWWW").join(" ")
      ),
    ],
  ])(
    "preserves the complete source and flags %s instead of truncating it",
    async (_label, paragraphs) => {
      const source = await fixture();
      const result = await applyPptxRepairs(
        source,
        plan(explanation({ paragraphs })),
        { revisioned: true }
      );
      expect(result.buffer.equals(source)).toBe(true);
      expect(result.changes).toEqual([]);
      expect(result.inspection.slideCount).toBe(1);
      expect(result.findings).toContainEqual(
        expect.objectContaining({ code: "long-description-review" })
      );
    }
  );
});
