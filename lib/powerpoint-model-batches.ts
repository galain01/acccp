import { PDFDocument } from "pdf-lib";
import { MAX_PPTX_PREVIEW_PDF_SIZE_BYTES } from "./document-input";
import {
  PDF_RENDERING_LIMITS,
  PdfRenderingError,
  type RenderedPdf,
} from "./pdf-rendering";
import type { PptxInspection, PptxObject } from "./pptx-types";

type PowerPointContextObject = Pick<
  PptxObject,
  | "id"
  | "kind"
  | "isTitle"
  | "hidden"
  | "grouped"
  | "parentId"
  | "text"
  | "description"
  | "title"
  | "decorative"
  | "actions"
  | "table"
  | "diagramText"
>;

export interface PowerPointDeckContext {
  slideCount: number;
  slides: {
    slideNumber: number;
    hidden: boolean;
    objects: PowerPointContextObject[];
  }[];
}

/**
 * Keep exact teaching content across batches without repeating every text run,
 * rectangle and package detail. Assigned slides still receive their complete
 * inventories; this context is not sufficient for planning or checking edits.
 */
export function compactPowerPointContext(
  inspection: PptxInspection
): PowerPointDeckContext {
  return {
    slideCount: inspection.slideCount,
    slides: inspection.slides.map((slide) => ({
      slideNumber: slide.slideNumber,
      hidden: slide.hidden,
      objects: slide.objects
        .filter(
          (object) =>
            object.text.trim() ||
            object.description.trim() ||
            object.title.trim() ||
            object.actions?.length ||
            object.table ||
            object.diagramText?.some((text) => text.trim())
        )
        .map((object) => ({
          id: object.id,
          kind: object.kind,
          isTitle: object.isTitle,
          hidden: object.hidden,
          grouped: object.grouped,
          parentId: object.parentId,
          text: object.text,
          description: object.description,
          title: object.title,
          decorative: object.decorative,
          ...(object.actions?.length
            ? { actions: object.actions.map((action) => ({ ...action })) }
            : {}),
          ...(object.table
            ? {
                table: {
                  ...object.table,
                  cells: object.table.cells.map((row) => [...row]),
                },
              }
            : {}),
          ...(object.diagramText?.length
            ? { diagramText: [...object.diagramText] }
            : {}),
        })),
    })),
  };
}

// Eight slides bound the amount of repair JSON generated per request. The
// preview PDF, output PNGs, originals and reference-only companions also stay
// below the gateway's 50-image request limit without reducing image quality.
export const POWERPOINT_MODEL_BATCH_SIZE = 8;

export interface PowerPointModelBatch {
  /** Original slide numbers, including hidden slides and appended slides. */
  slideNumbers: number[];
  /** Only the PDF pages for this batch; source PowerPoint bytes are untouched. */
  pdf: Buffer;
  /** Full deck count with a subset of globally numbered, unchanged images. */
  images: RenderedPdf;
}

/**
 * Split an already rendered, bounded PowerPoint preview for model requests.
 * This is not an input parser: callers must run the PDF renderer's safety
 * checks first. The PNG buffers and their dimensions are never recompressed.
 */
export async function createPowerPointModelBatches(
  pdf: Buffer,
  rendered: RenderedPdf
): Promise<PowerPointModelBatch[]> {
  if (!Buffer.isBuffer(pdf) || pdf.length === 0) {
    throw new PdfRenderingError({
      version: 1,
      stage: "pptx_prepare",
      code: "pdf_invalid",
    });
  }
  if (pdf.length > MAX_PPTX_PREVIEW_PDF_SIZE_BYTES) {
    throw new PdfRenderingError({
      version: 1,
      stage: "pptx_prepare",
      code: "pdf_output_limit",
    });
  }
  if (
    !Number.isInteger(rendered.pageCount) ||
    rendered.pageCount < 1 ||
    rendered.pageCount > PDF_RENDERING_LIMITS.maxPages
  ) {
    throw new PdfRenderingError({
      version: 1,
      stage: "pptx_prepare",
      code: "pdf_page_limit",
    });
  }
  if (
    !Array.isArray(rendered.pages) ||
    rendered.pages.length !== rendered.pageCount ||
    Array.from({ length: rendered.pageCount }).some((_, index) => {
      const page = rendered.pages[index];
      return (
        !page ||
        page.pageNumber !== index + 1 ||
        !Number.isInteger(page.width) ||
        !Number.isInteger(page.height) ||
        page.width < 1 ||
        page.height < 1 ||
        page.width > PDF_RENDERING_LIMITS.maxPageDimension ||
        page.height > PDF_RENDERING_LIMITS.maxPageDimension ||
        page.width * page.height > PDF_RENDERING_LIMITS.maxPagePixels ||
        !Buffer.isBuffer(page.png) ||
        page.png.length === 0 ||
        page.png.length > PDF_RENDERING_LIMITS.maxPngBytes
      );
    })
  ) {
    throw new PdfRenderingError({
      version: 1,
      stage: "pptx_prepare",
      code: "pdf_protocol_error",
    });
  }

  try {
    const source = await PDFDocument.load(pdf, {
      updateMetadata: false,
      throwOnInvalidObject: true,
    });
    if (source.getPageCount() !== rendered.pageCount) {
      throw new PdfRenderingError({
        version: 1,
        stage: "pptx_prepare",
        code: "pdf_protocol_error",
      });
    }

    const batches: PowerPointModelBatch[] = [];
    for (
      let start = 0;
      start < rendered.pageCount;
      start += POWERPOINT_MODEL_BATCH_SIZE
    ) {
      const pages = rendered.pages.slice(
        start,
        start + POWERPOINT_MODEL_BATCH_SIZE
      );
      let batchPdf = pdf;
      if (rendered.pageCount > POWERPOINT_MODEL_BATCH_SIZE) {
        const subset = await PDFDocument.create({ updateMetadata: false });
        const copied = await subset.copyPages(
          source,
          pages.map((page) => page.pageNumber - 1)
        );
        for (const page of copied) subset.addPage(page);
        batchPdf = Buffer.from(
          await subset.save({
            addDefaultPage: false,
            updateFieldAppearances: false,
          })
        );
        if (batchPdf.length > MAX_PPTX_PREVIEW_PDF_SIZE_BYTES) {
          throw new PdfRenderingError({
            version: 1,
            stage: "pptx_prepare",
            code: "pdf_output_limit",
          });
        }
      }
      batches.push({
        slideNumbers: pages.map((page) => page.pageNumber),
        pdf: batchPdf,
        images: { pageCount: rendered.pageCount, pages },
      });
    }
    return batches;
  } catch (error) {
    if (error instanceof PdfRenderingError) throw error;
    // Do not expose parser messages, which can contain document data.
    throw new PdfRenderingError({
      version: 1,
      stage: "pptx_prepare",
      code: "pdf_invalid",
    });
  }
}
