import { describe, expect, it } from "vitest";
import { ZipFile } from "yazl";
import { fromBufferPromise } from "yauzl";
import { DOMParser } from "@xmldom/xmldom";
import {
  applyDocxRepairs,
  buildDocxMechanicalPlan,
  checkDocxAccessibility,
  inspectDocx,
  validateDocxRepairPlan,
  type DocxRepairOperation,
} from "../lib/docx-package";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const WP =
  "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";
const REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const CT = "http://schemas.openxmlformats.org/package/2006/content-types";
const MAIN_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";
const paragraph = (text: string, props = "") =>
  `<w:p>${props ? `<w:pPr>${props}</w:pPr>` : ""}<w:r><w:rPr><w:rFonts w:ascii="Arial"/><w:b/><w:sz w:val="28"/></w:rPr><w:t>${text}</w:t></w:r></w:p>`;
const table = (cellProps = "") =>
  `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/></w:tblPr><w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid><w:tr><w:tc><w:tcPr>${cellProps}</w:tcPr>${paragraph("Week")}</w:tc><w:tc>${paragraph("Topic")}</w:tc></w:tr><w:tr><w:tc>${paragraph("1")}</w:tc><w:tc>${paragraph("Introduction")}</w:tc></w:tr></w:tbl>`;
const picture = (attributes = "", extra = "") =>
  `<w:p><w:r><w:drawing><wp:inline><wp:extent cx="914400" cy="914400"/><wp:docPr id="1" name="Course figure" ${attributes}>${extra}</wp:docPr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="0" name="picture.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rImage"/></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
function entries(
  body = paragraph(
    "Course outline",
    '<w:pStyle w:val="Normal"/><w:spacing w:after="123"/>'
  ) +
    paragraph("A paragraph.") +
    table() +
    picture()
): Record<string, string | Buffer> {
  return {
    "[Content_Types].xml": `<Types xmlns="${CT}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="${MAIN_TYPE}"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`,
    "_rels/.rels": `<Relationships xmlns="${REL}"><Relationship Id="rDoc" Type="${R}/officeDocument" Target="word/document.xml"/></Relationships>`,
    "word/document.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W}" xmlns:r="${R}" xmlns:a="${A}" xmlns:wp="${WP}"><w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`,
    "word/_rels/document.xml.rels": `<Relationships xmlns="${REL}"><Relationship Id="rStyles" Type="${R}/styles" Target="styles.xml"/><Relationship Id="rImage" Type="${R}/image" Target="media/picture.png"/></Relationships>`,
    "word/styles.xml": `<w:styles xmlns:w="${W}"><w:docDefaults><w:rPrDefault><w:rPr><w:lang w:val="en-US"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:pPr><w:spacing w:after="160"/></w:pPr><w:rPr><w:rFonts w:ascii="Calibri"/><w:sz w:val="22"/></w:rPr></w:style></w:styles>`,
    "word/media/picture.png": Buffer.from("unchanged-image-payload"),
    "docProps/custom.xml":
      '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties"/>',
  };
}
async function zip(parts: Record<string, string | Buffer>): Promise<Buffer> {
  const archive = new ZipFile();
  const chunks: Buffer[] = [];
  const result = new Promise<Buffer>((resolve, reject) => {
    archive.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    archive.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    archive.outputStream.on("error", reject);
  });
  for (const [name, text] of Object.entries(parts))
    archive.addBuffer(Buffer.isBuffer(text) ? text : Buffer.from(text), name);
  archive.end();
  return result;
}
async function unzip(buffer: Buffer): Promise<Map<string, Buffer>> {
  const result = new Map<string, Buffer>();
  const archive = await fromBufferPromise(buffer);
  for await (const entry of archive.eachEntry()) {
    const chunks: Buffer[] = [];
    for await (const chunk of await archive.openReadStreamPromise(entry))
      chunks.push(Buffer.from(chunk));
    result.set(entry.fileName, Buffer.concat(chunks));
  }
  archive.close();
  return result;
}
async function repair(buffer: Buffer, operations: DocxRepairOperation[]) {
  return applyDocxRepairs(buffer, {
    ...buildDocxMechanicalPlan(await inspectDocx(buffer)),
    operations,
  });
}
const p1 = "word/document.xml:p:1";
const i1 = "word/document.xml:i:1";
const t1 = "word/document.xml:t:1";

describe("native Word package repair", () => {
  const typedItem = (marker: string, body: string) =>
    `<w:p><w:pPr><w:spacing w:after="0"/><w:ind w:firstLine="360"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Cascadia Mono"/></w:rPr><w:t>${marker}</w:t></w:r><w:r><w:rPr><w:rFonts w:ascii="Cascadia Mono"/></w:rPr><w:t xml:space="preserve"> </w:t></w:r><w:r><w:rPr><w:b/><w:sz w:val="22"/></w:rPr><w:t>${body}</w:t></w:r><w:hyperlink r:id="rLink"><w:r><w:rPr><w:i/></w:rPr><w:t xml:space="preserve"> linked text</w:t></w:r></w:hyperlink></w:p>`;
  const groupedTable = () =>
    `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="9000" w:type="dxa"/></w:tblPr><w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid><w:tr><w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/><w:vMerge w:val="restart"/></w:tcPr>${paragraph("Type")}</w:tc><w:tc><w:tcPr><w:tcW w:w="6000" w:type="dxa"/><w:gridSpan w:val="2"/><w:shd w:val="clear" w:fill="002244"/></w:tcPr>${paragraph("Exams")}</w:tc></w:tr><w:tr><w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/><w:vMerge/></w:tcPr><w:p/></w:tc><w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/></w:tcPr>${paragraph("1")}</w:tc><w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/></w:tcPr>${paragraph("2")}</w:tc></w:tr><w:tr><w:tc>${paragraph("15%")}</w:tc><w:tc>${paragraph("20%")}</w:tc><w:tc>${paragraph("65%")}</w:tc></w:tr></w:tbl>`;
  const listOp = (
    inspection: Awaited<ReturnType<typeof inspectDocx>>,
    index = 0
  ): DocxRepairOperation => {
    const candidate = inspection.listCandidates![index];
    return {
      type: "convertTypedList",
      id: candidate.id,
      items: candidate.paragraphIds.map((paragraphId, i) => ({
        paragraphId,
        sourceText: candidate.sourceTexts[i],
      })),
    };
  };
  it("turns split-run typed bullets into a native list without rewriting rich body text or existing paragraph formatting", async () => {
    const parts = entries(
      typedItem("●", "First item") + typedItem("●", "Second item")
    );
    parts["word/_rels/document.xml.rels"] = String(
      parts["word/_rels/document.xml.rels"]
    ).replace(
      "</Relationships>",
      `<Relationship Id="rLink" Type="${R}/hyperlink" Target="https://example.edu/" TargetMode="External"/></Relationships>`
    );
    const source = await zip(parts),
      before = await inspectDocx(source);
    expect(before.listCandidates).toMatchObject([
      { kind: "bullet", marker: "●", prefixes: ["● ", "● "] },
    ]);
    const result = await repair(source, [listOp(before)]),
      output = await unzip(result.buffer);
    expect(result.inspection.paragraphs.map((p) => p.text)).toEqual([
      "First item linked text",
      "Second item linked text",
    ]);
    expect(
      result.inspection.paragraphs.every(
        (p) => p.list?.format === "bullet" && p.list.markerText === "●"
      )
    ).toBe(true);
    expect(
      new Set(result.inspection.paragraphs.map((p) => p.list?.numId)).size
    ).toBe(1);
    expect(result.changes[0].paragraphIds).toEqual(
      before.paragraphs.map((p) => p.id)
    );
    expect(result.identityMap).toEqual({
      [p1]: p1,
      "word/document.xml:p:2": "word/document.xml:p:2",
    });
    const xml = output.get("word/document.xml")!.toString();
    expect(xml.match(/<w:ind w:firstLine="360"\/>/g)).toHaveLength(2);
    expect(xml.match(/<w:spacing w:after="0"\/>/g)).toHaveLength(2);
    expect(xml).toContain(
      '<w:r><w:rPr><w:b/><w:sz w:val="22"/></w:rPr><w:t>First item</w:t></w:r>'
    );
    expect(xml).toContain(
      '<w:hyperlink r:id="rLink"><w:r><w:rPr><w:i/></w:rPr><w:t xml:space="preserve"> linked text</w:t></w:r></w:hyperlink>'
    );
    expect(output.get("word/numbering.xml")!.toString()).toContain(
      '<w:suff w:val="space"/>'
    );
    expect(output.get("word/numbering.xml")!.toString()).toContain(
      '<w:rFonts w:ascii="Cascadia Mono"/>'
    );
    expect(output.get("word/_rels/document.xml.rels")!.toString()).toContain(
      'Target="https://example.edu/" TargetMode="External"'
    );
    for (const name of [
      "word/styles.xml",
      "word/media/picture.png",
      "docProps/custom.xml",
      "_rels/.rels",
    ])
      expect(output.get(name)).toEqual(Buffer.from(parts[name]));
  });
  it("preserves an ordered list's start and punctuation while appending definitions without editing existing numbering", async () => {
    const parts = entries(
      typedItem("3)", "Read") +
        typedItem("4)", "Compare") +
        typedItem("5)", "Explain")
    );
    const originalDefinition =
      '<w:abstractNum w:abstractNumId="7"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/></w:lvl></w:abstractNum><w:num w:numId="8"><w:abstractNumId w:val="7"/></w:num>';
    parts["word/numbering.xml"] =
      `<w:numbering xmlns:w="${W}">${originalDefinition}</w:numbering>`;
    parts["word/_rels/document.xml.rels"] = String(
      parts["word/_rels/document.xml.rels"]
    ).replace(
      "</Relationships>",
      `<Relationship Id="rNums" Type="${R}/numbering" Target="numbering.xml"/></Relationships>`
    );
    const source = await zip(parts),
      inspected = await inspectDocx(source);
    expect(inspected.listCandidates?.[0]).toMatchObject({
      kind: "decimal",
      marker: ")",
      start: 3,
    });
    const result = await repair(source, [listOp(inspected)]),
      output = await unzip(result.buffer);
    const numbering = output.get("word/numbering.xml")!.toString();
    expect(numbering).toContain('<w:start w:val="3"/>');
    expect(numbering).toContain('<w:lvlText w:val="%1)"/>');
    expect(numbering).toContain(
      originalDefinition.split("</w:abstractNum>")[0] + "</w:abstractNum>"
    );
    expect(numbering).toContain(
      '<w:num w:numId="8"><w:abstractNumId w:val="7"/></w:num>'
    );
    expect(
      result.inspection.paragraphs.every((p) => p.list?.numId === "9")
    ).toBe(true);
    expect(output.get("word/_rels/document.xml.rels")).toEqual(
      Buffer.from(parts["word/_rels/document.xml.rels"])
    );
    expect(output.get("[Content_Types].xml")).toEqual(
      Buffer.from(parts["[Content_Types].xml"])
    );
  });
  it("separates adjacent bullet and decimal candidates, but never silently renumbers a numeric jump", async () => {
    const source = await zip(
      entries(
        typedItem("●", "A") +
          typedItem("●", "B") +
          typedItem("3.", "C") +
          typedItem("4.", "D") +
          paragraph("Break") +
          typedItem("3.", "E") +
          typedItem("7.", "F") +
          typedItem("8.", "G")
      )
    );
    const inspection = await inspectDocx(source);
    expect(inspection.listCandidates?.map((c) => [c.kind, c.start])).toEqual([
      ["bullet", null],
      ["decimal", 3],
    ]);
    const result = await repair(source, [
      listOp(inspection),
      listOp(inspection, 1),
    ]);
    expect(
      result.inspection.paragraphs.slice(-3).map((p) => [p.text, p.list])
    ).toEqual(inspection.paragraphs.slice(-3).map((p) => [p.text, p.list]));
  });
  it("rejects prefix-in-hyperlink, dosage prose, singleton and native list candidates", async () => {
    const hyperlinkItem = (body: string) =>
      `<w:p><w:hyperlink r:id="rLink"><w:r><w:t>● ${body}</w:t></w:r></w:hyperlink></w:p>`;
    for (const body of [
      hyperlinkItem("A") + hyperlinkItem("B"),
      paragraph("1.5 mg daily") + paragraph("2.5 mg daily"),
      typedItem("●", "One"),
    ]) {
      expect(
        (await inspectDocx(await zip(entries(body)))).listCandidates
      ).toEqual([]);
    }
    const source = await zip(
      entries(typedItem("●", "A") + typedItem("●", "B"))
    );
    const inspection = await inspectDocx(source),
      result = await repair(source, [listOp(inspection)]);
    expect(result.inspection.listCandidates).toEqual([]);
  });
  it("requires exact complete list items and prevents conflicting changes to their paragraphs", async () => {
    const source = await zip(
      entries(typedItem("●", "A") + typedItem("●", "B") + typedItem("●", "C"))
    );
    const inspected = await inspectDocx(source),
      operation = listOp(inspected);
    if (operation.type !== "convertTypedList") throw Error("test operation");
    for (const items of [
      operation.items.slice(0, 2),
      operation.items.map((p, i) =>
        i ? p : { ...p, sourceText: "● Rewritten" }
      ),
      [...operation.items].reverse(),
    ])
      await expect(
        repair(source, [{ ...operation, items }])
      ).rejects.toHaveProperty("code", "docx_integrity");
    await expect(
      repair(source, [
        operation,
        {
          type: "setHeading",
          id: operation.items[1].paragraphId,
          level: 1,
          sourceText: operation.items[1].sourceText,
        },
      ])
    ).rejects.toHaveProperty("code", "docx_integrity");
    const reorderedKeys = {
      ...operation,
      items: operation.items.map((item) => ({
        sourceText: item.sourceText,
        paragraphId: item.paragraphId,
      })),
    };
    expect((await repair(source, [reorderedKeys])).changes).toHaveLength(1);
  });
  it("derives explicit table labels from exact ancestry, preserves data rows, and maps later paragraph identities", async () => {
    const sourceParts = entries(
      paragraph("Before") + groupedTable() + paragraph("After")
    );
    sourceParts["word/styles.xml"] = String(
      sourceParts["word/styles.xml"]
    ).replace(
      "</w:styles>",
      '<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders><w:insideH w:val="single" w:sz="4"/></w:tblBorders></w:tblPr></w:style></w:styles>'
    );
    const source = await zip(sourceParts),
      inspected = await inspectDocx(source),
      table = inspected.tables[0];
    expect(table.headerCandidate).toMatchObject({
      labels: ["Type", "Exams 1", "Exams 2"],
      headerRows: 2,
      gridWidthsTwips: [3000, 3000, 3000],
      headerHeightsTwips: [null, null],
    });
    const result = await repair(source, [
      { type: "simplifyTableHeaders", id: table.id, sourceCells: table.cells },
      {
        type: "setHeading",
        id: inspected.paragraphs.at(-1)!.id,
        sourceText: "After",
        level: 1,
      },
    ]);
    expect(result.inspection.tables[0]).toMatchObject({
      complex: false,
      firstRowHeader: true,
      cells: [
        ["Type", "Exams\n1", "Exams\n2"],
        ["15%", "20%", "65%"],
      ],
    });
    expect(result.inspection.paragraphs.at(-1)).toMatchObject({
      text: "After",
      headingLevel: 1,
      id: "word/document.xml:p:8",
    });
    expect(result.identityMap?.["word/document.xml:p:10"]).toBe(
      "word/document.xml:p:8"
    );
    expect(result.identityMap?.["word/document.xml:p:3"]).toBeNull();
    expect(result.identityMap?.["word/document.xml:p:4"]).toBeNull();
    expect(result.identityMap?.["word/document.xml:p:5"]).toBe(
      "word/document.xml:p:3"
    );
    const output = await unzip(result.buffer),
      xml = output.get("word/document.xml")!.toString();
    const sourceDataRow = groupedTable()
      .match(/<w:tr>[\s\S]*?<\/w:tr>/g)!
      .at(-1)!;
    expect(xml).toContain(sourceDataRow);
    expect(xml).toContain('<w:bottom w:w="10" w:type="dxa"/>');
    expect(xml).not.toContain("<w:vMerge");
    expect(xml).not.toContain("<w:gridSpan");
    expect(xml).toContain('<w:tblW w:w="9000" w:type="dxa"/>');
    expect(xml).toContain("<w:tblHeader/>");
    for (const [name, value] of Object.entries(sourceParts))
      if (name !== "word/document.xml")
        expect(output.get(name)).toEqual(Buffer.from(value));
  });
  it("leaves ambiguous headers and merged data cells ineligible, and rejects fabricated table data or overlapping header edits", async () => {
    for (const sourceTable of [
      groupedTable().replace('w:val="restart"', 'w:val="continue"'),
      groupedTable().replace("<w:t>2</w:t>", "<w:t>1</w:t>"),
      groupedTable()
        .replace("<w:t>65%</w:t>", "<w:t></w:t>")
        .replace(
          "<w:tc><w:p>",
          '<w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p>'
        ),
    ]) {
      const inspection = await inspectDocx(await zip(entries(sourceTable)));
      expect(inspection.tables[0].headerCandidate).toBeUndefined();
    }
    const source = await zip(entries(groupedTable())),
      inspection = await inspectDocx(source),
      table = inspection.tables[0];
    const op: DocxRepairOperation = {
      type: "simplifyTableHeaders",
      id: table.id,
      sourceCells: table.cells,
    };
    await expect(
      repair(source, [
        {
          ...op,
          sourceCells: table.cells.map((r, i) =>
            i === 2 ? r.map(() => "100%") : r
          ),
        },
      ])
    ).rejects.toHaveProperty("code", "docx_integrity");
    await expect(
      repair(source, [
        op,
        {
          type: "setLanguage",
          id: table.headerCandidate!.headerParagraphIds[1],
          tag: "en-US",
          sourceText: "Exams",
        },
      ])
    ).rejects.toHaveProperty("code", "docx_integrity");
    await expect(
      repair(source, [
        op,
        { type: "setTableHeader", id: table.id, headerTexts: table.cells[0] },
      ])
    ).rejects.toHaveProperty("code", "docx_integrity");
  });
  it("does not simplify headers containing annotation references or mixed mathematical character formatting", async () => {
    const annotations = [
      '<w:commentRangeStart w:id="1"/>',
      '<w:commentRangeEnd w:id="1"/>',
      '<w:commentReference w:id="1"/>',
      '<w:footnoteReference w:id="2"/>',
      '<w:endnoteReference w:id="2"/>',
    ];
    for (const marker of annotations) {
      const inspection = await inspectDocx(
        await zip(
          entries(
            groupedTable().replace(
              "<w:t>Exams</w:t>",
              `${marker}<w:t>Exams</w:t>`
            )
          )
        )
      );
      expect(inspection.tables[0].headerCandidate).toBeUndefined();
    }
    const mixedLabel = groupedTable().replace(
      paragraph("Exams"),
      '<w:p><w:r><w:t>CO</w:t></w:r><w:r><w:rPr><w:vertAlign w:val="subscript"/></w:rPr><w:t>2</w:t></w:r></w:p>'
    );
    expect(
      (await inspectDocx(await zip(entries(mixedLabel)))).tables[0]
        .headerCandidate
    ).toBeUndefined();
  });
  it("inventories stable paragraphs, tables and image anchors with inherited language", async () => {
    const inspection = await inspectDocx(await zip(entries()));
    expect(inspection.paragraphs).toHaveLength(7);
    expect(inspection.paragraphs[0]).toMatchObject({
      id: p1,
      text: "Course outline",
      styleId: "Normal",
      language: "en-US",
      headingLevel: null,
      formatting: { fontSizePt: 14, bold: true },
    });
    expect(inspection.tables[0]).toMatchObject({
      id: t1,
      cells: [
        ["Week", "Topic"],
        ["1", "Introduction"],
      ],
      complex: false,
      firstRowHeader: false,
    });
    expect(inspection.images[0]).toMatchObject({
      id: i1,
      inline: true,
      functional: false,
      editable: true,
      paragraphId: "word/document.xml:p:7",
    });
  });
  it("patches supported metadata, keeps source text, media, styles, sections and all untouched parts", async () => {
    const original = await zip(entries());
    const copy = Buffer.from(original);
    const result = await repair(original, [
      { type: "setHeading", id: p1, level: 1, sourceText: "Course outline" },
      { type: "setImageDescription", id: i1, text: "A tree beside a path." },
      { type: "setTableHeader", id: t1, headerTexts: ["Week", "Topic"] },
    ]);
    expect(original).toEqual(copy);
    expect(result.changes).toHaveLength(3);
    expect(result.inspection.paragraphs[0].headingLevel).toBe(1);
    expect(result.inspection.images[0].description).toBe(
      "A tree beside a path."
    );
    expect(result.inspection.tables[0].firstRowHeader).toBe(true);
    const before = await unzip(original);
    const after = await unzip(result.buffer);
    for (const [name, bytes] of before)
      if (name !== "word/document.xml") expect(after.get(name)).toEqual(bytes);
    const repaired = after.get("word/document.xml")!.toString();
    expect(repaired).toContain('<w:pStyle w:val="Normal"/>');
    expect(repaired).toContain('<w:spacing w:after="123"/>');
    expect(repaired).toContain('<w:pgSz w:w="12240" w:h="15840"/>');
    expect(repaired).toContain('<w:tblW w:w="5000" w:type="pct"/>');
    expect(result.findings.map((f) => f.code)).not.toContain(
      "docx_image_description_missing"
    );
  });
  it("returns the identical source bytes for a no-op plan", async () => {
    const original = await zip(entries());
    expect((await repair(original, [])).buffer).toBe(original);
  });
  it("does not add redundant operations to the actual change list", async () => {
    const original = await zip(entries());
    const first = await repair(original, [
      { type: "setHeading", id: p1, level: 1, sourceText: "Course outline" },
    ]);
    const second = await repair(first.buffer, [
      { type: "setHeading", id: p1, level: 1, sourceText: "Course outline" },
    ]);
    expect(second.changes).toEqual([]);
    expect(second.buffer).toBe(first.buffer);
  });
  it("sets exact paragraph language across runs without changing any wording or existing fonts", async () => {
    const original = await zip(
      entries(paragraph("Bonjour le monde.", "<w:rPr><w:i/></w:rPr>"))
    );
    const result = await repair(original, [
      {
        type: "setLanguage",
        id: p1,
        sourceText: "Bonjour le monde.",
        tag: "fr-FR",
      },
    ]);
    expect(result.inspection.paragraphs[0]).toMatchObject({
      language: "fr-FR",
      text: "Bonjour le monde.",
      formatting: { fontSizePt: 14, bold: true },
    });
    expect(result.changes[0]).toMatchObject({
      before: "en-US",
      after: "fr-FR",
    });
  });
  it("writes heading metadata before section and run properties in the schema order", async () => {
    const original = await zip(
      entries(
        paragraph(
          "Section",
          '<w:rPr><w:b/></w:rPr><w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr>'
        )
      )
    );
    const result = await repair(original, [
      { type: "setHeading", id: p1, level: 1, sourceText: "Section" },
    ]);
    const xml = (await unzip(result.buffer))
      .get("word/document.xml")!
      .toString();
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    const names = Array.from(doc.getElementsByTagNameNS(W, "pPr")[0].childNodes)
      .filter((n) => n.nodeType === 1)
      .map((n) => n.nodeName);
    expect(names).toEqual(["w:outlineLvl", "w:rPr", "w:sectPr"]);
  });
  it("recognizes inherited heading outline levels and preserves the original heading style", async () => {
    const parts = entries(
      paragraph("Subsection", '<w:pStyle w:val="MyHeading"/>')
    );
    parts["word/styles.xml"] = String(parts["word/styles.xml"]).replace(
      "</w:styles>",
      '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="MyHeading"><w:name w:val="Custom subsection"/><w:basedOn w:val="Heading2"/></w:style></w:styles>'
    );
    const source = await zip(parts);
    expect((await inspectDocx(source)).paragraphs[0].headingLevel).toBe(2);
    const result = await repair(source, [
      { type: "setHeading", id: p1, level: 1, sourceText: "Subsection" },
    ]);
    expect(result.inspection.paragraphs[0]).toMatchObject({
      headingLevel: 1,
      styleId: "MyHeading",
    });
    expect((await unzip(result.buffer)).get("word/styles.xml")).toEqual(
      (await unzip(source)).get("word/styles.xml")
    );
  });
  it("marks only a nonfunctional image with no authored alternative as decorative", async () => {
    const result = await repair(await zip(entries(picture())), [
      { type: "setDecorative", id: i1, decorative: true },
    ]);
    expect(result.inspection.images[0].decorative).toBe(true);
    expect(
      (await unzip(result.buffer)).get("word/document.xml")!.toString()
    ).toContain(
      'xmlns:adec="http://schemas.microsoft.com/office/drawing/2017/decorative"'
    );
    expect(result.findings.map((f) => f.code)).not.toContain(
      "docx_image_description_missing"
    );
  });
  it("rejects hiding a functional image", async () => {
    const source = await zip(
      entries(picture("", '<a:hlinkClick r:id="rImage"/>'))
    );
    expect((await inspectDocx(source)).images[0].functional).toBe(true);
    await expect(
      repair(source, [{ type: "setDecorative", id: i1, decorative: true }])
    ).rejects.toHaveProperty("code", "docx_integrity");
  });
  it.each(['descr="Authored description"', 'title="Authored title"'])(
    "preserves authored image alternatives (%s)",
    async (attributes) => {
      const source = await zip(entries(picture(attributes)));
      await expect(
        repair(source, [
          { type: "setImageDescription", id: i1, text: "Replacement" },
        ])
      ).rejects.toHaveProperty("code", "docx_integrity");
      await expect(
        repair(source, [{ type: "setDecorative", id: i1, decorative: true }])
      ).rejects.toHaveProperty("code", "docx_integrity");
    }
  );
  it("reports merged tables and refuses to pretend their first row is a simple header", async () => {
    const source = await zip(entries(table('<w:gridSpan w:val="2"/>')));
    const inspection = await inspectDocx(source);
    expect(inspection.tables[0].complex).toBe(true);
    expect(checkDocxAccessibility(inspection).map((f) => f.code)).toContain(
      "docx_complex_table"
    );
    await expect(
      repair(source, [
        { type: "setTableHeader", id: t1, headerTexts: ["Week", "Topic"] },
      ])
    ).rejects.toHaveProperty("code", "docx_integrity");
  });
  it("guards heading source text, exact header cells, valid object kinds, and full coverage", async () => {
    const source = await zip(entries());
    for (const op of [
      { type: "setHeading", id: p1, sourceText: "Wrong paragraph", level: 1 },
      { type: "setTableHeader", id: t1, headerTexts: ["Renamed", "Topic"] },
      { type: "setHeading", id: i1, sourceText: "Course outline", level: 1 },
    ] as DocxRepairOperation[])
      await expect(repair(source, [op])).rejects.toHaveProperty(
        "code",
        "docx_integrity"
      );
    const plan = buildDocxMechanicalPlan(await inspectDocx(source));
    plan.reviewedParagraphIds.pop();
    await expect(applyDocxRepairs(source, plan)).rejects.toHaveProperty(
      "code",
      "docx_integrity"
    );
  });
  it("includes ordinary header stories without inventing a review warning", async () => {
    const parts = entries();
    parts["word/header1.xml"] =
      `<w:hdr xmlns:w="${W}">${paragraph("Header text")}</w:hdr>`;
    parts["word/_rels/document.xml.rels"] = String(
      parts["word/_rels/document.xml.rels"]
    ).replace(
      "</Relationships>",
      `<Relationship Id="rHeader" Type="${R}/header" Target="header1.xml"/></Relationships>`
    );
    const source = await zip(parts);
    const inspection = await inspectDocx(source);
    expect(
      inspection.paragraphs.find((p) => p.partName === "word/header1.xml")
    ).toMatchObject({ text: "Header text", editable: false });
    expect(inspection.findings.map((f) => f.code)).not.toContain(
      "docx_story_review"
    );
    const result = await repair(source, [
      { type: "setHeading", id: p1, level: 1, sourceText: "Course outline" },
    ]);
    expect((await unzip(result.buffer)).get("word/header1.xml")).toEqual(
      (await unzip(source)).get("word/header1.xml")
    );
  });
  it("preserves fields, tracked changes, and content controls with an honest coverage warning", async () => {
    const body = `<w:sdt><w:sdtContent>${paragraph("Inside control")}</w:sdtContent></w:sdt><w:p><w:ins>${paragraph("Tracked text")}</w:ins></w:p>`;
    const source = await zip(entries(body));
    const inspection = await inspectDocx(source);
    expect(inspection.paragraphs.every((p) => !p.editable)).toBe(true);
    expect(inspection.findings.map((f) => f.code)).toContain(
      "docx_unsupported_control"
    );
    expect(inspection.findings.map((f) => f.code)).toContain(
      "docx_unsupported_tracked_change"
    );
    await expect(
      repair(source, [
        { type: "setHeading", id: p1, level: 1, sourceText: "Inside control" },
      ])
    ).rejects.toHaveProperty("code", "docx_integrity");
  });
  it("rejects external embedded assets before they can reach a renderer", async () => {
    const parts = entries();
    parts["word/_rels/document.xml.rels"] = String(
      parts["word/_rels/document.xml.rels"]
    ).replace(
      "</Relationships>",
      `<Relationship Id="rLinked" Type="${R}/image" Target="https://untrusted.invalid/picture" TargetMode="External"/></Relationships>`
    );
    const source = await zip(parts);
    await expect(inspectDocx(source)).rejects.toHaveProperty(
      "code",
      "docx_unsupported"
    );
  });
  it("preserves external hyperlinks without fetching them", async () => {
    const parts = entries();
    parts["word/_rels/document.xml.rels"] = String(
      parts["word/_rels/document.xml.rels"]
    ).replace(
      "</Relationships>",
      `<Relationship Id="rLink" Type="${R}/hyperlink" Target="https://untrusted.invalid/page" TargetMode="External"/></Relationships>`
    );
    const source = await zip(parts);
    expect((await repair(source, [])).buffer).toBe(source);
  });
  it("rejects external assets disguised as hyperlink relationships", async () => {
    const parts = entries();
    parts["word/_rels/document.xml.rels"] = String(
      parts["word/_rels/document.xml.rels"]
    ).replace(
      `Type="${R}/image" Target="media/picture.png"`,
      `Type="${R}/hyperlink" Target="https://untrusted.invalid/image.png" TargetMode="External"`
    );
    await expect(inspectDocx(await zip(parts))).rejects.toHaveProperty(
      "code",
      "docx_unsupported"
    );
  });
  it("does not flag ordinary page-number fields but identifies unsupported fields precisely", async () => {
    const page = `<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`;
    expect((await inspectDocx(await zip(entries(page)))).findings).toEqual([]);
    const unsupported = await inspectDocx(
      await zip(entries(page.replace(" PAGE ", " TOC ")))
    );
    expect(unsupported.findings[0]).toMatchObject({
      code: "docx_unsupported_field",
      location: "Document, paragraph 1",
      objectId: p1,
    });
    expect(unsupported.findings[0].message).toContain("automatic field");
  });
  it("writes the schema-valid OnOffOnly table flag without a boolean value", async () => {
    const result = await repair(await zip(entries()), [
      { type: "setTableHeader", id: t1, headerTexts: ["Week", "Topic"] },
    ]);
    const xml = (await unzip(result.buffer))
      .get("word/document.xml")!
      .toString();
    expect(xml).toContain("<w:tblHeader/>");
  });
  it("distinguishes inherited, direct, and explicitly disabled native list numbering", async () => {
    const parts = entries(
      paragraph("Inherited bullet", '<w:pStyle w:val="ChildBullet"/>') +
        paragraph(
          "Nested item",
          '<w:pStyle w:val="ChildBullet"/><w:numPr><w:ilvl w:val="1"/></w:numPr>'
        ) +
        paragraph(
          "Explicitly not a list",
          '<w:pStyle w:val="ChildBullet"/><w:numPr><w:numId w:val="0"/></w:numPr>'
        ) +
        paragraph("Typed 1. example")
    );
    parts["word/styles.xml"] = String(parts["word/styles.xml"]).replace(
      "</w:styles>",
      '<w:style w:type="paragraph" w:styleId="BaseBullet"><w:name w:val="Base bullet"/><w:basedOn w:val="Normal"/><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="7"/></w:numPr></w:pPr></w:style><w:style w:type="paragraph" w:styleId="ChildBullet"><w:name w:val="Inherited bullet style"/><w:basedOn w:val="BaseBullet"/></w:style></w:styles>'
    );
    parts["word/numbering.xml"] =
      `<w:numbering xmlns:w="${W}"><w:abstractNum w:abstractNumId="3"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="decimal"/><w:lvlText w:val="%1.%2."/></w:lvl></w:abstractNum><w:num w:numId="7"><w:abstractNumId w:val="3"/></w:num></w:numbering>`;
    parts["word/_rels/document.xml.rels"] = String(
      parts["word/_rels/document.xml.rels"]
    ).replace(
      "</Relationships>",
      `<Relationship Id="rNumbering" Type="${R}/numbering" Target="numbering.xml"/></Relationships>`
    );
    const inspection = await inspectDocx(await zip(parts));
    expect(inspection.paragraphs[0].list).toEqual({
      numId: "7",
      level: 0,
      format: "bullet",
      markerText: "•",
    });
    expect(inspection.paragraphs[1].list).toEqual({
      numId: "7",
      level: 1,
      format: "decimal",
      markerText: "%1.%2.",
    });
    expect(inspection.paragraphs[2].list).toBeNull();
    expect(inspection.paragraphs[3].list).toBeNull();
  });
  it("uses explicit numbering overrides without changing numbering XML", async () => {
    const parts = entries(
      paragraph(
        "Direct list",
        '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="4"/></w:numPr>'
      )
    );
    parts["word/numbering.xml"] =
      `<w:numbering xmlns:w="${W}"><w:abstractNum w:abstractNumId="2"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum><w:num w:numId="4"><w:abstractNumId w:val="2"/><w:lvlOverride w:ilvl="0"><w:lvl w:ilvl="0"><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="%1)"/></w:lvl></w:lvlOverride></w:num></w:numbering>`;
    parts["word/_rels/document.xml.rels"] = String(
      parts["word/_rels/document.xml.rels"]
    ).replace(
      "</Relationships>",
      `<Relationship Id="rNumbering" Type="${R}/numbering" Target="numbering.xml"/></Relationships>`
    );
    const source = await zip(parts);
    const inspection = await inspectDocx(source);
    expect(inspection.paragraphs[0].list).toEqual({
      numId: "4",
      level: 0,
      format: "lowerLetter",
      markerText: "%1)",
    });
    expect((await repair(source, [])).buffer).toBe(source);
  });
});

describe("Word package and plan safety", () => {
  it.each([
    "INCLUDEPICTURE",
    "INCLUDETEXT",
    "DDE",
    "DDEAUTO",
    "LINK",
    "DATABASE",
    "RD",
    "IMPORT",
  ])(
    "rejects %s fields before rendering even without external relationships",
    async (command) => {
      const source = await zip(
        entries(
          `<w:p><w:fldSimple w:instr="${command} &quot;file:///private/source&quot;"><w:r><w:t>Cached result</w:t></w:r></w:fldSimple></w:p>`
        )
      );
      await expect(inspectDocx(source)).rejects.toHaveProperty(
        "code",
        "docx_unsupported"
      );
    }
  );
  it("rejects external field instructions split across runs or nested inside a safe field", async () => {
    const nested =
      '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>INCLUDE</w:instrText></w:r><w:r><w:instrText>PICTURE &quot;https://invalid.test/image&quot;</w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>';
    for (const body of [
      `<w:p>${nested}</w:p>`,
      `<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> IF </w:instrText></w:r>${nested}<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`,
    ])
      await expect(
        inspectDocx(await zip(entries(body)))
      ).rejects.toHaveProperty("code", "docx_unsupported");
  });
  it("allows a hyperlink field while preserving it verbatim", async () => {
    const source = await zip(
      entries(
        '<w:p><w:fldSimple w:instr="HYPERLINK &quot;https://www.w3.org/WAI/&quot;"><w:r><w:t>Accessibility guidance</w:t></w:r></w:fldSimple></w:p>'
      )
    );
    expect((await repair(source, [])).buffer).toBe(source);
  });
  it.each([
    Buffer.alloc(0),
    Buffer.from("not a zip"),
    Buffer.from([0x50, 0x4b, 3, 4, 0]),
  ])("rejects empty, encrypted-style, or corrupt uploads", async (buffer) => {
    await expect(inspectDocx(buffer)).rejects.toHaveProperty(
      "name",
      "DocxPackageError"
    );
  });
  it("rejects file size before parsing", async () => {
    await expect(
      inspectDocx(Buffer.alloc(4 * 1024 * 1024 + 1))
    ).rejects.toHaveProperty("code", "docx_size_limit");
  });
  it.each([
    "<!DOCTYPE w:document [<!ENTITY x 'secret'>]>",
    "<!DOCTYPE w:document SYSTEM 'https://invalid.local/evil'>",
  ])("rejects XML entity/DTD declarations", async (declaration) => {
    const parts = entries();
    parts["word/document.xml"] = String(parts["word/document.xml"]).replace(
      "<w:document",
      `${declaration}<w:document`
    );
    await expect(inspectDocx(await zip(parts))).rejects.toHaveProperty(
      "code",
      "docx_invalid"
    );
  });
  it("validates XML in otherwise untouched parts", async () => {
    const parts = entries();
    parts["customXml/item1.xml"] = "<broken>";
    await expect(inspectDocx(await zip(parts))).rejects.toHaveProperty(
      "code",
      "docx_invalid"
    );
  });
  it("rejects macro-enabled and signed packages", async () => {
    for (const name of ["word/vbaProject.bin", "_xmlsignatures/sig1.xml"]) {
      const parts = entries();
      parts[name] = name.endsWith("xml")
        ? "<Signature/>"
        : Buffer.from("macro");
      await expect(inspectDocx(await zip(parts))).rejects.toHaveProperty(
        "code",
        name.endsWith("xml") ? "docx_signed" : "docx_unsupported"
      );
    }
  });
  it("rejects a macro main content type even without a VBA entry", async () => {
    const parts = entries();
    parts["[Content_Types].xml"] = String(parts["[Content_Types].xml"]).replace(
      MAIN_TYPE,
      "application/vnd.ms-word.document.macroEnabled.main+xml"
    );
    await expect(inspectDocx(await zip(parts))).rejects.toHaveProperty(
      "code",
      "docx_unsupported"
    );
  });
  it("rejects document protection", async () => {
    const parts = entries();
    parts["word/settings.xml"] =
      `<w:settings xmlns:w="${W}"><w:documentProtection w:edit="readOnly" w:enforcement="1"/></w:settings>`;
    parts["word/_rels/document.xml.rels"] = String(
      parts["word/_rels/document.xml.rels"]
    ).replace(
      "</Relationships>",
      `<Relationship Id="rSettings" Type="${R}/settings" Target="settings.xml"/></Relationships>`
    );
    await expect(inspectDocx(await zip(parts))).rejects.toHaveProperty(
      "code",
      "docx_unsupported"
    );
  });
  it("rejects dangling or escaping relationships", async () => {
    for (const target of [
      "missing.xml",
      "../../outside.xml",
      "http://untrusted.test/file",
    ]) {
      const parts = entries();
      parts["word/_rels/document.xml.rels"] = String(
        parts["word/_rels/document.xml.rels"]
      ).replace('Target="styles.xml"', `Target="${target}"`);
      await expect(inspectDocx(await zip(parts))).rejects.toHaveProperty(
        "code",
        "docx_invalid"
      );
    }
  });
  it("rejects duplicate case-folded package names", async () => {
    const parts = entries();
    parts["Word/document.xml"] = parts["word/document.xml"];
    await expect(inspectDocx(await zip(parts))).rejects.toHaveProperty(
      "code",
      "docx_invalid"
    );
  });
  it("rejects cycles in style inheritance", async () => {
    const parts = entries();
    parts["word/styles.xml"] = String(parts["word/styles.xml"]).replace(
      '<w:name w:val="Normal"/>',
      '<w:name w:val="Normal"/><w:basedOn w:val="Normal"/>'
    );
    await expect(inspectDocx(await zip(parts))).rejects.toHaveProperty(
      "code",
      "docx_invalid"
    );
  });
  it.each([
    { type: "replaceXml", id: p1, xml: "<evil/>" },
    { type: "setHeading", id: p1, level: 7, sourceText: "Course outline" },
    {
      type: "setHeading",
      id: p1,
      level: 1,
      sourceText: "Course outline",
      extra: "hidden",
    },
    {
      type: "setHeading",
      id: "../../document.xml:p:1",
      level: 1,
      sourceText: "Course outline",
    },
    { type: "setImageDescription", id: i1, text: "Bad\u0000value" },
    {
      type: "setLanguage",
      id: p1,
      tag: "not a language",
      sourceText: "Course outline",
    },
    { type: "setDecorative", id: i1, decorative: false },
    { type: "setTableHeader", id: t1, headerTexts: ["", "Topic"] },
  ])("rejects unsafe plan operation $type", (operation) => {
    expect(() =>
      validateDocxRepairPlan({
        reviewedParagraphIds: [],
        reviewedTableIds: [],
        reviewedImageIds: [],
        operations: [operation],
      })
    ).toThrow();
  });
  it("rejects duplicate and conflicting operations or review IDs", () => {
    const base = {
      reviewedParagraphIds: [p1],
      reviewedTableIds: [],
      reviewedImageIds: [i1],
      operations: [] as unknown[],
    };
    expect(() =>
      validateDocxRepairPlan({ ...base, reviewedParagraphIds: [p1, p1] })
    ).toThrow();
    const op = {
      type: "setHeading",
      id: p1,
      level: 1,
      sourceText: "Course outline",
    };
    expect(() =>
      validateDocxRepairPlan({ ...base, operations: [op, op] })
    ).toThrow();
    expect(() =>
      validateDocxRepairPlan({
        ...base,
        operations: [
          { type: "setDecorative", id: i1, decorative: true },
          { type: "setImageDescription", id: i1, text: "Description" },
        ],
      })
    ).toThrow();
  });
});
