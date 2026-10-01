import { describe, expect, it } from "vitest";
import { ZipFile } from "yazl";
import { fromBufferPromise } from "yauzl";
import { DOMParser } from "@xmldom/xmldom";
import { pptxElementHash } from "../lib/pptx-table-caption";
import {
  buildPptxMechanicalPlan,
  createPptxRevisionBundle,
  mergePptxRepairPlans,
  replayPptxRevisions,
} from "../lib/pptx-revisions";
import type { PptxRepairPlan } from "../lib/pptx-types";
import {
  applyPptxRepairs,
  checkPptxAccessibility,
  inspectPptx,
  validatePptxRepairPlan,
} from "../lib/pptx-package";

const P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const CT = "http://schemas.openxmlformats.org/package/2006/content-types";

describe("reviewable PowerPoint revisions", () => {
  it("replaces authored descriptions explicitly, records actual values, and restores the exact source", async () => {
    const source = await zip(
      entries(
        slide(text(2, "Course overview") + image(3, 'descr="Grading rubric"'))
      )
    );
    const plan: PptxRepairPlan = {
      slides: [
        {
          slideNumber: 1,
          descriptions: [
            {
              objectId: "3",
              text: "Homework 15%; exams 50%; projects 35%.",
              replaceExisting: true,
            },
          ],
          revisionNotes: [
            {
              type: "description",
              objectId: "3",
              reason: "Explain the grading information shown in the diagram.",
              assumption: "The visible categories describe the course grade.",
            },
          ],
        },
      ],
    };
    const { result, bundle } = await createPptxRevisionBundle(source, plan);
    expect(result.inspection.slides[0].objects[1].description).toBe(
      plan.slides[0].descriptions![0].text
    );
    expect(bundle.changes).toHaveLength(1);
    expect(bundle.changes[0]).toMatchObject({
      before: "Grading rubric",
      after: plan.slides[0].descriptions![0].text,
      editableDescription: true,
      assumption: "The visible categories describe the course grade.",
    });
    const restored = await replayPptxRevisions(source, bundle, []);
    expect(restored.buffer.equals(source)).toBe(true);
    const selected = await replayPptxRevisions(source, bundle, [
      bundle.changes[0].id,
    ]);
    expect((await unzip(selected.buffer)).get("ppt/slides/slide1.xml")).toEqual(
      (await unzip(result.buffer)).get("ppt/slides/slide1.xml")
    );
    const before = await unzip(source);
    const after = await unzip(result.buffer);
    for (const [name, bytes] of before)
      if (name !== "ppt/slides/slide1.xml")
        expect(after.get(name)).toEqual(bytes);
  });

  it("keeps approved wording edits independent of the immutable proposal and rejects invalid edits", async () => {
    const source = await zip(entries());
    const { bundle } = await createPptxRevisionBundle(source, {
      slides: [
        {
          slideNumber: 1,
          descriptions: [{ objectId: "3", text: "A tree in a meadow." }],
        },
      ],
    });
    const id = bundle.changes[0].id;
    const saved = JSON.stringify(bundle);
    const revised = await replayPptxRevisions(source, bundle, [id], {
      [id]: "An oak tree beside the path.",
    });
    expect(revised.inspection.slides[0].objects[1].description).toBe(
      "An oak tree beside the path."
    );
    expect(JSON.stringify(bundle)).toBe(saved);
    expect(
      (await replayPptxRevisions(source, bundle, [id])).inspection.slides[0]
        .objects[1].description
    ).toBe("A tree in a meadow.");
    await expect(
      replayPptxRevisions(source, bundle, [], { [id]: "Hidden edit" })
    ).rejects.toHaveProperty("code", "pptx_integrity");
    await expect(
      replayPptxRevisions(source, bundle, [id], { [id]: "\u0000" })
    ).rejects.toHaveProperty("code", "pptx_integrity");
  });

  it("sets only an exact French passage across runs, keeping English and all wording", async () => {
    const object = text(
      2,
      "English before. Ce programme est disponible en français. English after."
    ).replace(
      "Ce programme est disponible",
      'Ce programme</a:t></a:r><a:r><a:rPr lang="en-US" b="1"/><a:t> est disponible'
    );
    const source = await zip(entries(slide(object + image(3))));
    const { result, bundle } = await createPptxRevisionBundle(source, {
      slides: [
        {
          slideNumber: 1,
          textLanguages: [
            {
              objectId: "2",
              sourceText: "Ce programme est disponible en français.",
              tag: "fr-FR",
            },
          ],
        },
      ],
    });
    const output = result.inspection.slides[0].objects[0];
    expect(output.text).toBe(
      "English before. Ce programme est disponible en français. English after."
    );
    expect(
      output.textRuns?.map(({ text, language }) => ({ text, language }))
    ).toEqual([
      { text: "English before. ", language: "en-US" },
      { text: "Ce programme", language: "fr-FR" },
      { text: " est disponible en français.", language: "fr-FR" },
      { text: " English after.", language: "en-US" },
    ]);
    expect(bundle.changes[0].after).toContain(
      "fr-FR: Ce programme est disponible en français."
    );
    expect(
      (await replayPptxRevisions(source, bundle, [])).buffer.equals(source)
    ).toBe(true);
  });

  it("does not guess which repeated passage should receive a language", async () => {
    const source = await zip(entries(slide(text(2, "Bonjour. Bonjour."))));
    const { result, bundle } = await createPptxRevisionBundle(source, {
      slides: [
        {
          slideNumber: 1,
          textLanguages: [
            { objectId: "2", sourceText: "Bonjour.", tag: "fr-FR" },
          ],
        },
      ],
    });
    expect(result.buffer.equals(source)).toBe(true);
    expect(bundle.changes).toEqual([]);
    expect(
      result.findings.some((item) => item.code === "language-review")
    ).toBe(true);
  });

  it("permits reviewed reading-order edits with unknown geometry and keeps language independently reversible", async () => {
    const source = await zip(
      entries(
        slide(
          text(2, "Bonjour.")
            .replace(/<a:xfrm>.*?<\/a:xfrm>/, "")
            .replace(
              '<a:rPr lang="en-US"/>',
              '<a:rPr lang="en-US"><a:effectLst/></a:rPr>'
            ) + text(3, "Objectives")
        )
      )
    );
    const { result, bundle } = await createPptxRevisionBundle(source, {
      slides: [
        {
          slideNumber: 1,
          textLanguages: [
            { objectId: "2", sourceText: "Bonjour.", tag: "fr-FR" },
          ],
          readingOrder: ["3", "2"],
        },
      ],
    });
    expect(result.inspection.slides[0].objects.map((item) => item.id)).toEqual([
      "3",
      "2",
    ]);
    const order = bundle.changes.find(
      (change) => change.type === "reading-order"
    )!;
    const selected = await replayPptxRevisions(source, bundle, [order.id]);
    expect(
      selected.inspection.slides[0].objects.map((item) => item.id)
    ).toEqual(["3", "2"]);
    expect(selected.inspection.slides[0].objects[1].language).toBe("en-US");
  });

  it("retains animation protection even when revisions are enabled", async () => {
    const source = await zip(
      entries(slide(text(2, "First") + text(3, "Second"), "", "<p:timing/>"))
    );
    const { result, bundle } = await createPptxRevisionBundle(source, {
      slides: [{ slideNumber: 1, readingOrder: ["3", "2"] }],
    });
    expect(bundle.changes).toEqual([]);
    expect(
      result.findings.some((item) => item.code === "reading-order-review")
    ).toBe(true);
  });

  it("updates a hyperlink label while preserving its exact target and unrelated text", async () => {
    const parts = entries(
      slide(
        text(2, "https://example.edu/course").replace(
          '<a:rPr lang="en-US"/>',
          '<a:rPr lang="en-US"><a:hlinkClick r:id="rLink"/></a:rPr>'
        ) + text(3, "Chapter 5 — 20%")
      )
    );
    parts[5][1] = String(parts[5][1]).replace(
      "</Relationships>",
      `<Relationship Id="rLink" Type="${R}/hyperlink" Target="https://example.edu/course" TargetMode="External"/></Relationships>`
    );
    const source = await zip(parts);
    const { result, bundle } = await createPptxRevisionBundle(source, {
      slides: [
        {
          slideNumber: 1,
          linkTexts: [
            {
              objectId: "2",
              sourceText: "https://example.edu/course",
              text: "Course materials",
            },
          ],
        },
      ],
    });
    expect(
      result.inspection.slides[0].objects.map((object) => object.text)
    ).toEqual(["Course materials", "Chapter 5 — 20%"]);
    expect(
      (await unzip(result.buffer)).get("ppt/slides/_rels/slide1.xml.rels")
    ).toEqual((await unzip(source)).get("ppt/slides/_rels/slide1.xml.rels"));
    expect(bundle.changes[0]).toMatchObject({
      type: "link-text",
      before: "https://example.edu/course",
      after: "Course materials",
    });
  });

  it("changes text size and color, preserving the exact language, other runs, and wording", async () => {
    const source = await zip(
      entries(slide(text(2, "Introduction and conclusion")))
    );
    const { result, bundle } = await createPptxRevisionBundle(source, {
      slides: [
        {
          slideNumber: 1,
          textStyles: [
            {
              objectId: "2",
              sourceText: "Introduction",
              fontSizePt: 24,
              colorHex: "123abc",
            },
          ],
        },
      ],
    });
    expect(result.inspection.slides[0].objects[0].textRuns).toEqual([
      {
        text: "Introduction",
        language: "en-US",
        fontSizePt: 24,
        colorHex: "123ABC",
      },
      { text: " and conclusion", language: "en-US" },
    ]);
    expect(bundle.changes[0].type).toBe("text-style");
    expect(
      (await replayPptxRevisions(source, bundle, [])).buffer.equals(source)
    ).toBe(true);
  });

  it("moves/resizes an object using exact bounds and rejects off-slide destinations", async () => {
    const source = await zip(entries(slide(text(2, "Course overview"))));
    const original = { x: 0, y: 2000, width: 1000, height: 500 };
    const plan: PptxRepairPlan = {
      slides: [
        {
          slideNumber: 1,
          objectBounds: [
            {
              objectId: "2",
              sourceRect: original,
              rect: { x: 100, y: 200, width: 2000, height: 1000 },
            },
          ],
        },
      ],
    };
    const { result, bundle } = await createPptxRevisionBundle(source, plan);
    expect(result.inspection.slides[0].objects[0].rect).toEqual(
      plan.slides[0].objectBounds![0].rect
    );
    expect(bundle.changes[0].type).toBe("position");
    plan.slides[0].objectBounds![0].rect.x = 9144000;
    const rejected = await createPptxRevisionBundle(source, plan);
    expect(rejected.result.buffer.equals(source)).toBe(true);
    expect(rejected.bundle.changes).toEqual([]);
  });

  it.each([
    "wrong source",
    "changed plan",
    "forged ledger",
    "unknown selection",
    "duplicate selection",
  ])("rejects %s when replaying", async (scenario) => {
    const source = await zip(entries());
    const { bundle } = await createPptxRevisionBundle(source, {
      slides: [
        { slideNumber: 1, descriptions: [{ objectId: "3", text: "A tree." }] },
      ],
    });
    const ids = [bundle.changes[0].id];
    let input = source;
    if (scenario === "wrong source")
      input = await zip(entries(slide(text(2, "Changed course") + image(3))));
    if (scenario === "changed plan")
      bundle.plan.slides[0].descriptions![0].text = "Forged edit";
    if (scenario === "forged ledger")
      bundle.changes[0].before = "Forged original";
    if (scenario === "unknown selection") ids[0] = "missing";
    if (scenario === "duplicate selection") ids.push(ids[0]);
    await expect(
      replayPptxRevisions(input, bundle, ids)
    ).rejects.toHaveProperty("code", "pptx_integrity");
  });

  it("merges corrective edits against original evidence and exposes only net revisions", async () => {
    const first: PptxRepairPlan = {
      slides: [
        {
          slideNumber: 1,
          descriptions: [{ objectId: "3", text: "An initial description." }],
          textStyles: [
            { objectId: "2", sourceText: "Course overview", fontSizePt: 24 },
          ],
          objectBounds: [
            {
              objectId: "2",
              sourceRect: { x: 0, y: 2000, width: 1000, height: 500 },
              rect: { x: 1, y: 2000, width: 1000, height: 500 },
            },
          ],
        },
      ],
    };
    const second: PptxRepairPlan = {
      slides: [
        {
          slideNumber: 1,
          descriptions: [
            {
              objectId: "3",
              text: "The corrected description.",
              replaceExisting: true,
            },
          ],
          textStyles: [
            {
              objectId: "2",
              sourceText: "Course overview",
              colorHex: "333333",
            },
          ],
          objectBounds: [
            {
              objectId: "2",
              sourceRect: { x: 1, y: 2000, width: 1000, height: 500 },
              rect: { x: 2, y: 2000, width: 1000, height: 500 },
            },
          ],
        },
      ],
    };
    const merged = mergePptxRepairPlans(first, second);
    expect(merged.slides[0].objectBounds![0].sourceRect.x).toBe(0);
    expect(merged.slides[0].textStyles![0]).toMatchObject({
      fontSizePt: 24,
      colorHex: "333333",
    });
    const { bundle } = await createPptxRevisionBundle(
      await zip(entries()),
      merged
    );
    expect(bundle.changes).toHaveLength(3);
    expect(
      bundle.changes.find((change) => change.type === "description")?.after
    ).toBe("The corrected description.");
  });

  it("does not claim no-op edits or speculative mechanical repairs", async () => {
    const source = await zip(
      entries(slide(text(2, "Bonjour.") + image(3, 'descr="An oak tree."')))
    );
    const inspection = await inspectPptx(source);
    const mechanical = await applyPptxRepairs(
      source,
      buildPptxMechanicalPlan(inspection)
    );
    expect(mechanical.buffer.equals(source)).toBe(true);
    const { bundle } = await createPptxRevisionBundle(source, {
      slides: [
        {
          slideNumber: 1,
          descriptions: [
            { objectId: "3", text: "An oak tree.", replaceExisting: true },
          ],
          textLanguages: [
            { objectId: "2", sourceText: "Bonjour.", tag: "en-US" },
          ],
          readingOrder: ["2", "3"],
        },
      ],
    });
    expect(bundle.changes).toEqual([]);
  });

  it("can designate an existing body placeholder as the title without replacing its text or index", async () => {
    const source = await zip(
      entries(
        slide(text(2, "Overview", 0, 2000, '<p:ph type="body" idx="4"/>'))
      )
    );
    const { result, bundle } = await createPptxRevisionBundle(source, {
      slides: [{ slideNumber: 1, titleObjectId: "2" }],
    });
    expect(result.inspection.slides[0].objects[0]).toMatchObject({
      text: "Overview",
      isTitle: true,
    });
    expect(
      (await unzip(result.buffer)).get("ppt/slides/slide1.xml")?.toString()
    ).toContain('type="title" idx="4"');
    expect(bundle.changes[0].type).toBe("title");
  });

  it("keeps dependent table structure and appearance changes together", async () => {
    const source = await zip(entries(slide(captionTable())));
    const { bundle, result } = await createPptxRevisionBundle(source, {
      slides: [
        {
          slideNumber: 1,
          splitTableCaption: [splitCaption],
          textStyles: [
            {
              objectId: "3",
              sourceText: "Compare leaf shapes",
              colorHex: "000000",
            },
          ],
        },
      ],
    });
    expect(bundle.changes).toHaveLength(1);
    expect(bundle.changes[0]).toMatchObject({
      type: "table-caption",
      operationIds: ["1:table-caption:3", "1:text-style:0"],
    });
    expect(
      result.inspection.slides[0].objects
        .find((object) => object.id === "3")
        ?.textRuns?.find((run) => run.text === "Compare leaf shapes")?.colorHex
    ).toBe("000000");
    expect(
      (await replayPptxRevisions(source, bundle, [])).buffer.equals(source)
    ).toBe(true);
    const selected = await replayPptxRevisions(source, bundle, [
      bundle.changes[0].id,
    ]);
    expect((await unzip(selected.buffer)).get("ppt/slides/slide1.xml")).toEqual(
      (await unzip(result.buffer)).get("ppt/slides/slide1.xml")
    );
  });

  it("uses identical object labels on both sides of a reading-order comparison", async () => {
    const source = await zip(
      entries(
        slide(text(2, "Title") + image(3, 'descr="Original description"'))
      )
    );
    const { bundle } = await createPptxRevisionBundle(source, {
      slides: [
        {
          slideNumber: 1,
          readingOrder: ["3", "2"],
          descriptions: [
            {
              objectId: "3",
              text: "Revised description",
              replaceExisting: true,
            },
          ],
        },
      ],
    });
    const order = bundle.changes.find(
      (change) => change.type === "reading-order"
    )!;
    expect(order.before).toContain("Original description");
    expect(order.after).toContain("Original description");
    expect(order.after).not.toContain("Revised description");
  });

  it("supports reviewed descriptions for native tables", async () => {
    const source = await zip(entries(slide(table(3))));
    const { result, bundle } = await createPptxRevisionBundle(source, {
      slides: [
        {
          slideNumber: 1,
          descriptions: [
            {
              objectId: "3",
              text: "Two columns: group and count. North has ten.",
              replaceExisting: true,
            },
          ],
        },
      ],
    });
    expect(result.inspection.slides[0].objects[0].description).toBe(
      "Two columns: group and count. North has ten."
    );
    expect(bundle.changes[0].type).toBe("description");
  });

  it("exposes native diagram text without editing the SmartArt data part", async () => {
    const diagram = `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="3" name="Grades" descr="Grading rubric"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="100" y="200"/><a:ext cx="2000" cy="1000"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/diagram"><dgm:relIds xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram" r:dm="rDiagram"/></a:graphicData></a:graphic></p:graphicFrame>`;
    const parts = entries(slide(text(2, "Grades") + diagram));
    parts[5][1] = String(parts[5][1]).replace(
      "</Relationships>",
      `<Relationship Id="rDiagram" Type="${R}/diagramData" Target="../diagrams/data1.xml"/></Relationships>`
    );
    parts.push([
      "ppt/diagrams/data1.xml",
      `<dgm:dataModel xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram" xmlns:a="${A}"><dgm:ptLst><dgm:pt><dgm:t><a:p><a:r><a:t>Homework: 15%</a:t></a:r></a:p></dgm:t></dgm:pt></dgm:ptLst></dgm:dataModel>`,
    ]);
    const source = await zip(parts);
    const inspection = await inspectPptx(source);
    expect(inspection.slides[0].objects[1].diagramText).toEqual([
      "Homework: 15%",
    ]);
    const { result } = await createPptxRevisionBundle(source, {
      slides: [
        {
          slideNumber: 1,
          descriptions: [
            {
              objectId: "3",
              text: "Homework is 15% of the course grade.",
              replaceExisting: true,
            },
          ],
        },
      ],
    });
    expect((await unzip(result.buffer)).get("ppt/diagrams/data1.xml")).toEqual(
      (await unzip(source)).get("ppt/diagrams/data1.xml")
    );
  });
});

function text(
  id: number,
  value: string,
  x = 0,
  y = id * 1000,
  more = ""
): string {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Text ${id}"/><p:cNvSpPr/><p:nvPr>${more}</p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="1000" cy="500"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>${value}</a:t></a:r></a:p></p:txBody></p:sp>`;
}
function image(id: number, extra = "", x = 3000, y = 3000): string {
  return `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="Image ${id}" ${extra}/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rImage"/></p:blipFill><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="1000" cy="500"/></a:xfrm></p:spPr></p:pic>`;
}
function table(id: number, merged = false): string {
  const cell = (value: string, merge = false) =>
    `<a:tc${merge ? ' gridSpan="2"' : ""}><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${value}</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc>`;
  return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="Data table"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="100" y="5000"/><a:ext cx="2000" cy="1000"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr/><a:tblGrid><a:gridCol w="1000"/><a:gridCol w="1000"/></a:tblGrid><a:tr h="500">${cell("Group", merged)}${cell("Count")}</a:tr><a:tr h="500">${cell("North")}${cell("10")}</a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
}
function slide(objects: string, options = "", extra = ""): string {
  return `<p:sld xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}" ${options}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${objects}</p:spTree></p:cSld>${extra}</p:sld>`;
}
const captionCells = [
  ["Group discussion", ""],
  ["Pair A", "Compare leaf shapes"],
  ["Pair B", "Compare soil texture"],
];
const splitCaption = {
  objectId: "3",
  captionText: "Group discussion",
  headerTexts: ["Pair", "Discussion task"],
  sourceCells: captionCells,
};
function captionTable(): string {
  const cell = (value: string, attrs = "", caption = false) =>
    `<a:tc ${attrs}><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr sz="2100"${caption ? ' b="1"' : ""}><a:solidFill><a:srgbClr val="${caption ? "FFFFFF" : "18334B"}"/></a:solidFill><a:latin typeface="Arial"/></a:rPr><a:t>${value}</a:t></a:r></a:p></a:txBody><a:tcPr marL="114300" marR="114300" marT="114300" marB="114300"><a:solidFill><a:srgbClr val="${caption ? "245574" : "FFFFFF"}"/></a:solidFill></a:tcPr></a:tc>`;
  return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="3" name="Group discussion table"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="685800" y="2238375"/><a:ext cx="7334250" cy="2571750"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="0" bandRow="0"/><a:tblGrid><a:gridCol w="3667125"/><a:gridCol w="3667125"/></a:tblGrid><a:tr h="857250">${cell("Group discussion", 'gridSpan="2"', true)}${cell("", 'hMerge="1"', true)}</a:tr>${captionCells
    .slice(1)
    .map(
      (row) =>
        `<a:tr h="857250">${row.map((value) => cell(value)).join("")}</a:tr>`
    )
    .join("")}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
}
async function zip(entries: [string, Buffer | string][]): Promise<Buffer> {
  const archive = new ZipFile();
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    archive.outputStream.on("data", (chunk) => chunks.push(chunk));
    archive.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    archive.outputStream.on("error", reject);
  });
  for (const [name, value] of entries)
    archive.addBuffer(Buffer.from(value), name);
  archive.end();
  return done;
}
function entries(
  firstSlide = slide(text(2, "Course overview") + image(3))
): [string, Buffer | string][] {
  return [
    [
      "[Content_Types].xml",
      `<Types xmlns="${CT}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>`,
    ],
    [
      "_rels/.rels",
      `<Relationships xmlns="${REL}"><Relationship Id="rMain" Type="${R}/officeDocument" Target="ppt/presentation.xml"/></Relationships>`,
    ],
    [
      "ppt/presentation.xml",
      `<p:presentation xmlns:p="${P}" xmlns:r="${R}"><p:sldIdLst><p:sldId id="256" r:id="rSlide"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/></p:presentation>`,
    ],
    [
      "ppt/_rels/presentation.xml.rels",
      `<Relationships xmlns="${REL}"><Relationship Id="rSlide" Type="${R}/slide" Target="slides/slide1.xml"/></Relationships>`,
    ],
    ["ppt/slides/slide1.xml", firstSlide],
    [
      "ppt/slides/_rels/slide1.xml.rels",
      `<Relationships xmlns="${REL}"><Relationship Id="rImage" Type="${R}/image" Target="../media/image1.png"/><Relationship Id="rNotes" Type="${R}/notesSlide" Target="../notesSlides/notesSlide1.xml"/></Relationships>`,
    ],
    ["ppt/media/image1.png", Buffer.from([1, 2, 3, 4, 5])],
    [
      "ppt/notesSlides/notesSlide1.xml",
      `<p:notes xmlns:p="${P}" xmlns:a="${A}"><p:cSld><p:spTree>${text(2, "Speaker notes stay intact")}</p:spTree></p:cSld></p:notes>`,
    ],
  ];
}
async function unzip(buffer: Buffer): Promise<Map<string, Buffer>> {
  const archive = await fromBufferPromise(buffer);
  const result = new Map<string, Buffer>();
  for await (const entry of archive.eachEntry()) {
    const stream = await archive.openReadStreamPromise(entry);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk);
    result.set(entry.fileName, Buffer.concat(chunks));
  }
  archive.close();
  return result;
}

describe("PowerPoint package remediation", () => {
  it("reports structural defects before a plan and clears them after verified repairs", async () => {
    const original = await zip(
      entries(slide(text(2, "Course overview") + image(3) + table(4)))
    );
    const source = await inspectPptx(original);
    const before = JSON.stringify(source);
    const defects = checkPptxAccessibility(source);
    expect(
      defects.map(({ code, severity, slideNumber, objectId }) => ({
        code,
        severity,
        slideNumber,
        objectId,
      }))
    ).toEqual([
      {
        code: "slide-title",
        severity: "error",
        slideNumber: 1,
        objectId: undefined,
      },
      {
        code: "missing-description",
        severity: "error",
        slideNumber: 1,
        objectId: "3",
      },
      {
        code: "missing-table-headers",
        severity: "error",
        slideNumber: 1,
        objectId: "4",
      },
    ]);
    expect(JSON.stringify(source)).toBe(before);
    expect(
      source.findings.some((finding) =>
        defects.some((defect) => defect.code === finding.code)
      )
    ).toBe(false);
    const repaired = await applyPptxRepairs(original, {
      slides: [
        {
          slideNumber: 1,
          titleObjectId: "2",
          descriptions: [
            {
              objectId: "3",
              text: "The source diagram illustrates the two classroom groups.",
            },
          ],
          tableHeaders: [
            { objectId: "4", firstRow: true, headerTexts: ["Group", "Count"] },
          ],
        },
      ],
    });
    expect(checkPptxAccessibility(repaired.inspection)).toEqual([]);
    expect(
      repaired.findings.some((finding) =>
        defects.some((defect) => defect.code === finding.code)
      )
    ).toBe(false);
  });

  it("keeps duplicate titles as review warnings and does not invent another slide for duplicate objects", async () => {
    const titleShape = (id: number) =>
      text(id, "Same title", 0, id * 1000, '<p:ph type="title"/>');
    const source = await inspectPptx(await zip(entries(slide(titleShape(2)))));
    const duplicateAcrossSlides = {
      ...source,
      slideCount: 2,
      slides: [
        source.slides[0],
        {
          ...source.slides[0],
          slideNumber: 2,
          partName: "ppt/slides/slide2.xml",
        },
      ],
    };
    expect(
      checkPptxAccessibility(duplicateAcrossSlides).map(
        ({ code, severity, slideNumber }) => ({ code, severity, slideNumber })
      )
    ).toEqual([
      { code: "duplicate-title", severity: "warning", slideNumber: 1 },
      { code: "duplicate-title", severity: "warning", slideNumber: 2 },
    ]);
    const sameSlide = await inspectPptx(
      await zip(entries(slide(titleShape(2) + titleShape(3))))
    );
    expect(checkPptxAccessibility(sameSlide)).toEqual([
      expect.objectContaining({
        code: "slide-title",
        severity: "error",
        slideNumber: 1,
      }),
    ]);
  });

  it("splits a merged caption into editable text and real headers while preserving every body row", async () => {
    const original = await zip(
      entries(slide(text(2, "Discussion groups") + captionTable()))
    );
    const result = await applyPptxRepairs(original, {
      slides: [{ slideNumber: 1, splitTableCaption: [splitCaption] }],
    });
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toMatchObject({
      type: "table-caption",
      objectId: "3",
      visualRegion: { x: 685800, y: 2238375, width: 7334250, height: 857250 },
    });
    const objects = result.inspection.slides[0].objects;
    expect(objects.map((o) => o.id)).toEqual(["2", "4", "3"]);
    expect(objects[1]).toMatchObject({
      kind: "text",
      text: "Group discussion",
      rect: { x: 685800, y: 2238375, width: 7334250, height: 428400 },
    });
    expect(objects[2]).toMatchObject({
      table: {
        firstRow: true,
        complex: false,
        cells: [["Pair", "Discussion task"], ...captionCells.slice(1)],
      },
      rect: { x: 685800, y: 2666775, width: 7334250, height: 2143350 },
    });
    expect(2238375 + 857250).toBe(objects[2].rect!.y + 428850);
    const before = await unzip(original),
      after = await unzip(result.buffer);
    const parse = (parts: Map<string, Buffer>) =>
      new DOMParser().parseFromString(
        parts.get("ppt/slides/slide1.xml")!.toString(),
        "application/xml"
      );
    const originalRows = Array.from(
      parse(before).getElementsByTagNameNS(A, "tr")
    );
    const outputRows = Array.from(parse(after).getElementsByTagNameNS(A, "tr"));
    expect(outputRows.slice(1).map(pptxElementHash)).toEqual(
      originalRows.slice(1).map(pptxElementHash)
    );
    expect(after.get("ppt/slides/slide1.xml")!.toString()).toContain(
      'sz="2100"'
    );
    for (const [name, bytes] of before)
      if (name !== "ppt/slides/slide1.xml")
        expect(after.get(name)).toEqual(bytes);
    expect(
      result.findings.some((f) => f.code === "missing-table-headers")
    ).toBe(false);
  });

  it.each([
    [
      "additional body merge",
      (xml: string) =>
        xml.replace("<a:tc ><a:txBody>", '<a:tc rowSpan="2"><a:txBody>'),
    ],
    [
      "caption with several runs",
      (xml: string) =>
        xml.replace(
          "<a:t>Group discussion</a:t></a:r>",
          "<a:t>Group discussion</a:t></a:r><a:r><a:t/></a:r>"
        ),
    ],
    [
      "insufficient row height",
      (xml: string) =>
        xml
          .replaceAll('h="857250"', 'h="100000"')
          .replace('cy="2571750"', 'cy="300000"'),
    ],
    [
      "caption contains a link",
      (xml: string) =>
        xml.replace(
          '<a:rPr sz="2100" b="1">',
          '<a:rPr sz="2100" b="1"><a:hlinkClick/>'
        ),
    ],
    [
      "hidden table",
      (xml: string) =>
        xml.replace(
          'name="Group discussion table"',
          'name="Group discussion table" hidden="1"'
        ),
    ],
    [
      "unequal frame and row heights",
      (xml: string) => xml.replace('cy="2571750"', 'cy="2571751"'),
    ],
  ])(
    "leaves %s unchanged and reports missing real headers",
    async (_name, mutate) => {
      const original = await zip(entries(slide(mutate(captionTable()))));
      const result = await applyPptxRepairs(original, {
        slides: [{ slideNumber: 1, splitTableCaption: [splitCaption] }],
      });
      expect(result.buffer).toEqual(original);
      expect(result.changes).toEqual([]);
      expect(result.findings).toContainEqual(
        expect.objectContaining({
          code: "missing-table-headers",
          severity: "error",
          slideNumber: 1,
          objectId: "3",
        })
      );
    }
  );

  it("rejects caption repair when source cells disagree, objects overlap, or proposed labels do not fit", async () => {
    const original = await zip(entries(slide(captionTable())));
    for (const repair of [
      {
        ...splitCaption,
        sourceCells: [
          ["Group discussion", ""],
          ["Changed data", "Compare leaf shapes"],
          captionCells[2],
        ],
      },
      { ...splitCaption, headerTexts: ["W".repeat(40), "Discussion task"] },
    ]) {
      const result = await applyPptxRepairs(original, {
        slides: [{ slideNumber: 1, splitTableCaption: [repair] }],
      });
      expect(result.buffer).toEqual(original);
    }
    const overlapping = await zip(
      entries(
        slide(captionTable() + text(7, "Overlapping content", 700000, 2240000))
      )
    );
    const result = await applyPptxRepairs(overlapping, {
      slides: [{ slideNumber: 1, splitTableCaption: [splitCaption] }],
    });
    expect(result.buffer).toEqual(overlapping);
  });

  it("detects missing table headers deterministically when a model proposes no repair", async () => {
    const original = await zip(entries(slide(captionTable())));
    const result = await applyPptxRepairs(original, { slides: [] });
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        code: "missing-table-headers",
        severity: "error",
        slideNumber: 1,
        objectId: "3",
      })
    );
    expect(
      validatePptxRepairPlan({
        slides: [
          {
            slideNumber: 1,
            splitTableCaption: [{ ...splitCaption, headerTexts: ["Pair", ""] }],
          },
        ],
      })
    ).toBe(false);
  });

  it("keeps a generated caption immediately before its table when an old-ID reading-order plan is unsafe", async () => {
    const original = await zip(
      entries(slide(text(2, "Discussion groups") + captionTable()))
    );
    const result = await applyPptxRepairs(original, {
      slides: [
        {
          slideNumber: 1,
          splitTableCaption: [splitCaption],
          readingOrder: ["3", "2"],
        },
      ],
    });
    expect(
      result.inspection.slides[0].objects.map((object) => object.id)
    ).toEqual(["2", "4", "3"]);
    expect(result.changes.map((change) => change.type)).toEqual([
      "table-caption",
    ]);
    expect(
      result.findings.some((finding) => finding.code === "reading-order-review")
    ).toBe(true);
  });

  it.each([
    ["direct paragraph", "135000", "120000", "110000", "105000", "135000"],
    ["local list style", "", "120000", "110000", "105000", "120000"],
    ["master other style", "", "", "110000", "105000", "110000"],
    ["presentation default", "", "", "", "105000", "105000"],
    ["DrawingML default", "", "", "", "", "100000"],
  ])(
    "preserves %s line spacing when promoting a title",
    async (
      _name,
      paragraphSpacing,
      localSpacing,
      otherSpacing,
      defaultSpacing,
      expected
    ) => {
      const spacing = (value: string) =>
        value ? `<a:lnSpc><a:spcPct val="${value}"/></a:lnSpc>` : "";
      const title = text(2, "Course overview")
        .replace(
          "<a:lstStyle/>",
          `<a:lstStyle><a:lvl1pPr>${spacing(localSpacing)}</a:lvl1pPr></a:lstStyle>`
        )
        .replace("<a:p>", `<a:p><a:pPr>${spacing(paragraphSpacing)}</a:pPr>`);
      const parts = entries(slide(title));
      const source = (name: string) => parts.find(([key]) => key === name)!;
      const slideRelationships = source("ppt/slides/_rels/slide1.xml.rels");
      slideRelationships[1] = String(slideRelationships[1]).replace(
        "</Relationships>",
        `<Relationship Id="rLayout" Type="${R}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>`
      );
      const presentation = source("ppt/presentation.xml");
      presentation[1] = String(presentation[1]).replace(
        "</p:presentation>",
        `<p:defaultTextStyle xmlns:a="${A}"><a:lvl1pPr>${spacing(defaultSpacing)}</a:lvl1pPr></p:defaultTextStyle></p:presentation>`
      );
      parts.push(
        [
          "ppt/slideLayouts/slideLayout1.xml",
          `<p:sldLayout xmlns:p="${P}"><p:cSld><p:spTree/></p:cSld></p:sldLayout>`,
        ],
        [
          "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
          `<Relationships xmlns="${REL}"><Relationship Id="rMaster" Type="${R}/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`,
        ],
        [
          "ppt/slideMasters/slideMaster1.xml",
          `<p:sldMaster xmlns:p="${P}" xmlns:a="${A}"><p:txStyles><p:titleStyle><a:lvl1pPr>${spacing("90000")}</a:lvl1pPr></p:titleStyle><p:otherStyle><a:lvl1pPr>${spacing(otherSpacing)}</a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>`,
        ]
      );
      const original = await zip(parts);
      const result = await applyPptxRepairs(original, {
        slides: [{ slideNumber: 1, titleObjectId: "2" }],
      });
      const output = await unzip(result.buffer);
      const document = new DOMParser().parseFromString(
        output.get("ppt/slides/slide1.xml")!.toString(),
        "application/xml"
      );
      const p = document.getElementsByTagNameNS(A, "p")[0];
      expect(p.getElementsByTagNameNS(A, "lnSpc")).toHaveLength(1);
      expect(p.getElementsByTagNameNS(A, "spcPct")[0].getAttribute("val")).toBe(
        expected
      );
      expect(result.inspection.slides[0].objects[0].isTitle).toBe(true);
      expect(result.inspection.slides[0].objects[0].text).toBe(
        "Course overview"
      );
      const before = await unzip(original);
      for (const [name, bytes] of before)
        if (name !== "ppt/slides/slide1.xml")
          expect(output.get(name)).toEqual(bytes);
    }
  );

  it("preserves XML declarations and other document nodes during strict repair serialization", async () => {
    const declaration =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
    const source =
      declaration +
      "\n<!--authored comment--><?editor preserved?>" +
      slide(text(2, "Course overview") + image(3));
    const original = await zip(entries(source));
    const result = await applyPptxRepairs(original, {
      slides: [
        {
          slideNumber: 1,
          titleObjectId: "2",
          descriptions: [
            { objectId: "3", text: 'A diagram with <labels> & "an arrow".' },
          ],
        },
      ],
    });
    const before = await unzip(original);
    const after = await unzip(result.buffer);
    const repaired = after.get("ppt/slides/slide1.xml")!.toString();
    expect(repaired.startsWith(declaration)).toBe(true);
    expect(repaired.match(/<\?xml/g)).toHaveLength(1);
    expect(repaired).toContain("<!--authored comment--><?editor preserved?>");
    expect(repaired).toContain("&lt;labels&gt; &amp; &quot;an arrow&quot;");
    expect(result.inspection.slides[0].objects[0].text).toBe("Course overview");
    expect(result.inspection.slides[0].objects[0].isTitle).toBe(true);
    expect(result.inspection.slides[0].objects[1].description).toBe(
      'A diagram with <labels> & "an arrow".'
    );
    for (const [name, bytes] of before)
      if (name !== "ppt/slides/slide1.xml")
        expect(after.get(name)).toEqual(bytes);
  });

  it("applies only title/description metadata and retains all unrelated parts byte for byte", async () => {
    const original = await zip(entries());
    const result = await applyPptxRepairs(original, {
      slides: [
        {
          slideNumber: 1,
          titleObjectId: "2",
          descriptions: [
            { objectId: "3", text: "A diagram with <labels> & an arrow." },
          ],
        },
      ],
    });
    expect(result.changes.map((change) => change.type)).toEqual([
      "title",
      "description",
    ]);
    expect(result.inspection.slides[0].objects[0].isTitle).toBe(true);
    expect(result.inspection.slides[0].objects[1].description).toBe(
      "A diagram with <labels> & an arrow."
    );
    const before = await unzip(original);
    const after = await unzip(result.buffer);
    for (const [name, bytes] of before)
      if (name !== "ppt/slides/slide1.xml")
        expect(after.get(name)).toEqual(bytes);
    expect(after.get("ppt/slides/slide1.xml")!.toString()).toContain(
      "&lt;labels&gt; &amp;"
    );
  });

  it("retains authored description/title and decorative metadata", async () => {
    const decorated = image(5).replace(
      'name="Image 5" />',
      `name="Image 5"><a:extLst><a:ext uri="decorative"><d:decorative xmlns:d="http://schemas.microsoft.com/office/drawing/2017/decorative" val="1"/></a:ext></a:extLst></p:cNvPr>`
    );
    const input = await zip(
      entries(
        slide(
          text(2, "Overview") +
            image(3, 'descr="Author description"') +
            image(4, 'title="Author title"') +
            decorated
        )
      )
    );
    const result = await applyPptxRepairs(input, {
      slides: [
        {
          slideNumber: 1,
          descriptions: [3, 4, 5].map((n) => ({
            objectId: String(n),
            text: "Replacement",
          })),
        },
      ],
    });
    expect(result.buffer).toEqual(input);
    expect(result.changes).toHaveLength(0);
    expect(
      result.findings.filter(
        (item) => item.code === "authored-description-preserved"
      )
    ).toHaveLength(3);
  });

  it("reorders only a complete set of separate, unanimated objects", async () => {
    const input = await zip(entries(slide(image(3) + text(2, "Overview"))));
    const result = await applyPptxRepairs(input, {
      slides: [{ slideNumber: 1, readingOrder: ["2", "3"] }],
    });
    expect(
      result.inspection.slides[0].objects.map((object) => object.id)
    ).toEqual(["2", "3"]);
    expect(result.changes[0].type).toBe("reading-order");
  });

  it.each([
    [
      "overlapping",
      slide(image(3, "", 0, 2000) + text(2, "Overview")),
      ["2", "3"],
    ],
    [
      "animated",
      slide(image(3) + text(2, "Overview"), "", "<p:timing/>"),
      ["2", "3"],
    ],
    ["incomplete", slide(image(3) + text(2, "Overview")), ["2"]],
    [
      "grouped",
      slide(
        `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="6" name="Group"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${image(3)}</p:grpSp>` +
          text(2, "Overview")
      ),
      ["2", "6"],
    ],
  ])("preserves reading order for %s slides", async (_, xml, readingOrder) => {
    const input = await zip(entries(xml as string));
    const result = await applyPptxRepairs(input, {
      slides: [{ slideNumber: 1, readingOrder: readingOrder as string[] }],
    });
    expect(result.buffer).toEqual(input);
    expect(
      result.findings.some((finding) => finding.code === "reading-order-review")
    ).toBe(true);
  });

  it("marks a simple table header only with exact existing header text", async () => {
    const input = await zip(entries(slide(text(2, "Data") + table(3))));
    const good = await applyPptxRepairs(input, {
      slides: [
        {
          slideNumber: 1,
          tableHeaders: [
            { objectId: "3", firstRow: true, headerTexts: ["Group", "Count"] },
          ],
        },
      ],
    });
    expect(good.inspection.slides[0].objects[1].table?.firstRow).toBe(true);
    const wrong = await applyPptxRepairs(input, {
      slides: [
        {
          slideNumber: 1,
          tableHeaders: [
            {
              objectId: "3",
              firstRow: true,
              headerTexts: ["Invented", "Labels"],
            },
          ],
        },
      ],
    });
    expect(wrong.buffer).toEqual(input);
    expect(
      wrong.findings.some((item) => item.code === "table-header-review")
    ).toBe(true);
    const merged = await zip(entries(slide(table(3, true))));
    const complex = await applyPptxRepairs(merged, {
      slides: [
        {
          slideNumber: 1,
          tableHeaders: [
            { objectId: "3", firstRow: true, headerTexts: ["Group", "Count"] },
          ],
        },
      ],
    });
    expect(complex.buffer).toEqual(merged);
  });

  it("preserves inherited language instead of filling from another run", async () => {
    const xml = slide(
      text(2, "Overview") +
        text(3, "Some details").replace('<a:rPr lang="en-US"/>', "")
    );
    const input = await zip(entries(xml));
    const result = await applyPptxRepairs(input, {
      slides: [
        {
          slideNumber: 1,
          language: { tag: "en-US", evidenceText: "Some details" },
        },
      ],
    });
    expect(result.buffer).toEqual(input);
    expect(result.inspection.slides[0].objects[1].language).toBe(null);
    expect(
      result.findings.some((finding) => finding.code === "language-review")
    ).toBe(true);
    const wrong = await applyPptxRepairs(input, {
      slides: [
        {
          slideNumber: 1,
          language: { tag: "fr-FR", evidenceText: "Some details" },
        },
      ],
    });
    expect(wrong.buffer).toEqual(input);
  });

  it("does not write descriptions for grouped or unmeasured objects", async () => {
    const grouped = `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="6" name="Group"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${image(3)}</p:grpSp>`;
    const rotated = image(4).replace("<a:xfrm>", '<a:xfrm rot="5400000">');
    const input = await zip(entries(slide(grouped + rotated)));
    const result = await applyPptxRepairs(input, {
      slides: [
        {
          slideNumber: 1,
          descriptions: [
            { objectId: "3", text: "Grouped picture" },
            { objectId: "4", text: "Rotated picture" },
          ],
        },
      ],
    });
    expect(result.buffer).toEqual(input);
    expect(
      result.findings
        .filter((finding) => finding.code === "description-identity-review")
        .map((finding) => finding.objectId)
    ).toEqual(["3", "4"]);
  });

  it("does not repurpose an existing body placeholder as a title", async () => {
    const input = await zip(
      entries(
        slide(text(2, "Body text", 0, 1000, '<p:ph type="body" idx="1"/>'))
      )
    );
    const result = await applyPptxRepairs(input, {
      slides: [{ slideNumber: 1, titleObjectId: "2" }],
    });
    expect(result.buffer).toEqual(input);
    expect(
      result.findings.some((finding) => finding.code === "title-review")
    ).toBe(true);
  });

  it("gives a promoted title an unused placeholder index", async () => {
    const input = await zip(
      entries(
        slide(
          text(2, "Overview") +
            text(3, "Body text", 0, 4000, '<p:ph type="body" idx="0"/>')
        )
      )
    );
    const result = await applyPptxRepairs(input, {
      slides: [{ slideNumber: 1, titleObjectId: "2" }],
    });
    const output = await unzip(result.buffer);
    expect(output.get("ppt/slides/slide1.xml")!.toString()).toContain(
      '<p:ph type="title" idx="1"'
    );
  });

  it("uses presentation order and preserves hidden slides", async () => {
    const parts = entries(slide(text(2, "First package file")));
    parts[0][1] = String(parts[0][1]).replace(
      "</Types>",
      '<Override PartName="/ppt/slides/slide2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>'
    );
    parts[2][1] = String(parts[2][1]).replace(
      '<p:sldId id="256" r:id="rSlide"/>',
      '<p:sldId id="257" r:id="rSecond"/><p:sldId id="256" r:id="rSlide"/>'
    );
    parts[3][1] = String(parts[3][1]).replace(
      "</Relationships>",
      `<Relationship Id="rSecond" Type="${R}/slide" Target="slides/slide2.xml"/></Relationships>`
    );
    parts.push([
      "ppt/slides/slide2.xml",
      slide(text(2, "Actually first slide"), 'show="0"'),
    ]);
    const result = await inspectPptx(await zip(parts));
    expect(result.slides[0].partName).toBe("ppt/slides/slide2.xml");
    expect(result.slides[0].hidden).toBe(true);
    expect(result.slides[0].objects[0].text).toBe("Actually first slide");
  });

  it("keeps external links without fetching them and reports linked content", async () => {
    const parts = entries();
    parts[5][1] = String(parts[5][1]).replace(
      "</Relationships>",
      `<Relationship Id="rExternal" Type="${R}/image" Target="https://example.invalid/private.png" TargetMode="External"/></Relationships>`
    );
    const input = await zip(parts);
    const result = await applyPptxRepairs(input, { slides: [] });
    expect(result.buffer).toEqual(input);
    expect(result.inspection.slides[0].hasExternalContent).toBe(true);
    expect(
      result.findings.some((item) => item.code === "external-content")
    ).toBe(true);
  });

  it("rejects arbitrary patch fields and duplicate targets", () => {
    expect(
      validatePptxRepairPlan({ slides: [{ slideNumber: 1, xml: "<p:sld/>" }] })
    ).toBe(false);
    expect(
      validatePptxRepairPlan({
        slides: [
          {
            slideNumber: 1,
            descriptions: [
              { objectId: "3", text: "one" },
              { objectId: "3", text: "two" },
            ],
          },
        ],
      })
    ).toBe(false);
    expect(
      validatePptxRepairPlan({
        slides: [{ slideNumber: 1, readingOrder: ["2", "2"] }],
      })
    ).toBe(false);
    expect(
      validatePptxRepairPlan({ slides: [{ slideNumber: 1, decorative: true }] })
    ).toBe(false);
  });

  it.each([
    "DTD",
    "duplicate part",
    "macro",
    "signature",
    "strict",
    "inflation",
    "depth",
    "missing relationship target",
  ])("rejects %s packages before remediation", async (scenario) => {
    const parts = entries();
    if (scenario === "DTD")
      parts[4][1] = '<!DOCTYPE x [<!ENTITY x "bad">]>' + parts[4][1];
    if (scenario === "duplicate part")
      parts.push(["ppt/slides/slide1.xml", parts[4][1]]);
    if (scenario === "macro") parts.push(["ppt/vbaProject.bin", "macro"]);
    if (scenario === "signature")
      parts.push(["_xmlsignatures/sig1.xml", "<signature/>"]);
    if (scenario === "strict")
      parts[2][1] = String(parts[2][1]).replace(
        P,
        "http://purl.oclc.org/ooxml/presentationml/main"
      );
    if (scenario === "inflation")
      parts.push(["ppt/media/bomb.bin", Buffer.alloc(17 * 1024 * 1024)]);
    if (scenario === "depth")
      parts[4][1] = "<a>".repeat(101) + "</a>".repeat(101);
    if (scenario === "missing relationship target")
      parts[5][1] = String(parts[5][1]).replace(
        "../media/image1.png",
        "../media/missing.png"
      );
    await expect(inspectPptx(await zip(parts))).rejects.toHaveProperty(
      "name",
      "PptxPackageError"
    );
  });

  it("rejects conflicting local/central paths and a damaged CRC", async () => {
    const input = await zip(entries());
    const path = Buffer.from(input);
    // Flip a byte in the first local filename; the central directory stays unchanged.
    path[30] = path[30] === 65 ? 66 : 65;
    await expect(inspectPptx(path)).rejects.toHaveProperty(
      "code",
      "pptx_invalid"
    );
    const crc = Buffer.from(input);
    const central = crc.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    crc[central + 16] ^= 1;
    await expect(inspectPptx(crc)).rejects.toHaveProperty(
      "code",
      "pptx_invalid"
    );
  });
});
