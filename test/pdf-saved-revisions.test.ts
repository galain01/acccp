import { createCanvas, loadImage } from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";
import { renderPdfPages, type RenderedPdfPage } from "../lib/pdf-rendering";
import {
  appendObjectStreamRevision,
  appendRevision,
  initialPdf,
  pdfStream,
  type PdfObject,
} from "./helpers/incremental-pdf";

const catalog =
  "<< /Type /Catalog /Pages 2 0 R /StructTreeRoot 7 0 R /MarkInfo << /Marked true >> /Metadata 11 0 R /Lang (en-US) >>";
const resources = "<< /Font << /F1 4 0 R >> /XObject << /Im0 6 0 R >> >>";
const figure = (alt: string) =>
  `<< /Type /StructElem /S /Figure /P 8 0 R /Pg 3 0 R /K 0 /Alt (${alt}) >>`;
const content = (text: string) =>
  pdfStream(
    `BT /F1 12 Tf 20 160 Td (${text}) Tj ET\n/Figure << /MCID 0 >> BDC\nq 60 0 0 40 20 60 cm /Im0 Do Q\nEMC`
  );
const image = (
  width: string | number,
  height: string | number,
  color: number[] = [220, 30, 10],
  extra = ""
) =>
  pdfStream(
    Buffer.from(color),
    `/Type /XObject /Subtype /Image /Width ${width} /Height ${height} /BitsPerComponent 8 /ColorSpace /DeviceRGB ${extra}`
  );

function source(extra: PdfObject[] = []) {
  return initialPdf([
    { id: 1, body: catalog },
    { id: 2, body: "<< /Type /Pages /Count 1 /Kids [3 0 R] >>" },
    {
      id: 3,
      body: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources 15 0 R /Contents 5 0 R /StructParents 0 >>",
    },
    { id: 4, body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>" },
    { id: 5, body: content("Original revision") },
    { id: 6, body: image("12 0 R", "13 0 R") },
    {
      id: 7,
      body: "<< /Type /StructTreeRoot /K 8 0 R /ParentTree 10 0 R /ParentTreeNextKey 1 >>",
    },
    { id: 8, body: "<< /Type /StructElem /S /Document /P 7 0 R /K [9 0 R] >>" },
    { id: 9, body: figure("Original red image description.") },
    { id: 10, body: "<< /Nums [0 [9 0 R]] >>" },
    {
      id: 11,
      body: pdfStream(
        "<metadata>Original metadata</metadata>",
        "/Type /Metadata /Subtype /XML"
      ),
    },
    { id: 12, body: "1" },
    { id: 13, body: "1" },
    { id: 14, body: image(1, 1, [255, 255, 255]) },
    { id: 15, body: resources },
    ...extra,
  ]);
}

async function sampleImageColor(page: RenderedPdfPage) {
  const canvas = createCanvas(page.width, page.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(await loadImage(page.png), 0, 0);
  return [...ctx.getImageData(100, 240, 1, 1).data];
}

describe("saved PDF revisions through the real renderer child", () => {
  it("accepts catalog and metadata saved updates without changing the page", async () => {
    const original = source();
    const updated = appendRevision(original, [
      { id: 1, body: catalog.replace("(en-US)", "(en-GB)") },
      {
        id: 11,
        body: pdfStream(
          "<metadata>Updated metadata</metadata>",
          "/Type /Metadata /Subtype /XML"
        ),
      },
    ]);
    const before = await renderPdfPages(original.bytes);
    const after = await renderPdfPages(updated.bytes);
    expect(after.pageCount).toBe(1);
    expect(after.pages[0].text).toBe(before.pages[0].text);
    expect(after.pages[0].png).toEqual(before.pages[0].png);
    expect(after.pages[0].imageAlternatives).toEqual(
      before.pages[0].imageAlternatives
    );
  }, 15_000);

  it("uses current visible text, colored image, and authored description across multiple saves", async () => {
    const intermediate = appendRevision(source(), [
      { id: 5, body: content("Intermediate revision") },
      { id: 9, body: figure("Intermediate image description.") },
    ]);
    const latest = appendRevision(intermediate, [
      { id: 5, body: content("Current revision") },
      { id: 6, body: image(1, 1, [20, 80, 220]) },
      { id: 9, body: figure("Current blue image description.") },
    ]);
    const {
      pages: [page],
    } = await renderPdfPages(latest.bytes);
    expect(page.text).toContain("Current revision");
    expect(page.text).not.toMatch(/Original|Intermediate/);
    expect(await sampleImageColor(page)).toEqual([20, 80, 220, 255]);
    expect(page.imageAlternatives.status).toBe("complete");
    expect(page.imageAlternatives.figures.map(({ alt }) => alt)).toEqual([
      "Current blue image description.",
    ]);
  }, 15_000);

  it("resolves updated compressed objects from a new xref stream", async () => {
    const revised = appendObjectStreamRevision(
      source(),
      [
        { id: 1, body: catalog },
        { id: 9, body: figure("Compressed current description.") },
      ],
      [
        { id: 5, body: content("Compressed revision") },
        { id: 6, body: image(1, 1, [20, 80, 220]) },
      ]
    );
    const {
      pages: [page],
    } = await renderPdfPages(revised.bytes);
    expect(page.text).toContain("Compressed revision");
    expect(await sampleImageColor(page)).toEqual([20, 80, 220, 255]);
    expect(page.imageAlternatives.figures.map(({ alt }) => alt)).toEqual([
      "Compressed current description.",
    ]);
  }, 15_000);

  it("does not resurrect a freed image from an older revision", async () => {
    const original = source([{ id: 16, body: image(5000, 5000) }]);
    const revised = appendRevision(
      original,
      [{ id: 1, body: catalog }],
      new Map([[16, null]])
    );
    const result = await renderPdfPages(revised.bytes);
    expect(result.pageCount).toBe(1);
    expect(await sampleImageColor(result.pages[0])).toEqual([220, 30, 10, 255]);
  }, 15_000);

  it("rejects an active oversized image even if a later unselected physical definition is small", async () => {
    const original = source([{ id: 16, body: image(5000, 5000) }]);
    const revised = appendRevision(
      original,
      [{ id: 16, body: image(1, 1) }],
      new Map([[16, original.offsets.get(16)!]])
    );
    await expect(renderPdfPages(revised.bytes)).rejects.toMatchObject({
      diagnostic: { code: "pdf_image_limit" },
    });
  }, 15_000);

  it("checks current indirect image dimensions instead of their old values", async () => {
    const revised = appendRevision(source(), [
      { id: 12, body: "5000" },
      { id: 13, body: "5000" },
    ]);
    await expect(renderPdfPages(revised.bytes)).rejects.toMatchObject({
      diagnostic: { code: "pdf_image_limit" },
    });
  }, 15_000);

  it("checks current masks selected through a replaced image dictionary", async () => {
    const revised = appendRevision(source(), [
      // Each stream is only 5 MP; the combined base/mask axes expand to 25 MP.
      { id: 6, body: image(5000, 1000, [220, 30, 10], "/SMask 14 0 R") },
      { id: 14, body: image(1000, 5000, [0]) },
    ]);
    await expect(renderPdfPages(revised.bytes)).rejects.toMatchObject({
      diagnostic: { code: "pdf_image_limit" },
    });
  }, 15_000);

  it("checks the current page resource graph against the aggregate page budget", async () => {
    const original = source([
      { id: 16, body: image(4000, 5000) },
      { id: 17, body: image(4000, 5000) },
    ]);
    const revised = appendRevision(original, [
      {
        id: 15,
        body: "<< /Font << /F1 4 0 R >> /XObject << /Im0 6 0 R /Large1 16 0 R /Large2 17 0 R >> >>",
      },
    ]);
    await expect(renderPdfPages(revised.bytes)).rejects.toMatchObject({
      diagnostic: { code: "pdf_image_limit", pageNumber: 1 },
    });
  }, 15_000);
});
