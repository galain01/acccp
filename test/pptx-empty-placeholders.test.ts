import { describe, expect, it } from "vitest";
import { DOMParser } from "@xmldom/xmldom";
import {
  applyPptxRepairs,
  inspectPptx,
  validatePptxRepairPlan,
} from "../lib/pptx-package";
import { pptxElementHash } from "../lib/pptx-table-caption";
import {
  A,
  P,
  R,
  imageFixture,
  pictureXml,
  unzipParts,
  zipParts,
} from "./pptx-image-fixture";

const CREATION =
  '<a:extLst><a:ext uri="{FF2B5EF4-FFF2-40B4-BE49-F238E27FC236}"><a16:creationId xmlns:a16="http://schemas.microsoft.com/office/drawing/2014/main" id="{E6B77F2C-9EC6-6540-84E0-C273D0DDD337}"/></a:ext></a:extLst>';
const EMPTY_BODY =
  '<a:bodyPr><a:noAutofit/></a:bodyPr><a:lstStyle/><a:p><a:pPr marL="0" indent="0"><a:buNone/></a:pPr><a:endParaRPr lang="en-US" sz="1800"/></a:p>';
const modId =
  '<p:extLst><p:ext uri="{D42A27DB-BD31-4B8C-83A1-F6EECF244321}"><p14:modId xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main" val="3790183785"/></p:ext></p:extLst>';
const colId =
  '<a:extLst><a:ext uri="{9D8B030D-6E8A-4147-A177-3AD203B41FA5}"><a16:colId xmlns:a16="http://schemas.microsoft.com/office/drawing/2014/main" val="2527190168"/></a:ext></a:extLst>';
const rowId =
  '<a:extLst><a:ext uri="{0D108BD9-81ED-4DB2-BD59-A6C34878D82A}"><a16:rowId xmlns:a16="http://schemas.microsoft.com/office/drawing/2014/main" val="2322556143"/></a:ext></a:extLst>';
const slideCreationId =
  '<p:extLst><p:ext uri="{BB962C8B-B14F-4D97-AF65-F5344CB8AC3E}"><p14:creationId xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main" val="1743990211"/></p:ext></p:extLst>';
const nativeTable = (rowMetadata = rowId) =>
  `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="4" name="Schedule table"/><p:cNvGraphicFramePr/><p:nvPr>${modId}</p:nvPr></p:nvGraphicFramePr><p:xfrm><a:off x="100000" y="1000000"/><a:ext cx="5000000" cy="1000000"/></p:xfrm><a:graphic><a:graphicData uri="${A}/table"><a:tbl><a:tblPr firstRow="1"/><a:tblGrid><a:gridCol w="5000000">${colId}</a:gridCol></a:tblGrid><a:tr h="1000000"><a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Week 1: Chapter 1</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc>${rowMetadata}</a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
function empty(
  id = 3,
  options: {
    body?: string;
    shape?: string;
    ph?: string;
    properties?: string;
    metadata?: string;
    extra?: string;
    noBody?: boolean;
  } = {}
) {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Content Placeholder ${id}" ${options.properties ?? ""}>${options.metadata ?? ""}</p:cNvPr><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr>${options.ph ?? '<p:ph idx="1"/>'}</p:nvPr></p:nvSpPr><p:spPr>${options.shape ?? ""}</p:spPr>${options.noBody ? "" : `<p:txBody>${options.body ?? EMPTY_BODY}</p:txBody>`}${options.extra ?? ""}</p:sp>`;
}
const removal = (ids = ["3"]) => ({
  slides: [{ slideNumber: 1, removeEmptyPlaceholders: ids }],
});
const candidate = (
  inspection: Awaited<ReturnType<typeof inspectPptx>>,
  id = "3"
) => inspection.slides[0].objects.find((object) => object.id === id)!;

async function deck(
  options: {
    content?: string;
    hidden?: boolean;
    secondSlide?: boolean;
    layout?: string;
    master?: string;
    timing?: string;
    relationships?: string;
    extraParts?: [string, string][];
  } = {}
) {
  const templateParts: [string, string][] = [];
  let relationships = options.relationships ?? "";
  if (options.layout !== undefined || options.master !== undefined) {
    relationships += `<Relationship Id="rLayout" Type="${R}/slideLayout" Target="../slideLayouts/layout.xml"/>`;
    templateParts.push([
      "ppt/slideLayouts/layout.xml",
      `<p:sldLayout xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}"><p:cSld><p:spTree>${options.layout ?? empty(8)}</p:spTree></p:cSld></p:sldLayout>`,
    ]);
    if (options.master !== undefined)
      templateParts.push(
        [
          "ppt/slideLayouts/_rels/layout.xml.rels",
          `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rMaster" Type="${R}/slideMaster" Target="../slideMasters/master.xml"/></Relationships>`,
        ],
        [
          "ppt/slideMasters/master.xml",
          `<p:sldMaster xmlns:p="${P}" xmlns:a="${A}"><p:cSld><p:spTree>${options.master}</p:spTree></p:cSld></p:sldMaster>`,
        ]
      );
  }
  const parts = await unzipParts(
    await imageFixture({
      picture: options.content ?? empty(),
      timing: options.timing,
      extraRelationships: relationships,
      extraParts: [...templateParts, ...(options.extraParts ?? [])],
    })
  );
  if (options.hidden)
    parts.set(
      "ppt/slides/slide1.xml",
      Buffer.from(
        parts
          .get("ppt/slides/slide1.xml")!
          .toString()
          .replace("<p:sld ", '<p:sld show="0" ')
      )
    );
  if (options.secondSlide) {
    parts.set(
      "ppt/slides/slide2.xml",
      Buffer.from(
        parts
          .get("ppt/slides/slide1.xml")!
          .toString()
          .replace("<p:sld ", '<p:sld show="0" ')
      )
    );
    parts.set(
      "ppt/slides/_rels/slide2.xml.rels",
      parts.get("ppt/slides/_rels/slide1.xml.rels")!
    );
    parts.set(
      "ppt/presentation.xml",
      Buffer.from(
        parts
          .get("ppt/presentation.xml")!
          .toString()
          .replace(
            "</p:sldIdLst>",
            '<p:sldId id="257" r:id="rSecond"/></p:sldIdLst>'
          )
      )
    );
    parts.set(
      "ppt/_rels/presentation.xml.rels",
      Buffer.from(
        parts
          .get("ppt/_rels/presentation.xml.rels")!
          .toString()
          .replace(
            "</Relationships>",
            `<Relationship Id="rSecond" Type="${R}/slide" Target="slides/slide2.xml"/></Relationships>`
          )
      )
    );
    parts.set(
      "[Content_Types].xml",
      Buffer.from(
        parts
          .get("[Content_Types].xml")!
          .toString()
          .replace(
            "</Types>",
            '<Override PartName="/ppt/slides/slide2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>'
          )
      )
    );
  }
  return zipParts([...parts]);
}

describe("deterministic empty PowerPoint placeholder removal", () => {
  it("recognizes native table and slide bookkeeping while preserving the actual schedule table", async () => {
    const parts = await unzipParts(
      await deck({ content: empty(3, { metadata: CREATION }) + nativeTable() })
    );
    parts.set(
      "ppt/slides/slide1.xml",
      Buffer.from(
        parts
          .get("ppt/slides/slide1.xml")!
          .toString()
          .replace("</p:cSld>", `${slideCreationId}</p:cSld>`)
      )
    );
    const source = await zipParts([...parts]);
    expect(candidate(await inspectPptx(source)).emptyPlaceholder).toBe(true);
    const result = await applyPptxRepairs(source, removal(), {
      revisioned: true,
    });
    expect(result.changes).toHaveLength(1);
    expect(
      result.inspection.slides[0].objects.map((object) => object.id)
    ).toEqual(["2", "4"]);
    expect(candidate(result.inspection, "4").table?.cells).toEqual([
      ["Week 1: Chapter 1"],
    ]);
    const before = new DOMParser().parseFromString(
      parts.get("ppt/slides/slide1.xml")!.toString(),
      "application/xml"
    );
    const after = new DOMParser().parseFromString(
      (await unzipParts(result.buffer))
        .get("ppt/slides/slide1.xml")!
        .toString(),
      "application/xml"
    );
    expect(
      pptxElementHash(after.getElementsByTagNameNS(P, "graphicFrame")[0])
    ).toBe(
      pptxElementHash(before.getElementsByTagNameNS(P, "graphicFrame")[0])
    );
    expect(
      after
        .getElementsByTagNameNS(
          "http://schemas.microsoft.com/office/powerpoint/2010/main",
          "creationId"
        )[0]
        .getAttribute("val")
    ).toBe("1743990211");
  });

  it.each([
    rowId.replace("{0D108BD9-81ED-4DB2-BD59-A6C34878D82A}", "urn:unknown"),
    rowId.replace('val="2322556143"', 'val="2322556143" target="3"'),
    rowId.replace('val="2322556143"', 'val="4294967296"'),
    rowId.replace(
      "http://schemas.microsoft.com/office/drawing/2014/main",
      "urn:unknown"
    ),
    rowId.replace(
      "/></a:ext>",
      '><a:stCxn id="3" idx="0"/></a16:rowId></a:ext>'
    ),
    rowId.replace("<a:extLst>", '<a:extLst opaque="authored">'),
    rowId.replace("<a:ext uri=", '<a:ext opaque="authored" uri='),
    rowId.replace("<a:extLst>", "<a:extLst>Opaque authored text"),
    rowId.replace("</a:ext>", "<![CDATA[Opaque authored text]]></a:ext>"),
  ])(
    "keeps unknown or reference-bearing payloads protected even when they resemble table bookkeeping",
    async (rowMetadata) => {
      const source = await deck({
        content: empty() + nativeTable(rowMetadata),
      });
      expect(
        candidate(await inspectPptx(source)).emptyPlaceholder
      ).toBeUndefined();
      expect(
        (await applyPptxRepairs(source, removal(), { revisioned: true })).buffer
      ).toEqual(source);
    }
  );

  it.each([
    CREATION.replace("<a:extLst>", '<a:extLst opaque="authored">'),
    CREATION.replace("<a:ext uri=", '<a:ext opaque="authored" uri='),
    CREATION.replace("<a:extLst>", "<a:extLst>Opaque authored text"),
    CREATION.replace("</a:ext>", "<![CDATA[Opaque authored text]]></a:ext>"),
    CREATION.replace(
      "/></a:ext>",
      ">Opaque authored text</a16:creationId></a:ext>"
    ),
  ])(
    "protects unexpected data in standard creation metadata",
    async (metadata) => {
      const source = await deck({ content: empty(3, { metadata }) });
      expect(
        candidate(await inspectPptx(source)).emptyPlaceholder
      ).toBeUndefined();
      expect(
        (await applyPptxRepairs(source, removal(), { revisioned: true })).buffer
      ).toEqual(source);
    }
  );

  it("removes only a verified unused slot and preserves every remaining source object, part and original file", async () => {
    const source = await deck({
      content:
        empty(3, { metadata: CREATION }) +
        pictureXml({ id: 4, description: "Keep this image." }),
      layout: empty(8, {
        body: "<a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Click to edit Master text styles</a:t></a:r></a:p>",
      }),
      master: empty(9, {
        ph: '<p:ph type="body" idx="1"/>',
        shape: '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>',
      }),
    });
    expect(candidate(await inspectPptx(source)).emptyPlaceholder).toBe(true);
    const result = await applyPptxRepairs(source, removal(), {
      revisioned: true,
    });
    expect(
      result.inspection.slides[0].objects.map((object) => object.id)
    ).toEqual(["2", "4"]);
    expect(result.changes).toEqual([
      expect.objectContaining({
        type: "empty-placeholder",
        slideNumber: 1,
        objectId: "3",
        operationId: "1:empty-placeholder:3",
      }),
    ]);
    const before = await unzipParts(source),
      after = await unzipParts(result.buffer);
    for (const [name, bytes] of before)
      if (name !== "ppt/slides/slide1.xml")
        expect(after.get(name), name).toEqual(bytes);
    const originalXml = new DOMParser().parseFromString(
      before.get("ppt/slides/slide1.xml")!.toString(),
      "application/xml"
    );
    const emptyShape = Array.from(
      originalXml.getElementsByTagNameNS(P, "sp")
    ).find(
      (shape) =>
        shape.getElementsByTagNameNS(P, "cNvPr")[0].getAttribute("id") === "3"
    )!;
    emptyShape.parentNode!.removeChild(emptyShape);
    const outputXml = new DOMParser().parseFromString(
      after.get("ppt/slides/slide1.xml")!.toString(),
      "application/xml"
    );
    expect(pptxElementHash(outputXml.documentElement!)).toBe(
      pptxElementHash(originalXml.documentElement!)
    );
    expect(candidate(await inspectPptx(source)).emptyPlaceholder).toBe(true);
  });

  it("removes eligible placeholders on all requested slides while preserving hidden state", async () => {
    const source = await deck({
      secondSlide: true,
      content:
        empty(3) + empty(4, { ph: '<p:ph type="pic" idx="2"/>', noBody: true }),
    });
    const result = await applyPptxRepairs(
      source,
      {
        slides: [1, 2].map((slideNumber) => ({
          slideNumber,
          removeEmptyPlaceholders: ["3", "4"],
        })),
      },
      { revisioned: true }
    );
    expect(result.changes).toHaveLength(4);
    expect(
      result.inspection.slides.map((slide) => ({
        hidden: slide.hidden,
        ids: slide.objects.map((object) => object.id),
      }))
    ).toEqual([
      { hidden: false, ids: ["2"] },
      { hidden: true, ids: ["2"] },
    ]);
  });

  it("accepts normal creation identifiers reused on another object without mistaking them for a reference", async () => {
    const source = await deck({
      content:
        empty(3, { metadata: CREATION }) +
        empty(4, {
          metadata: CREATION,
          body: "<a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Real teaching content</a:t></a:r></a:p>",
        }),
    });
    const result = await applyPptxRepairs(source, removal(), {
      revisioned: true,
    });
    expect(result.changes).toHaveLength(1);
    expect(candidate(result.inspection, "4").text).toBe(
      "Real teaching content"
    );
  });

  it("composes a full-original reading order with removal without reinserting the removed placeholder", async () => {
    const source = await deck({
      content: empty(3) + pictureXml({ id: 4 }) + pictureXml({ id: 5 }),
    });
    const result = await applyPptxRepairs(
      source,
      {
        slides: [
          { ...removal().slides[0], readingOrder: ["2", "5", "4", "3"] },
        ],
      },
      { revisioned: true }
    );
    expect(
      result.inspection.slides[0].objects.map((object) => object.id)
    ).toEqual(["2", "5", "4"]);
    expect(result.changes.map((change) => change.type)).toEqual([
      "reading-order",
      "empty-placeholder",
    ]);
    const noDelete = await applyPptxRepairs(
      source,
      { slides: [{ slideNumber: 1, readingOrder: ["2", "3", "5", "4"] }] },
      { revisioned: true }
    );
    expect(candidate(noDelete.inspection).emptyPlaceholder).toBe(true);
  });

  it("requires explicit revision mode and never treats an unrequested empty slot as permission to delete", async () => {
    const source = await deck();
    expect((await applyPptxRepairs(source, removal())).buffer).toEqual(source);
    expect(
      (
        await applyPptxRepairs(
          source,
          { slides: [{ slideNumber: 1 }] },
          { revisioned: true }
        )
      ).buffer
    ).toEqual(source);
  });

  it.each([
    {
      label: "authored text",
      content: empty(3, {
        body: "<a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Keep this</a:t></a:r></a:p>",
      }),
    },
    {
      label: "blank dynamic field",
      content: empty(3, {
        body: '<a:bodyPr/><a:lstStyle/><a:p><a:fld id="{field}" type="slidenum"><a:t/></a:fld></a:p>',
      }),
    },
    {
      label: "authored alternative",
      content: empty(3, { properties: 'descr="Important description"' }),
    },
    {
      label: "authored alternate title",
      content: empty(3, { properties: 'title="Important title"' }),
    },
    {
      label: "click action",
      content: empty(3, {
        metadata:
          '<a:hlinkClick action="ppaction://hlinkshowjump?jump=nextslide"/>',
      }),
    },
    {
      label: "hover action",
      content: empty(3, {
        metadata:
          '<a:hlinkHover action="ppaction://hlinkshowjump?jump=nextslide"/>',
      }),
    },
    { label: "image", content: pictureXml({ id: 3 }) },
    { label: "ordinary text box", content: empty(3, { ph: "" }) },
    {
      label: "visible fill",
      content: empty(3, {
        shape: '<a:solidFill><a:srgbClr val="FF0000"/></a:solidFill>',
      }),
    },
    {
      label: "visible line",
      content: empty(3, { shape: '<a:ln w="12700"/>' }),
    },
    {
      label: "custom geometry",
      content: empty(3, {
        shape: '<a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom>',
      }),
    },
    {
      label: "visible effect",
      content: empty(3, {
        shape: '<a:effectLst><a:outerShdw blurRad="12700"/></a:effectLst>',
      }),
    },
    {
      label: "theme shape style",
      content: empty(3, {
        extra:
          '<p:style><a:fillRef idx="1"><a:schemeClr val="accent1"/></a:fillRef></p:style>',
      }),
    },
    {
      label: "unknown extension",
      content: empty(3, {
        metadata:
          '<a:extLst><a:ext uri="urn:custom"><custom:payload xmlns:custom="urn:custom"/></a:ext></a:extLst>',
      }),
    },
    {
      label: "grouped object",
      content: `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="8" name="Group"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${empty()}</p:grpSp>`,
    },
    ...["dt", "ftr", "hdr", "sldNum"].map((type) => ({
      label: `${type} functional placeholder`,
      content: empty(3, { ph: `<p:ph type="${type}" idx="1"/>` }),
    })),
  ])("retains $label despite a forged removal request", async ({ content }) => {
    const source = await deck({ content });
    expect(
      candidate(await inspectPptx(source)).emptyPlaceholder
    ).toBeUndefined();
    const result = await applyPptxRepairs(source, removal(), {
      revisioned: true,
    });
    expect(result.buffer).toEqual(source);
    expect(result.changes).toEqual([]);
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        code: "empty-placeholder-review",
        objectId: "3",
      })
    );
  });

  it.each([
    {
      label: "layout fill",
      layout: empty(8, {
        shape: '<a:solidFill><a:srgbClr val="FF0000"/></a:solidFill>',
      }),
    },
    {
      label: "master fill",
      master: empty(9, {
        ph: '<p:ph type="body" idx="1"/>',
        shape: '<a:solidFill><a:srgbClr val="FF0000"/></a:solidFill>',
      }),
    },
    {
      label: "layout field",
      layout: empty(8, {
        body: '<a:bodyPr/><a:lstStyle/><a:p><a:fld id="{field}" type="slidenum"><a:t/></a:fld></a:p>',
      }),
    },
    {
      label: "inherited authored description",
      layout: empty(8, { properties: 'descr="Keep this meaning"' }),
    },
    {
      label: "inherited image",
      layout: pictureXml({ id: 8 }).replace(
        "<p:nvPr/>",
        '<p:nvPr><p:ph idx="1"/></p:nvPr>'
      ),
    },
    {
      label: "inherited footer",
      layout: empty(8, { ph: '<p:ph type="ftr" idx="1"/>' }),
    },
  ])(
    "preserves $label instead of assuming that blank local text means no content",
    async (options) => {
      const source = await deck(options);
      expect(
        candidate(await inspectPptx(source)).emptyPlaceholder
      ).toBeUndefined();
      expect(
        (await applyPptxRepairs(source, removal(), { revisioned: true })).buffer
      ).toEqual(source);
    }
  );

  it.each([
    {
      label: "animation",
      timing:
        '<p:timing><p:tnLst><p:par><p:cTn id="1"/></p:par></p:tnLst></p:timing>',
    },
    {
      label: "connector",
      content: `${empty()}<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="9" name="Connector"/><p:cNvCxnSpPr><a:stCxn id="3" idx="0"/></p:cNvCxnSpPr><p:nvPr/></p:nvCxnSpPr><p:spPr/></p:cxnSp>`,
    },
    {
      label: "opaque reference",
      timing:
        '<p:extLst><p:ext uri="urn:custom"><custom:reference xmlns:custom="urn:custom" target="3"/></p:ext></p:extLst>',
    },
    {
      label: "comment reference",
      relationships: `<Relationship Id="rComment" Type="${R}/comments" Target="../comments/comment1.xml"/>`,
      extraParts: [
        ["ppt/comments/comment1.xml", `<p:cmLst xmlns:p="${P}"/>`] as [
          string,
          string,
        ],
      ],
    },
    {
      label: "creation-ID reference",
      content: empty(3, { metadata: CREATION }),
      extraParts: [
        [
          "customXml/item1.xml",
          '<custom:reference xmlns:custom="urn:custom" target="{E6B77F2C-9EC6-6540-84E0-C273D0DDD337}"/>',
        ] as [string, string],
      ],
    },
  ])("preserves a placeholder protected by $label", async (options) => {
    const source = await deck(options);
    expect(
      candidate(await inspectPptx(source)).emptyPlaceholder
    ).toBeUndefined();
    expect(
      (await applyPptxRepairs(source, removal(), { revisioned: true })).buffer
    ).toEqual(source);
  });

  it("accepts blank text formatting and explicit no-fill/no-line without deleting authored values elsewhere", async () => {
    const source = await deck({
      content: empty(3, {
        shape: "<a:noFill/><a:ln><a:noFill/></a:ln><a:effectLst/>",
        body: '<a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr sz="2200"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:rPr><a:t>  </a:t></a:r></a:p>',
      }),
    });
    expect(candidate(await inspectPptx(source)).emptyPlaceholder).toBe(true);
    expect(
      (await applyPptxRepairs(source, removal(), { revisioned: true })).changes
    ).toHaveLength(1);
  });

  it("rejects duplicate/non-ID deletion lists and conflicting edits on an object being removed", () => {
    expect(validatePptxRepairPlan(removal())).toBe(true);
    for (const ids of [["3", "3"], ["oops"], [3]])
      expect(
        validatePptxRepairPlan({
          slides: [{ slideNumber: 1, removeEmptyPlaceholders: ids }],
        })
      ).toBe(false);
    expect(
      validatePptxRepairPlan({
        slides: [
          {
            ...removal().slides[0],
            descriptions: [{ objectId: "3", text: "Keep this." }],
          },
        ],
      })
    ).toBe(false);
    expect(
      validatePptxRepairPlan({
        slides: [{ ...removal().slides[0], titleObjectId: "3" }],
      })
    ).toBe(false);
  });
});
