import { describe, expect, it } from "vitest";
import { ZipFile } from "yazl";
import { fromBufferPromise } from "yauzl";
import { DOMParser } from "@xmldom/xmldom";
import { pptxElementHash } from "../lib/pptx-table-caption";
import {
  applyPptxRepairs,
  inspectPptx,
  validatePptxRepairPlan,
} from "../lib/pptx-package";

const P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const CT = "http://schemas.openxmlformats.org/package/2006/content-types";

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
