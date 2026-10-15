import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PDFArray,
  PDFDocument,
  PDFRawStream,
  StandardFonts,
  decodePDFRawStream,
  degrees,
  rgb,
  type PDFPage,
} from "pdf-lib";
import { MAX_PPTX_PREVIEW_PDF_SIZE_BYTES } from "../lib/document-input";
import {
  POWERPOINT_MODEL_BATCH_SIZE,
  compactPowerPointContext,
  createPowerPointModelBatches,
} from "../lib/powerpoint-model-batches";
import { type RenderedPdf } from "../lib/pdf-rendering";
import type { PptxInspection, PptxObject } from "../lib/pptx-types";

afterEach(() => vi.restoreAllMocks());

function contextObject(overrides: Partial<PptxObject> = {}): PptxObject {
  return {
    id: "2",
    name: "Package object name",
    kind: "text",
    isTitle: false,
    hidden: false,
    grouped: false,
    parentId: null,
    text: "",
    description: "",
    title: "",
    decorative: false,
    language: "en-US",
    rect: { x: 0, y: 0, width: 200, height: 100 },
    textRuns: [
      { text: "Duplicated run data", language: "en-US", fontSizePt: 24 },
    ],
    ...overrides,
  };
}

function contextInspection(objects: PptxObject[]): PptxInspection {
  return {
    slideCount: 2,
    width: 500,
    height: 300,
    findings: [
      {
        code: "manual-review",
        severity: "warning",
        slideNumber: 1,
        message: "Check",
        suggestion: "Check",
      },
    ],
    slides: [
      {
        slideNumber: 1,
        hidden: false,
        partName: "ppt/slides/slide1.xml",
        hasTiming: true,
        hasExternalContent: true,
        objects,
      },
      {
        slideNumber: 2,
        hidden: true,
        partName: "ppt/slides/slide2.xml",
        hasTiming: false,
        hasExternalContent: false,
        objects: [],
      },
    ],
  };
}

describe("compact PowerPoint context", () => {
  it("preserves exact text, descriptions, titles and global slide context without run/package detail", () => {
    const object = contextObject({
      text: `  Teaching content\n\n${"Exact words. ".repeat(600)}\nCafé — 15%  `,
      description: "  Authored image description\nwith a qualification.  ",
      title: "Original authored alternative title",
      isTitle: true,
      hidden: true,
      grouped: true,
      parentId: "7",
      decorative: true,
    });
    const source = contextInspection([object]);
    const before = JSON.stringify(source);
    expect(compactPowerPointContext(source)).toEqual({
      slideCount: 2,
      slides: [
        {
          slideNumber: 1,
          hidden: false,
          objects: [
            {
              id: "2",
              kind: "text",
              isTitle: true,
              hidden: true,
              grouped: true,
              parentId: "7",
              decorative: true,
              text: object.text,
              description: object.description,
              title: object.title,
            },
          ],
        },
        { slideNumber: 2, hidden: true, objects: [] },
      ],
    });
    expect(JSON.stringify(source)).toBe(before);
  });

  it("keeps actions, table labels/data and native diagram text even without ordinary text", () => {
    const actions: NonNullable<PptxObject["actions"]> = [
      {
        trigger: "click",
        relationshipId: "rId12",
        target: "https://example.test/lesson",
        targetKind: "external",
        action: "ppaction://hlinkshowjump?jump=nextslide",
      },
      {
        trigger: "hover",
        relationshipId: "rId13",
        target: "../slides/slide2.xml",
        targetKind: "internal",
      },
    ];
    const table: NonNullable<PptxObject["table"]> = {
      rows: 2,
      columns: 2,
      firstRow: true,
      firstColumn: false,
      complex: false,
      cells: [
        ["Category", "Proportion"],
        ["Original label", "15.0%"],
      ],
    };
    const diagramText = ["Start", "", "Decision: score < 5", " Branch A "];
    const source = contextInspection([
      contextObject({ id: "3", kind: "image", actions }),
      contextObject({ id: "4", kind: "table", table }),
      contextObject({ id: "5", kind: "smartart", diagramText }),
    ]);
    const compact = compactPowerPointContext(source);
    expect(compact.slides[0].objects.map((object) => object.id)).toEqual([
      "3",
      "4",
      "5",
    ]);
    expect(compact.slides[0].objects[0].actions).toEqual(actions);
    expect(compact.slides[0].objects[1].table).toEqual(table);
    expect(compact.slides[0].objects[2].diagramText).toEqual(diagramText);
    // The context is its own data value; callers cannot alter inspection facts.
    compact.slides[0].objects[0].actions![0].target = "changed";
    compact.slides[0].objects[1].table!.cells[0][0] = "changed";
    compact.slides[0].objects[2].diagramText![0] = "changed";
    expect(actions[0].target).toBe("https://example.test/lesson");
    expect(table.cells[0][0]).toBe("Category");
    expect(diagramText[0]).toBe("Start");
  });

  it("omits empty context objects without dropping descriptions, titles or hidden meaningful objects", () => {
    const source = contextInspection([
      contextObject({ id: "1", text: " \n\t ", actions: [], diagramText: [] }),
      contextObject({
        id: "2",
        kind: "image",
        description: "Description only",
      }),
      contextObject({ id: "3", title: "Title only" }),
      contextObject({ id: "4", hidden: true, text: "Hidden teaching content" }),
      contextObject({ id: "5", kind: "group", diagramText: ["", " "] }),
    ]);
    const compact = compactPowerPointContext(source);
    expect(compact.slides[0].objects.map((object) => object.id)).toEqual([
      "2",
      "3",
      "4",
    ]);
    expect(source.slides[0].objects).toHaveLength(5);
    expect(compact.slides).toHaveLength(2);
    expect(compact.slides[1]).toEqual({
      slideNumber: 2,
      hidden: true,
      objects: [],
    });
    for (const object of compact.slides[0].objects) {
      for (const key of [
        "name",
        "language",
        "rect",
        "textRuns",
        "emptyPlaceholder",
      ]) {
        expect(object).not.toHaveProperty(key);
      }
    }
    expect(compact).not.toHaveProperty("findings");
  });
});

async function makePreview(pageCount: number) {
  const document = await PDFDocument.create({ updateMetadata: false });
  const font = await document.embedFont(StandardFonts.Helvetica);
  const rendered: RenderedPdf = { pageCount, pages: [] };
  for (let index = 0; index < pageCount; index++) {
    const pageNumber = index + 1;
    const width = 300 + pageNumber;
    const height = 200 + pageNumber;
    const page = document.addPage([width, height]);
    page.setRotation(degrees(index % 2 ? 90 : 0));
    page.drawRectangle({
      x: pageNumber,
      y: pageNumber,
      width: 100,
      height: 60,
      color: rgb(pageNumber / 61, 0.5, 1 - pageNumber / 61),
    });
    page.drawText(`Slide ${pageNumber}`, { x: 10, y: 150, font, size: 15 });
    rendered.pages.push({
      pageNumber,
      width,
      height,
      // Sentinels distinguish rendered evidence without a second rasterization.
      png: Buffer.from(`original pixels for slide ${pageNumber}`),
      text: `Slide ${pageNumber}`,
      imageAlternatives: { status: "complete", figures: [] },
    });
  }
  const pdf = Buffer.from(await document.save({ addDefaultPage: false }));
  return { pdf, rendered };
}

function pageContents(page: PDFPage): string[] {
  const contents = page.node.Contents();
  const streams =
    contents instanceof PDFArray ? contents.asArray() : [contents];
  return streams.map((reference) => {
    const stream = page.doc.context.lookup(reference);
    if (!(stream instanceof PDFRawStream))
      throw new Error("Missing fixture content");
    return Buffer.from(decodePDFRawStream(stream).decode()).toString("utf8");
  });
}

describe("PowerPoint model preview batches", () => {
  it.each([1, 8, 9, 59, 60])(
    "keeps all %i slides in order with unchanged PDF drawing instructions and image evidence",
    async (pageCount) => {
      const { pdf, rendered } = await makePreview(pageCount);
      const originalPdf = Buffer.from(pdf);
      const source = await PDFDocument.load(pdf);
      const batches = await createPowerPointModelBatches(pdf, rendered);

      expect(batches).toHaveLength(
        Math.ceil(pageCount / POWERPOINT_MODEL_BATCH_SIZE)
      );
      expect(batches.flatMap((batch) => batch.slideNumbers)).toEqual(
        Array.from({ length: pageCount }, (_, index) => index + 1)
      );
      for (const batch of batches) {
        const subset = await PDFDocument.load(batch.pdf);
        expect(subset.getPageCount()).toBe(batch.slideNumbers.length);
        expect(batch.slideNumbers.length).toBeLessThanOrEqual(8);
        expect(batch.images.pageCount).toBe(pageCount);
        expect(batch.images.pages).toHaveLength(batch.slideNumbers.length);
        for (const [index, slideNumber] of batch.slideNumbers.entries()) {
          const originalPage = source.getPage(slideNumber - 1);
          const copiedPage = subset.getPage(index);
          expect(pageContents(copiedPage)).toEqual(pageContents(originalPage));
          expect(copiedPage.getSize()).toEqual(originalPage.getSize());
          expect(copiedPage.getRotation()).toEqual(originalPage.getRotation());
          expect(batch.images.pages[index]).toBe(
            rendered.pages[slideNumber - 1]
          );
          expect(batch.images.pages[index].png).toBe(
            rendered.pages[slideNumber - 1].png
          );
          expect(batch.images.pages[index].pageNumber).toBe(slideNumber);
        }
      }
      expect(pdf.equals(originalPdf)).toBe(true);
      if (pageCount <= 8) expect(batches[0].pdf).toBe(pdf);
      else expect(batches.every((batch) => batch.pdf !== pdf)).toBe(true);
    }
  );

  it.each([
    [8, [8]],
    [9, [8, 1]],
    [59, [8, 8, 8, 8, 8, 8, 8, 3]],
    [60, [8, 8, 8, 8, 8, 8, 8, 4]],
  ])(
    "splits %i slides into the expected bounded requests",
    async (count, sizes) => {
      const { pdf, rendered } = await makePreview(count as number);
      const batches = await createPowerPointModelBatches(pdf, rendered);
      expect(batches.map((batch) => batch.images.pages.length)).toEqual(sizes);
      // Worst-case audit: the attached PDF plus both output and original PNGs.
      expect(
        batches.every((batch) => batch.slideNumbers.length * 3 <= 50)
      ).toBe(true);
    }
  );

  it.each(["missing", "duplicate", "reordered", "out of range", "sparse"])(
    "rejects %s rendered slide coverage",
    async (problem) => {
      const { pdf, rendered } = await makePreview(17);
      if (problem === "missing") rendered.pages.pop();
      if (problem === "duplicate") rendered.pages[1].pageNumber = 1;
      if (problem === "reordered") rendered.pages.reverse();
      if (problem === "out of range") rendered.pages[16].pageNumber = 18;
      if (problem === "sparse") delete rendered.pages[10];
      await expect(
        createPowerPointModelBatches(pdf, rendered)
      ).rejects.toMatchObject({
        diagnostic: { code: "pdf_protocol_error" },
      });
    }
  );

  it("rejects a valid PDF whose actual page count differs from the rendered coverage", async () => {
    const { pdf } = await makePreview(17);
    const { rendered } = await makePreview(16);
    await expect(
      createPowerPointModelBatches(pdf, rendered)
    ).rejects.toMatchObject({
      diagnostic: { code: "pdf_protocol_error" },
    });
  });

  it.each([0, 61, 1.5, Number.NaN])(
    "rejects invalid slide count %s",
    async (pageCount) => {
      const { pdf, rendered } = await makePreview(1);
      rendered.pageCount = pageCount;
      await expect(
        createPowerPointModelBatches(pdf, rendered)
      ).rejects.toMatchObject({
        diagnostic: { code: "pdf_page_limit" },
      });
    }
  );

  it.each(["missing PNG", "invalid width", "oversize canvas"])(
    "rejects invalid image evidence: %s",
    async (problem) => {
      const { pdf, rendered } = await makePreview(1);
      if (problem === "missing PNG") rendered.pages[0].png = Buffer.alloc(0);
      if (problem === "invalid width") rendered.pages[0].width = Number.NaN;
      if (problem === "oversize canvas") rendered.pages[0].width = 10_000;
      await expect(
        createPowerPointModelBatches(pdf, rendered)
      ).rejects.toMatchObject({
        diagnostic: { code: "pdf_protocol_error" },
      });
    }
  );

  it("bounds input bytes before attempting PDF parsing", async () => {
    const { rendered } = await makePreview(1);
    const load = vi.spyOn(PDFDocument, "load");
    await expect(
      createPowerPointModelBatches(
        Buffer.alloc(MAX_PPTX_PREVIEW_PDF_SIZE_BYTES + 1),
        rendered
      )
    ).rejects.toMatchObject({ diagnostic: { code: "pdf_output_limit" } });
    expect(load).not.toHaveBeenCalled();
  });

  it("bounds every generated subset PDF", async () => {
    const { pdf, rendered } = await makePreview(17);
    vi.spyOn(PDFDocument.prototype, "save").mockResolvedValueOnce(
      new Uint8Array(MAX_PPTX_PREVIEW_PDF_SIZE_BYTES + 1)
    );
    await expect(
      createPowerPointModelBatches(pdf, rendered)
    ).rejects.toMatchObject({
      diagnostic: { code: "pdf_output_limit" },
    });
  });

  it("returns a controlled error without parser or source text", async () => {
    const { rendered } = await makePreview(1);
    await expect(
      createPowerPointModelBatches(
        Buffer.from("private document content"),
        rendered
      )
    ).rejects.toMatchObject({
      name: "PdfRenderingError",
      diagnostic: { code: "pdf_invalid" },
    });
    const { pdf } = await makePreview(1);
    vi.spyOn(PDFDocument, "load").mockRejectedValueOnce(
      new Error("private document content")
    );
    try {
      await createPowerPointModelBatches(pdf, rendered);
      throw new Error("Expected rejection");
    } catch (error) {
      expect(error).toMatchObject({ name: "PdfRenderingError" });
      expect(String(error)).not.toContain("private document content");
    }
  });
});
